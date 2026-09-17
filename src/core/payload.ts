import type { Batch, ChangedFile, ReviewThread } from "../types.ts";
import { fileDiff } from "./git.ts";

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

function threadSummary(threads: ReviewThread[], path: string): string {
  const relevant = threads.filter((t) => t.path === path && !t.isDeleted && t.comments.length > 0);
  if (relevant.length === 0) return "";
  const lines = relevant.map((t) => {
    const first = t.comments[0];
    const body = first.body.replace(/\s+/g, " ").slice(0, 220);
    const who = t.isBot ? `${first.author} (bot)` : first.author;
    return `- thread ${t.id} [${t.status}] line ${t.line ?? "?"} — ${who}: ${body}`;
  });
  return `\nExisting threads on this file (do not repeat these findings):\n${lines.join("\n")}\n`;
}

export interface PayloadContext {
  repoRoot: string;
  baseSHA: string;
  sourceSHA: string;
  files: Map<string, ChangedFile>;
  threads: ReviewThread[];
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
  parts.push("");
  parts.push(
    "Line numbers on the left are real line numbers in the source revision. " +
      "Report them as-is; lines marked `-|` were removed and cannot be commented on.",
  );
  parts.push("");
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
    const threadNote = threadSummary(ctx.threads, path);
    if (threadNote) parts.push(threadNote.trimEnd());
    parts.push("```diff");
    parts.push(annotateDiff(raw));
    parts.push("```");
    parts.push("</file>");
    parts.push("");
  }

  return parts.join("\n");
}
