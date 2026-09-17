import { RunStore } from "../core/store.ts";
import { resolveEvidence } from "../core/locate.ts";
import { renderJson, renderSarif } from "../core/sarif.ts";
import {
  assertsDependencyApi,
  isValidFindingVerification,
} from "../core/findingVerification.ts";
import type { Finding, ReviewThread, Severity } from "../types.ts";

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "🔴 **Critical**",
  high: "🟠 **High**",
  medium: "🟡 **Medium**",
  low: "🔵 **Low**",
};

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

function shingles(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const out = new Set<string>();
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

function similarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return shared / Math.min(sa.size, sb.size);
}

/**
 * Flags findings that an existing thread may already cover.
 *
 * This only shortlists: file identity plus line proximity plus wording overlap
 * are evidence of a possible duplicate, not proof of one. Whether two reports
 * share a root cause is a judgement, so the decision stays with the reviewer
 * and nothing is discarded here.
 */
function findDuplicateCandidates(
  finding: Finding,
  threads: ReviewThread[],
): { thread: ReviewThread; score: number }[] {
  const text = `${finding.problem} ${finding.fix}`;
  const out: { thread: ReviewThread; score: number }[] = [];
  for (const thread of threads) {
    if (thread.isDeleted || thread.isBot || thread.path !== finding.path) continue;
    const body = thread.comments.map((c) => c.body).join(" ");
    let score = similarity(text, body);
    if (finding.line && thread.line && Math.abs(finding.line - thread.line) <= 10) score += 0.25;
    if (score >= 0.3) out.push({ thread, score: Math.round(score * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

export interface FinalizeArgs {
  dir?: string;
  /** Emit the findings instead of the gate report. */
  render?: boolean;
  /** Output format for --render. */
  format?: "md" | "sarif" | "json";
}

/**
 * Verifies findings, checks coverage, and renders the report.
 *
 * Verification is deterministic and deliberately strict: a finding whose
 * evidence cannot be found verbatim in the reviewed revision is demoted rather
 * than published. A quoted excerpt that does not exist is the clearest
 * available signal that the surrounding claim was not read off the code.
 */
export async function finalize(args: FinalizeArgs): Promise<{ output: string; ok: boolean }> {
  const store = await RunStore.open(args.dir);
  const meta = await store.meta();
  const files = await store.readFiles();
  const threads = await store.readThreads();
  const findings = await store.readFindings();
  const verdicts = await store.readVerdicts();

  const reviewable = files.filter((f) => f.decision === "review");
  const reviewablePaths = reviewable.map((f) => f.path);

  const verified: Finding[] = [];
  const notes: string[] = [];
  for (const finding of findings) {
    // "duplicate" and "retracted" are terminal, human-set outcomes. Re-running
    // verify must not overturn them: the evidence text can be genuine code and
    // still verify successfully while the underlying claim about it was wrong
    // (a reviewer, human or model, misjudged the code, not the location).
    if (finding.status === "duplicate" || finding.status === "retracted") {
      verified.push(finding);
      continue;
    }

    const updated: Finding = { ...finding };
    if (
      assertsDependencyApi(finding.problem, finding.fix) &&
      !isValidFindingVerification(finding.verification)
    ) {
      updated.status = "unverified";
      notes.push(
        `  ${finding.id} (${finding.path}): dependency API claim lacks runtime, test-run, ` +
          `or declaration verification; move it to Open Questions or add verification`,
      );
      verified.push(updated);
      continue;
    }

    const result = await resolveEvidence(
      meta.repoRoot,
      meta.sourceSHA,
      finding.path,
      finding.evidence,
      reviewablePaths,
    );
    switch (result.outcome) {
      case "resolved":
        updated.status = "verified";
        updated.line = result.location!.startLine;
        updated.endLine = result.location!.endLine;
        break;
      case "relocated":
        updated.status = "verified";
        updated.path = result.relocatedTo!;
        updated.line = result.location!.startLine;
        updated.endLine = result.location!.endLine;
        notes.push(
          `  ${finding.id}: evidence lives in ${result.relocatedTo}, finding re-filed there`,
        );
        break;
      case "ambiguous":
        updated.status = "unlocated";
        notes.push(
          `  ${finding.id} (${finding.path}): evidence matches several places in the file; ` +
            `quote a longer unique span`,
        );
        break;
      case "ambiguous-elsewhere":
        updated.status = "unlocated";
        notes.push(
          `  ${finding.id} (${finding.path}): evidence is absent here but present in ` +
            `${result.candidates!.length} other changed files ` +
            `(${result.candidates!.slice(0, 2).join(", ")}); name the right file or quote a longer span`,
        );
        break;
      default:
        updated.status = "unverified";
        notes.push(
          `  ${finding.id} (${finding.path}): evidence not found at ${meta.sourceSHA.slice(0, 10)}; ` +
            `move to Open Questions or quote the code exactly`,
        );
    }
    verified.push(updated);
  }
  await store.replaceFindings(verified);

  const lastVerdict = new Map<string, string>();
  for (const v of verdicts) lastVerdict.set(v.path, v.verdict);
  const missing = reviewablePaths.filter((p) => !lastVerdict.has(p));
  const crossBatch = [...lastVerdict].filter(([, v]) => v === "cross-batch").map(([p]) => p);

  const publishable = verified.filter((f) => f.status === "verified");
  const blocked = verified.filter(
    (f) => f.status !== "verified" && f.status !== "duplicate" && f.status !== "retracted",
  );

  if (args.render) {
    if (args.format === "sarif") return { output: renderSarif(verified, meta), ok: true };
    if (args.format === "json") return { output: renderJson(verified, meta), ok: true };
    return { output: renderFindings(publishable, threads), ok: true };
  }

  const lines: string[] = [];
  lines.push(
    meta.scope === "ado-pr"
      ? `PR ${meta.prId} · iteration ${meta.iterationId} · ${meta.sourceSHA.slice(0, 10)}`
      : `${meta.scope} · ${meta.title} · ${meta.sourceSHA.slice(0, 10)}`,
  );
  lines.push(
    `findings: ${publishable.length} verified, ${blocked.length} not publishable, ` +
      `${verified.filter((f) => f.status === "duplicate").length} marked duplicate, ` +
      `${verified.filter((f) => f.status === "retracted").length} retracted`,
  );
  lines.push(`coverage: ${lastVerdict.size}/${reviewablePaths.length} reviewable files`);
  if (notes.length > 0) {
    lines.push("verification notes:");
    lines.push(...notes.slice(0, 15));
  }

  const dupHints: string[] = [];
  for (const finding of publishable) {
    for (const candidate of findDuplicateCandidates(finding, threads)) {
      dupHints.push(
        `  ${finding.id} (${finding.path}:${finding.line}) ~ thread ${candidate.thread.id} ` +
          `[${candidate.thread.status}] score ${candidate.score}`,
      );
    }
  }
  if (dupHints.length > 0) {
    lines.push("possible duplicates of existing threads (decide, then re-note as duplicate):");
    lines.push(...dupHints.slice(0, 10));
  }

  let ok = true;
  if (missing.length > 0) {
    ok = false;
    lines.push(`BLOCKED: ${missing.length} reviewable file(s) have no verdict:`);
    lines.push(...missing.slice(0, 20).map((p) => `  ${p}`));
    if (missing.length > 20) lines.push(`  ... and ${missing.length - 20} more`);
  }
  if (crossBatch.length > 0) {
    ok = false;
    lines.push(`BLOCKED: ${crossBatch.length} file(s) still marked cross-batch:`);
    lines.push(...crossBatch.slice(0, 10).map((p) => `  ${p}`));
  }
  lines.push(
    ok
      ? "OK: coverage complete. Render the report, then ask before posting."
      : "Resolve the blockers above before producing a verdict.",
  );
  return { output: lines.join("\n"), ok };
}

/** Renders verified findings as the markdown block the report and comments share. */
export function renderFindings(findings: Finding[], threads: ReviewThread[]): string {
  if (findings.length === 0) {
    return "No verified findings. State this explicitly and describe any validation gaps.";
  }
  const ordered = findings
    .slice()
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        a.path.localeCompare(b.path),
    );

  const blocks = ordered.map((f) => {
    const lines: string[] = [];
    lines.push(`${SEVERITY_LABEL[f.severity]} — \`${f.path}\` (line ${f.line ?? "?"})`);
    lines.push(`Problem: ${f.problem}`);
    lines.push("Evidence:");
    lines.push("```");
    lines.push(f.evidence.trimEnd());
    lines.push("```");
    lines.push(`Fix: ${f.fix}`);
    if (f.verification) {
      lines.push(`Verification (${f.verification.method}): ${f.verification.detail}`);
    }
    if (f.fixedCode) {
      lines.push("Fixed code:");
      lines.push("```");
      lines.push(f.fixedCode.trimEnd());
      lines.push("```");
    }
    return lines.join("\n");
  });

  const covered = threads.filter((t) => !t.isBot && !t.isDeleted && t.path).length;
  const footer =
    covered > 0
      ? `\n_${covered} existing inline thread(s) were reconciled; duplicates are omitted above._`
      : "";
  return `${blocks.join("\n\n")}\n${footer}`;
}
