import { RunStore } from "../core/store.ts";
import { resolveEvidence } from "../core/locate.ts";
import { renderJson, renderSarif } from "../core/sarif.ts";
import {
  assertsDependencyApi,
  isValidFindingVerification,
} from "../core/findingVerification.ts";
import type {
  ChangedFile,
  Finding,
  ReviewDepth,
  ReviewResult,
  ReviewThread,
  RunMeta,
  Severity,
} from "../types.ts";
import { TOOL_VERSION } from "../version.ts";

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "🔴 **Critical**",
  high: "🟠 **High**",
  medium: "🟡 **Medium**",
  low: "🔵 **Low**",
};

const SEVERITY_NAME: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

/** Label for a defect that predates the change. It never blocks the verdict. */
export const PRE_EXISTING_LABEL = "🟣 **Pre-existing**";

/**
 * Whether a finding must survive an independent challenge before the verdict.
 *
 * Quick reviews trade this away for speed; deep reviews demand it for every
 * finding. A standard review demands it for exactly the findings that would
 * block a merge, which is where a false positive costs the author the most.
 * Pre-existing findings never block, so they never require it.
 */
export function challengeRequired(depth: ReviewDepth, finding: Finding): boolean {
  if (finding.preExisting) return false;
  if (depth === "quick") return false;
  if (depth === "deep") return true;
  return finding.severity !== "low";
}

/**
 * Suppresses verified findings that the run's configuration says not to publish.
 *
 * Suppression is not deletion: the finding stays in findings.jsonl with a
 * reason, and the counts reach the Summary. It is recomputed on every
 * finalize, so changing a threshold and re-running is enough.
 */
export function applySuppression(
  findings: Finding[],
  files: ChangedFile[],
  meta: Pick<RunMeta, "depth" | "limits">,
): Finding[] {
  const minByPath = new Map(files.map((f) => [f.path, f.minSeverity]));
  const depth = meta.depth ?? "standard";
  const out = findings.map((finding) => {
    if (finding.status !== "verified") return finding;
    const min = minByPath.get(finding.path);
    if (min && SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(min)) {
      return { ...finding, status: "suppressed" as const, suppressedReason: `below the ${min} threshold for this path` };
    }
    if (depth === "quick" && finding.severity === "low") {
      return { ...finding, status: "suppressed" as const, suppressedReason: "quick reviews report Medium and above" };
    }
    return finding;
  });

  const cap = meta.limits?.maxLowFindings;
  if (cap !== undefined) {
    const lows = out
      .map((finding, index) => ({ finding, index }))
      .filter(({ finding }) => finding.status === "verified" && finding.severity === "low" && !finding.preExisting)
      .sort(
        (a, b) =>
          (a.finding.batch ?? 0) - (b.finding.batch ?? 0) ||
          a.finding.createdAt.localeCompare(b.finding.createdAt),
      );
    for (const { finding, index } of lows.slice(cap)) {
      out[index] = { ...finding, status: "suppressed", suppressedReason: `over the cap of ${cap} Low findings` };
    }
  }
  return out;
}

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
  const validations = await store.readValidations();

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
    delete updated.suppressedReason;
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
    if (updated.status === "verified" && updated.challenge?.outcome === "uncertain") {
      updated.status = "unconfirmed";
      notes.push(
        `  ${finding.id} (${finding.path}): the independent challenge was uncertain; ` +
          `report it under Open Questions, not Findings`,
      );
    }
    verified.push(updated);
  }
  const depth = meta.depth ?? "standard";
  const settled = applySuppression(verified, files, meta);
  verified.splice(0, verified.length, ...settled);
  await store.replaceFindings(verified);

  const lastVerdict = new Map<string, string>();
  for (const v of verdicts) lastVerdict.set(v.path, v.verdict);
  const reviewableSet = new Set(reviewablePaths);
  const covered = reviewablePaths.filter((path) => lastVerdict.has(path)).length;
  const missing = reviewablePaths.filter((p) => !lastVerdict.has(p));
  const crossBatch = [...lastVerdict]
    .filter(([path, verdict]) => reviewableSet.has(path) && verdict === "cross-batch")
    .map(([path]) => path);

  const publishable = verified.filter((f) => f.status === "verified");
  const blocked = verified.filter(
    (f) =>
      f.status === "candidate" || f.status === "unverified" || f.status === "unlocated",
  );
  const unconfirmed = verified.filter((f) => f.status === "unconfirmed");
  const suppressed = verified.filter((f) => f.status === "suppressed");
  const unchallenged = publishable.filter(
    (f) => challengeRequired(depth, f) && f.challenge === undefined,
  );

  if (args.render) {
    if (args.format === "sarif") return { output: renderSarif(verified, meta), ok: true };
    if (args.format === "json") return { output: renderJson(verified, meta), ok: true };
    return { output: renderFindings(verified, threads), ok: true };
  }

  const lines: string[] = [];
  lines.push(
    meta.scope === "ado-pr"
      ? `PR ${meta.prId} · iteration ${meta.iterationId} · ${meta.sourceSHA.slice(0, 10)}`
      : `${meta.scope} · ${meta.title} · ${meta.sourceSHA.slice(0, 10)}`,
  );
  const preExisting = publishable.filter((f) => f.preExisting).length;
  lines.push(
    `findings: ${publishable.length} verified` +
      (preExisting > 0 ? ` (${preExisting} pre-existing)` : "") +
      `, ${blocked.length} not publishable, ${unconfirmed.length} unconfirmed, ` +
      `${suppressed.length} suppressed, ` +
      `${verified.filter((f) => f.status === "duplicate").length} marked duplicate, ` +
      `${verified.filter((f) => f.status === "retracted").length} retracted`,
  );
  if (suppressed.length > 0) {
    const reasons = new Map<string, number>();
    for (const f of suppressed) {
      const reason = f.suppressedReason ?? "suppressed";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    lines.push(
      `suppressed: ${[...reasons].map(([reason, n]) => `${n} ${reason}`).join("; ")} ` +
        "(count them in the Summary; do not report them as findings)",
    );
  }
  lines.push(`coverage: ${covered}/${reviewablePaths.length} reviewable files`);
  if (validations.length > 0) {
    const passed = validations.filter((record) => record.exitCode === 0).length;
    const failed = validations.length - passed;
    lines.push(`validations: ${validations.length} recorded · ${passed} passed · ${failed} failed`);
    for (const record of validations.filter((item) => item.exitCode !== 0).slice(0, 5)) {
      lines.push(`  exit ${record.exitCode}: ${record.command.join(" ")}`);
    }
  }
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
  if (unchallenged.length > 0) {
    ok = false;
    lines.push(
      `BLOCKED: ${unchallenged.length} finding(s) need an independent challenge at depth ${depth} ` +
        `(record {"challenges": [{"id", "outcome", "detail", "by"}]} with prr note --file):`,
    );
    lines.push(
      ...unchallenged.slice(0, 10).map((f) => `  ${f.id} ${f.severity} ${f.path}:${f.line ?? "?"}`),
    );
  }

  const result = buildResult(meta, verified, ok, covered, reviewablePaths.length);
  await store.writeResult(result);
  lines.push(
    `result: ${result.suggestedVerdict} · blocking ${result.blocking}` +
      (meta.riskTier ? ` · risk tier ${meta.riskTier.tier}` : "") +
      " (result.json)",
  );
  lines.push(
    ok
      ? "OK: coverage complete. Render the report, then ask before posting."
      : "Resolve the blockers above before producing a verdict.",
  );
  return { output: lines.join("\n"), ok };
}

/** Builds the machine-readable outcome a pipeline can read without parsing prose. */
export function buildResult(
  meta: RunMeta,
  findings: Finding[],
  ok: boolean,
  covered: number,
  total: number,
): ReviewResult {
  const verified = findings.filter((f) => f.status === "verified");
  const current = verified.filter((f) => !f.preExisting);
  const count = (severity: Severity) => current.filter((f) => f.severity === severity).length;
  const blocking = current.filter((f) => f.severity !== "low").length;
  const unconfirmed = findings.filter((f) => f.status === "unconfirmed");
  const doubtfulBlocking = unconfirmed.filter((f) => !f.preExisting && f.severity !== "low").length;

  return {
    tool: "prr",
    version: TOOL_VERSION,
    scope: meta.scope,
    ...(meta.prId !== undefined ? { prId: meta.prId } : {}),
    ...(meta.iterationId !== undefined ? { iterationId: meta.iterationId } : {}),
    sourceSHA: meta.sourceSHA,
    depth: meta.depth ?? "standard",
    ok,
    coverage: { covered, total },
    counts: {
      critical: count("critical"),
      high: count("high"),
      medium: count("medium"),
      low: count("low"),
      preExisting: verified.length - current.length,
      suppressed: findings.filter((f) => f.status === "suppressed").length,
      unconfirmed: unconfirmed.length,
      notPublishable: findings.filter(
        (f) => f.status === "candidate" || f.status === "unverified" || f.status === "unlocated",
      ).length,
      duplicate: findings.filter((f) => f.status === "duplicate").length,
      retracted: findings.filter((f) => f.status === "retracted").length,
    },
    blocking,
    suggestedVerdict: !ok
      ? "incomplete"
      : blocking > 0
        ? "request-changes"
        : doubtfulBlocking > 0
          ? "needs-clarification"
          : "approve",
    ...(meta.riskTier ? { riskTier: meta.riskTier } : {}),
  };
}

function renderBlock(f: Finding): string {
  const lines: string[] = [];
  const label = f.preExisting
    ? `${PRE_EXISTING_LABEL} (${SEVERITY_NAME[f.severity]})`
    : SEVERITY_LABEL[f.severity];
  lines.push(`${label} — \`${f.path}\` (line ${f.line ?? "?"})`);
  lines.push(`Problem: ${f.problem}`);
  lines.push("Evidence:");
  lines.push("```");
  lines.push(f.evidence.trimEnd());
  lines.push("```");
  lines.push(`Fix: ${f.fix}`);
  if (f.rationale) lines.push(`Why flagged: ${f.rationale}`);
  if (f.verification) {
    lines.push(`Verification (${f.verification.method}): ${f.verification.detail}`);
  }
  if (f.challenge) lines.push(`Challenge (${f.challenge.outcome}): ${f.challenge.detail}`);
  if (f.fixedCode) {
    lines.push("Fixed code:");
    lines.push("```");
    lines.push(f.fixedCode.trimEnd());
    lines.push("```");
  }
  return lines.join("\n");
}

function bySeverity(a: Finding, b: Finding): number {
  return (
    SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
    a.path.localeCompare(b.path)
  );
}

/**
 * Renders findings as the markdown block the report and comments share.
 *
 * Accepts every recorded finding and selects by status itself, so the report
 * always agrees with what posting would publish: verified findings first,
 * pre-existing ones in their own section, and a count of what was held back.
 */
export function renderFindings(findings: Finding[], threads: ReviewThread[]): string {
  const verified = findings.filter((f) => f.status === "verified");
  const current = verified.filter((f) => !f.preExisting).sort(bySeverity);
  const preExisting = verified.filter((f) => f.preExisting).sort(bySeverity);
  const unconfirmed = findings.filter((f) => f.status === "unconfirmed").sort(bySeverity);
  const suppressed = findings.filter((f) => f.status === "suppressed").length;

  const sections: string[] = [];
  if (current.length === 0) {
    sections.push(
      "No verified findings introduced by this change. State this explicitly and describe any validation gaps.",
    );
  } else {
    sections.push(current.map(renderBlock).join("\n\n"));
  }
  if (preExisting.length > 0) {
    sections.push(
      "#### Pre-existing issues (not introduced by this change; never block the verdict)\n\n" +
        preExisting.map(renderBlock).join("\n\n"),
    );
  }
  if (unconfirmed.length > 0) {
    sections.push(
      "#### For Open Questions (independent challenge was uncertain)\n\n" +
        unconfirmed
          .map((f) => `- \`${f.path}\` line ${f.line ?? "?"} (${f.severity}): ${f.problem} — challenge: ${f.challenge?.detail ?? ""}`)
          .join("\n"),
    );
  }

  const notes: string[] = [];
  if (suppressed > 0) {
    notes.push(`_${suppressed} verified finding(s) were suppressed by path thresholds or caps and are not listed._`);
  }
  const covered = threads.filter((t) => !t.isBot && !t.isDeleted && t.path).length;
  if (covered > 0) {
    notes.push(`_${covered} existing inline thread(s) were reconciled; duplicates are omitted above._`);
  }
  return `${sections.join("\n\n")}\n${notes.length > 0 ? `\n${notes.join("\n")}` : ""}`;
}
