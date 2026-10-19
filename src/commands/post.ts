import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { AdoClient } from "../ado/client.ts";
import { RunStore } from "../core/store.ts";
import { showFile } from "../core/git.ts";
import { fenceFor, findingMarker, isOpenThreadStatus } from "../core/priorFindings.ts";
import type { ChangedFile, Finding, ReviewResult, RunMeta, Severity } from "../types.ts";

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "🔴 **Critical**",
  high: "🟠 **High**",
  medium: "🟡 **Medium**",
  low: "🔵 **Low**",
};

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Renders the comment body.
 *
 * The severity icon is part of the label, not decoration, so it is produced
 * here and travels to Azure DevOps inside a JSON request body. Nothing passes
 * through a shell, which is what used to mangle these characters.
 */
export function commentBody(finding: Finding): string {
  const label = finding.preExisting
    ? `🟣 **Pre-existing** (${SEVERITY_LABEL[finding.severity]}) — not introduced by this pull request`
    : SEVERITY_LABEL[finding.severity];
  const evidence = finding.evidence.trimEnd();
  const evidenceFence = fenceFor(evidence);
  const parts = [
    `${label} — ${finding.problem}`,
    "",
    "**Evidence**",
    evidenceFence,
    evidence,
    evidenceFence,
    `**Fix** ${finding.fix}`,
  ];
  if (finding.fixedCode) {
    const code = finding.fixedCode.trimEnd();
    const fence = fenceFor(code);
    parts.push("", "**Suggested code**", fence, code, fence);
  }
  // Collapsible sections are not documented for pull request comments, so the
  // reasoning is a short plain section placed after the actionable part.
  const why: string[] = [];
  if (finding.rationale) why.push(finding.rationale);
  if (finding.challenge?.outcome === "confirmed") {
    why.push(`Independently challenged and confirmed: ${finding.challenge.detail}`);
  }
  if (finding.verification) {
    why.push(`Verified by ${finding.verification.method}: ${finding.verification.detail}`);
  }
  if (why.length > 0) parts.push("", `**Why this was flagged** ${why.join(" ")}`);
  parts.push("", findingMarker(finding));
  return parts.join("\n");
}

/** One-line, parseable outcome appended to the posted summary. */
export function resultFooter(result: ReviewResult): string {
  const c = result.counts;
  return (
    `_prr result: ${result.suggestedVerdict} · critical ${c.critical} · high ${c.high} · ` +
    `medium ${c.medium} · low ${c.low} · pre-existing ${c.preExisting} · suppressed ${c.suppressed}` +
    (result.iterationId !== undefined ? ` · iteration ${result.iterationId}` : "") +
    ` · ${result.sourceSHA.slice(0, 10)}_`
  );
}

interface PostedLedger {
  [fingerprint: string]: number;
}

export interface PostArgs {
  dir?: string;
  minSeverity?: Severity;
  dryRun?: boolean;
  /** Summary and verdict text to publish as the top-level comment. */
  summaryFile?: string;
  /** Finding ids whose posted threads should be corrected and closed. */
  retract?: string[];
  /** Re-render the summary as a correction reply on the existing summary thread. */
  updateSummary?: boolean;
  /** Publish pre-existing findings too; they are withheld by default. */
  includePreExisting?: boolean;
  /** Threads from earlier prr runs to resolve. */
  resolve?: number[];
  /** How the resolved threads are closed. */
  resolution?: "fixed" | "withdrawn";
  /** Optional markdown reply posted on each resolved thread instead of the default text. */
  messageFile?: string;
}

const SUMMARY_KEY = "__summary__";

/**
 * Publishes verified findings as inline threads.
 *
 * Every post is keyed by the finding's fingerprint and recorded in the run
 * directory, so re-running after a partial failure resumes instead of filing
 * the same defect twice. Unverified, unlocated and duplicate findings are
 * never published: a comment that cannot name a real line is noise on someone
 * else's pull request.
 */
export async function post(args: PostArgs): Promise<string> {
  const modes = [
    args.retract && args.retract.length > 0,
    args.updateSummary,
    args.resolve && args.resolve.length > 0,
  ].filter(Boolean).length;
  if (modes > 1) {
    throw new Error(
      "--retract, --update-summary and --resolve are separate write actions; run them separately.",
    );
  }

  const store = await RunStore.open(args.dir);
  const meta = await store.meta();

  // Posting is a pull request operation. A branch or working-tree review has no
  // thread to attach to, and silently doing nothing would look like success.
  const org = meta.org;
  const project = meta.project;
  const prId = meta.prId;
  if (meta.scope !== "ado-pr" || !org || !project || prId === undefined) {
    throw new Error(
      `This run has scope "${meta.scope}", which has no pull request to comment on. ` +
        `Use \`prr finalize --render\` to produce the report instead.`,
    );
  }

  const findings = await store.readFindings();
  const files = await store.readFiles();

  const threshold = SEVERITY_RANK[args.minSeverity ?? "high"];
  const ledgerPath = store.path("posted.json");
  const ledger: PostedLedger = existsSync(ledgerPath)
    ? (JSON.parse(await readFile(ledgerPath, "utf8")) as PostedLedger)
    : {};
  const saveLedger = () =>
    writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

  if (args.retract && args.retract.length > 0) {
    return retractFindings({
      args,
      client: new AdoClient({ org, project, repo: meta.repo }),
      findings,
      ledger,
      prId,
      saveLedger,
    });
  }

  if (args.resolve && args.resolve.length > 0) {
    return resolveThreads({
      args,
      client: new AdoClient({ org, project, repo: meta.repo }),
      store,
      ledger,
      prId,
      saveLedger,
    });
  }

  if (args.updateSummary) {
    return updateSummary({
      args,
      client: new AdoClient({ org, project, repo: meta.repo }),
      store,
      ledger,
      prId,
      saveLedger,
    });
  }

  // These two exclusions are reported separately because they mean different
  // things to the caller: "not publishable" is permanent for this revision,
  // while "below the requested severity" is just this run's threshold and may
  // already be posted from an earlier, lower-threshold run.
  const locatable = findings.filter(
    (f) => f.status === "verified" && typeof f.line === "number",
  );
  const terminalExcluded = findings.filter(
    (f) => f.status === "duplicate" || f.status === "retracted",
  ).length;
  const notPublishable = findings.filter(
    (f) =>
      f.status !== "verified" &&
      f.status !== "duplicate" &&
      f.status !== "retracted",
  ).length + findings.filter((f) => f.status === "verified" && typeof f.line !== "number").length;
  const preExistingWithheld = args.includePreExisting
    ? 0
    : locatable.filter((f) => f.preExisting).length;
  const inScope = locatable.filter((f) => args.includePreExisting || !f.preExisting);
  const eligible = inScope.filter((f) => SEVERITY_RANK[f.severity] <= threshold);
  const belowThreshold = inScope.length - eligible.length;

  // A finding with the same fingerprint may already sit in a thread posted by an
  // earlier run over a previous iteration. The ledger of that run is gone, but
  // the footer in the thread is not.
  const priorById = new Map((await store.readPriorFindings()).map((p) => [p.findingId, p.threadId]));
  for (const f of eligible) {
    if (ledger[f.id] === undefined && priorById.has(f.id)) ledger[f.id] = priorById.get(f.id)!;
  }
  const pending = eligible.filter((f) => ledger[f.id] === undefined);

  const fileByPath = new Map(files.map((f) => [f.path, f]));

  if (args.dryRun) {
    const lines = [
      `dry run: ${pending.length} thread(s) would be posted to PR ${prId}` +
        ` (${eligible.length - pending.length} already posted, ${belowThreshold} below --min-severity, ` +
        `${preExistingWithheld} pre-existing withheld, ` +
        `${notPublishable} not publishable, ${terminalExcluded} duplicate/retracted)`,
    ];
    for (const f of pending) {
      lines.push(`  ${f.severity} ${f.path}:${f.line} [${f.id}]`);
    }
    if (args.summaryFile) lines.push("  + 1 summary comment");
    return lines.join("\n");
  }

  const client = new AdoClient({ org, project, repo: meta.repo });
  const posted: string[] = [];
  const failed: string[] = [];

  for (const finding of pending) {
    try {
      const body = await buildThread(meta, finding, fileByPath.get(finding.path));
      const thread = await client.createThread(prId, body);
      ledger[finding.id] = thread.id;
      posted.push(`  ${finding.severity} ${finding.path}:${finding.line} -> thread ${thread.id}`);
    } catch (err) {
      failed.push(`  ${finding.path}:${finding.line} — ${(err as Error).message.slice(0, 160)}`);
    }
    await saveLedger();
  }

  let summaryLine = "";
  if (args.summaryFile) {
    const content = await summaryContent(args.summaryFile, store);
    if (ledger[SUMMARY_KEY] !== undefined) {
      summaryLine =
        `summary comment already posted as thread ${ledger[SUMMARY_KEY]} ` +
        `(use --update-summary to append a correction)`;
    } else {
      const thread = await client.createThread(prId, {
        comments: [{ content, commentType: 1 }],
        status: 1,
      });
      ledger[SUMMARY_KEY] = thread.id;
      ledger[`summary:${summaryHash(content)}`] = thread.id;
      await saveLedger();
      summaryLine = `summary comment posted as thread ${thread.id}`;
    }
  }

  const lines = [`posted ${posted.length} thread(s) to PR ${prId}`];
  lines.push(...posted);
  if (summaryLine) lines.push(summaryLine);
  if (failed.length > 0) {
    lines.push(`failed ${failed.length}:`);
    lines.push(...failed);
  }
  if (belowThreshold > 0) {
    lines.push(
      `${belowThreshold} finding(s) are below --min-severity ${args.minSeverity ?? "high"} ` +
        `(already excluded for no other reason; rerun with a lower threshold to include them).`,
    );
  }
  if (preExistingWithheld > 0) {
    lines.push(
      `${preExistingWithheld} pre-existing finding(s) were withheld (rerun with --include-pre-existing to post them).`,
    );
  }
  if (notPublishable > 0) {
    lines.push(
      `${notPublishable} finding(s) were not publishable (unverified, unlocated, unconfirmed or suppressed).`,
    );
  }
  if (terminalExcluded > 0) {
    lines.push(`${terminalExcluded} finding(s) were terminally excluded (duplicate or retracted).`);
  }
  return lines.join("\n");
}

async function buildThread(
  meta: RunMeta,
  finding: Finding,
  file: ChangedFile | undefined,
): Promise<Record<string, unknown>> {
  const line = finding.line!;
  const endLine = finding.endLine ?? line;

  // The end offset has to cover the last character of the anchored span, so the
  // length of that line is read from the revision being commented on.
  const content = await showFile(meta.repoRoot, meta.sourceSHA, finding.path);
  const lines = content.split("\n");
  const endOffset = Math.max(1, (lines[endLine - 1] ?? "").length + 1);

  const thread: Record<string, unknown> = {
    comments: [{ content: commentBody(finding), commentType: 1 }],
    status: 1,
    threadContext: {
      filePath: `/${finding.path}`,
      rightFileStart: { line, offset: 1 },
      rightFileEnd: { line: endLine, offset: endOffset },
    },
  };

  if (file?.changeTrackingId !== undefined && meta.iterationId !== undefined) {
    // Without this context the comment is anchored to a snapshot rather than to
    // the change, and a later push detaches it from the code it describes.
    thread.pullRequestThreadContext = {
      changeTrackingId: file.changeTrackingId,
      iterationContext: {
        firstComparingIteration: meta.iterationId,
        secondComparingIteration: meta.iterationId,
      },
    };
  }
  return thread;
}

interface RetractContext {
  args: PostArgs;
  client: AdoClient;
  findings: Finding[];
  ledger: PostedLedger;
  prId: number;
  saveLedger: () => Promise<void>;
}

/**
 * Corrects and closes the threads of findings that turned out to be wrong.
 *
 * A wrong finding left active costs the author more than no finding at all: it
 * asks them to "fix" working code. The original comment is kept and a
 * correction is appended rather than edited in, so the record of what was
 * claimed stays visible and auditable.
 */
async function retractFindings(ctx: RetractContext): Promise<string> {
  const { args, client, findings, ledger, prId, saveLedger } = ctx;
  const byId = new Map(findings.map((f) => [f.id, f]));
  const planned: { finding: Finding; threadId: number }[] = [];
  const skipped: string[] = [];

  for (const id of args.retract ?? []) {
    const finding = byId.get(id);
    if (!finding) {
      throw new Error(`--retract: "${id}" is not a recorded finding id.`);
    }
    // Retraction is a judgement, so it is recorded through `note --file` first.
    // Requiring it here keeps the local record and the pull request in step:
    // a closed thread always has a retracted finding behind it.
    if (finding.status !== "retracted") {
      throw new Error(
        `--retract: finding ${id} has status "${finding.status}". Mark it retracted first ` +
          `with \`prr note --file\` and {"retract": ["${id}"]}, then re-run this command.`,
      );
    }
    const threadId = ledger[id];
    if (threadId === undefined) {
      skipped.push(`  ${id} (${finding.path}) — never posted, nothing to correct`);
      continue;
    }
    if (ledger[`retracted:${id}`] !== undefined) {
      skipped.push(`  ${id} (${finding.path}) — thread ${threadId} already corrected and closed`);
      continue;
    }
    planned.push({ finding, threadId });
  }

  if (args.dryRun) {
    const lines = [
      `dry run: ${planned.length} posted thread(s) would be corrected and closed on PR ${prId}`,
    ];
    for (const { finding, threadId } of planned) {
      lines.push(`  ${finding.severity} ${finding.path}:${finding.line} -> thread ${threadId}`);
    }
    lines.push(...skipped);
    return lines.join("\n");
  }

  const done: string[] = [];
  const failed: string[] = [];
  for (const { finding, threadId } of planned) {
    try {
      await client.replyToThread(prId, threadId, retractionComment(finding));
      await client.setThreadStatus(prId, threadId, "closed");
      ledger[`retracted:${finding.id}`] = threadId;
      await saveLedger();
      done.push(`  ${finding.path}:${finding.line} -> thread ${threadId} corrected and closed`);
    } catch (err) {
      failed.push(`  ${finding.id} — ${(err as Error).message.slice(0, 160)}`);
    }
  }

  const lines = [`retracted ${done.length} posted finding(s) on PR ${prId}`];
  lines.push(...done, ...skipped);
  if (failed.length > 0) {
    lines.push(`failed ${failed.length}:`);
    lines.push(...failed);
  }
  if (done.length > 0) {
    lines.push(
      "The summary comment may now be stale. Re-render it and run `prr post --update-summary`.",
    );
  }
  return lines.join("\n");
}

/** The correction appended to a retracted finding's thread. */
function retractionComment(finding: Finding): string {
  return [
    "⚠️ **Correction — this finding is incorrect, please disregard**",
    "",
    "The claim above did not hold up on closer verification and has been retracted by the",
    "reviewer. No change is needed for this comment.",
    "",
    "Apologies for the noise.",
  ].join("\n");
}

interface SummaryContext {
  args: PostArgs;
  client: AdoClient;
  store: RunStore;
  ledger: PostedLedger;
  prId: number;
  saveLedger: () => Promise<void>;
}

/**
 * Appends a corrected summary to the already-posted summary thread.
 *
 * The summary is the first thing a reviewer reads, so a stale one — counts from
 * before a retraction or a later round — misleads more than any single inline
 * comment. Appending rather than editing keeps the original visible.
 */
async function updateSummary(ctx: SummaryContext): Promise<string> {
  const { args, client, ledger, prId, saveLedger } = ctx;
  if (!args.summaryFile) {
    throw new Error("--update-summary requires --summary <path.md> with the corrected text.");
  }
  const content = await summaryContent(args.summaryFile, ctx.store);
  const contentHash = summaryHash(content);
  const updateKey = `summary:${contentHash}`;
  const threadId = ledger[SUMMARY_KEY];

  if (threadId === undefined) {
    if (args.dryRun) {
      return `dry run: no summary thread recorded yet; the text would be posted as a new summary on PR ${prId}`;
    }
    const thread = await client.createThread(prId, {
      comments: [{ content, commentType: 1 }],
      status: 1,
    });
    ledger[SUMMARY_KEY] = thread.id;
    ledger[updateKey] = thread.id;
    await saveLedger();
    return `no existing summary thread; summary posted as thread ${thread.id}`;
  }

  if (ledger[updateKey] !== undefined) {
    return `summary correction already posted to thread ${threadId} (content ${contentHash})`;
  }

  if (args.dryRun) {
    return `dry run: a correction would be appended to summary thread ${threadId} on PR ${prId} ` +
      `(content ${contentHash})`;
  }

  await client.replyToThread(prId, threadId, content);
  ledger[updateKey] = threadId;
  await saveLedger();
  return `summary correction appended to thread ${threadId} (content ${contentHash})`;
}

function summaryHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Reads the summary text and appends the machine-readable result line.
 *
 * The line is generated from result.json rather than written by the reviewer,
 * so a pipeline reading it gets the same counts finalize computed.
 */
async function summaryContent(path: string, store: RunStore): Promise<string> {
  const text = (await readFile(path, "utf8")).trimEnd();
  const result = await store.readResult();
  return result ? `${text}\n\n${resultFooter(result)}\n` : `${text}\n`;
}

interface ResolveContext {
  args: PostArgs;
  client: AdoClient;
  store: RunStore;
  ledger: PostedLedger;
  prId: number;
  saveLedger: () => Promise<void>;
}

/**
 * Resolves threads that earlier prr runs posted.
 *
 * Only threads recognized as prr findings can be resolved, so this can never
 * close a human reviewer's thread. "fixed" says the author addressed it;
 * "withdrawn" says the finding was wrong. Either way a reply explains the
 * change of status, because a thread that silently closes looks like it was
 * dismissed rather than settled.
 */
async function resolveThreads(ctx: ResolveContext): Promise<string> {
  const { args, client, store, ledger, prId, saveLedger } = ctx;
  const resolution = args.resolution ?? "fixed";
  if (resolution !== "fixed" && resolution !== "withdrawn") {
    throw new Error("--resolution must be fixed or withdrawn.");
  }
  const custom = args.messageFile ? (await readFile(args.messageFile, "utf8")).trim() : undefined;
  const prior = new Map((await store.readPriorFindings()).map((p) => [p.threadId, p]));
  const meta = await store.meta();

  const planned: { threadId: number; findingId: string; path?: string }[] = [];
  const skipped: string[] = [];
  for (const threadId of args.resolve ?? []) {
    const entry = prior.get(threadId);
    if (!entry) {
      throw new Error(
        `--resolve: thread ${threadId} is not a prr finding thread on this pull request ` +
          `(see prior-findings.json). Human threads are never resolved by this tool.`,
      );
    }
    if (ledger[`resolved:${threadId}`] !== undefined) {
      skipped.push(`  thread ${threadId} — already resolved by this run`);
      continue;
    }
    if (!isOpenThreadStatus(entry.status)) {
      skipped.push(`  thread ${threadId} — already ${entry.status}`);
      continue;
    }
    planned.push({ threadId, findingId: entry.findingId, ...(entry.path ? { path: entry.path } : {}) });
  }

  if (args.dryRun) {
    const lines = [`dry run: ${planned.length} thread(s) would be resolved as ${resolution} on PR ${prId}`];
    for (const p of planned) lines.push(`  thread ${p.threadId} (${p.path ?? "?"}, finding ${p.findingId})`);
    lines.push(...skipped);
    return lines.join("\n");
  }

  const done: string[] = [];
  const failed: string[] = [];
  for (const p of planned) {
    try {
      const text = custom ?? resolutionComment(resolution, meta);
      await client.replyToThread(prId, p.threadId, text);
      await client.setThreadStatus(prId, p.threadId, resolution === "fixed" ? "fixed" : "closed");
      ledger[`resolved:${p.threadId}`] = p.threadId;
      await saveLedger();
      done.push(`  thread ${p.threadId} -> ${resolution === "fixed" ? "fixed" : "closed"}`);
    } catch (err) {
      failed.push(`  thread ${p.threadId} — ${(err as Error).message.slice(0, 160)}`);
    }
  }
  const lines = [`resolved ${done.length} prr thread(s) on PR ${prId} as ${resolution}`];
  lines.push(...done, ...skipped);
  if (failed.length > 0) {
    lines.push(`failed ${failed.length}:`);
    lines.push(...failed);
  }
  return lines.join("\n");
}

function resolutionComment(resolution: "fixed" | "withdrawn", meta: RunMeta): string {
  const where =
    meta.iterationId !== undefined
      ? `iteration ${meta.iterationId} (${meta.sourceSHA.slice(0, 10)})`
      : meta.sourceSHA.slice(0, 10);
  return resolution === "fixed"
    ? `✅ **Resolved** — re-reviewed at ${where}; the issue described above is addressed. Reopen this thread if it is not.`
    : `⚠️ **Withdrawn** — re-reviewed at ${where}; this finding does not hold and needs no change. Apologies for the noise.`;
}
