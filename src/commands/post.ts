import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { AdoClient } from "../ado/client.ts";
import { RunStore } from "../core/store.ts";
import { showFile } from "../core/git.ts";
import type { ChangedFile, Finding, RunMeta, Severity } from "../types.ts";

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
function commentBody(finding: Finding): string {
  const parts = [
    `${SEVERITY_LABEL[finding.severity]} — ${finding.problem}`,
    "",
    "**Evidence**",
    "```",
    finding.evidence.trimEnd(),
    "```",
    `**Fix** ${finding.fix}`,
  ];
  if (finding.fixedCode) {
    parts.push("", "**Suggested code**", "```", finding.fixedCode.trimEnd(), "```");
  }
  return parts.join("\n");
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
}

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

  // These two exclusions are reported separately because they mean different
  // things to the caller: "not publishable" is permanent for this revision,
  // while "below the requested severity" is just this run's threshold and may
  // already be posted from an earlier, lower-threshold run.
  const locatable = findings.filter(
    (f) => f.status === "verified" && typeof f.line === "number",
  );
  const notPublishable = findings.length - locatable.length;
  const eligible = locatable.filter((f) => SEVERITY_RANK[f.severity] <= threshold);
  const belowThreshold = locatable.length - eligible.length;
  const pending = eligible.filter((f) => ledger[f.id] === undefined);

  const fileByPath = new Map(files.map((f) => [f.path, f]));

  if (args.dryRun) {
    const lines = [
      `dry run: ${pending.length} thread(s) would be posted to PR ${prId}` +
        ` (${eligible.length - pending.length} already posted, ${belowThreshold} below --min-severity, ` +
        `${notPublishable} not publishable)`,
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
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  }

  let summaryLine = "";
  if (args.summaryFile) {
    const content = await readFile(args.summaryFile, "utf8");
    const key = "__summary__";
    if (ledger[key] !== undefined) {
      summaryLine = `summary comment already posted as thread ${ledger[key]}`;
    } else {
      const thread = await client.createThread(prId, {
        comments: [{ content, commentType: 1 }],
        status: 1,
      });
      ledger[key] = thread.id;
      await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
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
  if (notPublishable > 0) {
    lines.push(`${notPublishable} finding(s) were not publishable (unverified or unlocated).`);
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
