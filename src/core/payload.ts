import type { Batch, ChangedFile, PriorFinding, ReviewDepth, ReviewThread } from "../types.ts";
import { fileDiff } from "./git.ts";
import { guidanceForPath, type GuidanceRef } from "./guidance.ts";
import { stripMarkers } from "./priorFindings.ts";

/** Characters of a review-only guidance file inlined into a payload. */
const INLINE_REVIEW_GUIDANCE_CAP = 3000;

/**
 * Rewrites a unified diff so every line carries its real line number in the
 * post-change file.
 *
 * This is the single highest-value transformation in the toolkit. Reviewers
 * reading a raw diff have to count lines from the hunk header to name a
 * location, and miscounting is the most common reason an otherwise correct
 * finding lands on the wrong line. Numbering the lines up front removes the
 * arithmetic entirely: the number beside the code is the number to report.
 *
 * Added and context lines show the new-file number; removed lines show a dash
 * because they no longer exist in the reviewed revision and can never be a
 * valid comment anchor.
 */
export function annotateDiff(diff: string): string {
  const out: string[] = [];
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = match ? Number.parseInt(match[1], 10) : 0;
      inHunk = true;
      out.push(`      ${line}`);
      continue;
    }
    if (!inHunk) {
      // File headers (diff --git, index, ---, +++) carry no reviewable content.
      continue;
    }
    if (line.startsWith("+")) {
      out.push(`${String(newLine).padStart(5, " ")}+${line.slice(1)}`);
      newLine++;
    } else if (line.startsWith("-")) {
      out.push(`    -|${line.slice(1)}`);
    } else if (line.startsWith("\\")) {
      out.push(`     |${line}`);
    } else {
      out.push(`${String(newLine).padStart(5, " ")} ${line.slice(1)}`);
      newLine++;
    }
  }
  return out.join("\n");
}

function excerpt(body: string, limit: number): string {
  const flat = stripMarkers(body).replace(/\s+/g, " ");
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Summarizes existing threads on one file, replies included.
 *
 * The first comment says what was claimed; the replies say whether the author
 * agreed, disagreed or fixed it. Showing only the first comment would make a
 * re-review repeat a point the author already answered.
 */
function threadSummary(threads: ReviewThread[], path: string, prior: PriorFinding[]): string {
  const relevant = threads.filter((t) => t.path === path && !t.isDeleted && t.comments.length > 0);
  if (relevant.length === 0) return "";
  const priorById = new Map(prior.map((p) => [p.threadId, p]));
  const lines: string[] = [];
  for (const t of relevant) {
    const first = t.comments[0];
    const who = t.isBot ? `${first.author} (bot)` : first.author;
    const mine = priorById.get(t.id);
    const tag = mine
      ? ` [prr finding ${mine.findingId}; evidence ${
          mine.evidenceStillPresent === null
            ? "unknown"
            : mine.evidenceStillPresent
              ? "still present"
              : "no longer present"
        }]`
      : "";
    lines.push(`- thread ${t.id} [${t.status}]${tag} line ${t.line ?? "?"} — ${who}: ${excerpt(first.body, 220)}`);
    const replies = t.comments.slice(1).filter((c) => c.type !== "system");
    const shown = replies.slice(-3);
    if (replies.length > shown.length) lines.push(`    ↳ (${replies.length - shown.length} earlier repl(ies) omitted)`);
    for (const reply of shown) lines.push(`    ↳ ${reply.author}: ${excerpt(reply.body, 160)}`);
  }
  return `\nExisting threads on this file (do not repeat these findings; read the replies):\n${lines.join("\n")}\n`;
}

export interface PayloadContext {
  repoRoot: string;
  baseSHA: string;
  sourceSHA: string;
  files: Map<string, ChangedFile>;
  threads: ReviewThread[];
  depth?: ReviewDepth;
  /** Excerpt of the stated intent, repeated in every batch. */
  intent?: string;
  /** Guidance files selected for the whole change, with their text. */
  guidance?: { refs: GuidanceRef[]; contents: Map<string, string> };
  /** Threads posted by earlier prr runs. */
  priorFindings?: PriorFinding[];
}

function guidanceSection(batch: Batch, ctx: PayloadContext): string[] {
  if (!ctx.guidance || ctx.guidance.refs.length === 0) return [];
  const applicable = new Map<string, GuidanceRef>();
  for (const path of batch.files) {
    for (const ref of guidanceForPath(path, ctx.guidance.refs)) applicable.set(ref.path, ref);
  }
  if (applicable.size === 0) return [];
  const out = ["## Repository guidance for these files", ""];
  const project = [...applicable.values()].filter((ref) => ref.kind === "project");
  if (project.length > 0) {
    out.push(
      `Project guidance (base revision, full text in guidance.md): ${project.map((r) => r.path).join(", ")}. ` +
        "A change that violates a rule stated there is a finding.",
      "",
    );
  }
  for (const ref of [...applicable.values()].filter((r) => r.kind === "review")) {
    const text = (ctx.guidance.contents.get(ref.path) ?? "").trim();
    if (!text) continue;
    out.push(`Review instructions from ${ref.path}:`, "");
    out.push(
      text.length > INLINE_REVIEW_GUIDANCE_CAP
        ? `${text.slice(0, INLINE_REVIEW_GUIDANCE_CAP)}\n…[truncated; full text in guidance.md]`
        : text,
    );
    out.push("");
  }
  return out;
}

/**
 * Renders one batch into a self-contained review document.
 *
 * Everything needed to review the batch is here: the annotated diffs, the
 * per-file metadata, and the existing threads that would make a finding a
 * duplicate. The reviewer should not need another read to produce candidate
 * findings.
 */
export async function renderPayload(batch: Batch, ctx: PayloadContext): Promise<string> {
  const parts: string[] = [];
  parts.push(`# Review batch ${batch.id} — ${batch.label}`);
  parts.push("");
  parts.push(
    `Files: ${batch.files.length} · estimated tokens: ${batch.estTokens} · ` +
      `risk: ${batch.risk} · plan first: ${batch.needsPlan ? "yes" : "no"}`,
  );
  parts.push(`Source revision: ${ctx.sourceSHA}`);
  parts.push(`Base revision: ${ctx.baseSHA}`);
  if (ctx.depth) parts.push(`Review depth: ${ctx.depth}`);
  parts.push("");
  parts.push(
    "Line numbers on the left are real line numbers in the source revision. " +
      "Report them as-is; lines marked `-|` were removed and cannot be commented on.",
  );
  parts.push("");
  if (ctx.intent) {
    parts.push("## Stated intent", "");
    parts.push(
      "Check each change against this: does it do what was asked, completely, without doing " +
        "something else?",
      "",
    );
    parts.push(ctx.intent, "");
  }
  parts.push(...guidanceSection(batch, ctx));
  for (const path of batch.files) {
    const meta = ctx.files.get(path);
    const raw = await fileDiff(ctx.repoRoot, ctx.baseSHA, ctx.sourceSHA, path);
    parts.push(
      `<file path="${path}" status="${meta?.status ?? "edit"}" category="${
        meta?.category ?? "unknown"
      }" adds="${meta?.adds ?? 0}" dels="${meta?.dels ?? 0}" risk="${meta?.risk ?? 0}">`,
    );
    if (meta?.rules && meta.rules.length > 0) {
      parts.push("");
      parts.push("Project rules for this path:");
      parts.push(...meta.rules.map((rule) => `- ${rule}`));
    }
    if (meta?.minSeverity) {
      parts.push("");
      parts.push(
        `Reporting threshold for this path: ${meta.minSeverity} and above. Lower findings are ` +
          "suppressed at finalize; record them only if they might be more severe than they look.",
      );
    }
    const threadNote = threadSummary(ctx.threads, path, ctx.priorFindings ?? []);
    if (threadNote) parts.push(threadNote.trimEnd());
    parts.push("```diff");
    parts.push(annotateDiff(raw));
    parts.push("```");
    parts.push("</file>");
    parts.push("");
  }

  return parts.join("\n");
}
