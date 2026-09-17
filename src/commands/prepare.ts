import { AdoClient } from "../ado/client.ts";
import { getCredential } from "../ado/auth.ts";
import { parsePrUrl, parseRemoteUrl, remoteUrlFor, webUrlFor } from "../ado/url.ts";
import type { AdoTarget } from "../ado/url.ts";
import type { PolicyEvaluation, PullRequestStatus } from "../ado/client.ts";
import {
  WORKTREE,
  fetchCommits,
  listChanges,
  mergeBase,
  remoteUrl,
  repoRoot,
  revParse,
  currentBranch,
  showFile,
} from "../core/git.ts";
import { triage } from "../core/triage.ts";
import { buildBatches } from "../core/batch.ts";
import { renderPayload } from "../core/payload.ts";
import { loadRules } from "../core/rules.ts";
import { collapseGeneratedDuplicates } from "../core/generated.ts";
import { RunStore, runDirFor } from "../core/store.ts";
import type { ChangedFile, ReviewScope, ReviewThread, RunMeta } from "../types.ts";
import { TOOL_VERSION } from "../version.ts";

export interface PrepareArgs {
  /** Pull request URL or id. Absent for local scopes. */
  target?: string;
  /** Review the current branch against this base ref. */
  branch?: string;
  /** Review uncommitted work against HEAD. */
  workingTree?: boolean;
  repo?: string;
  iteration?: number;
  since?: number;
  maxFiles?: number;
  maxTokens?: number;
  rule?: string;
  /** Discard verdicts and findings recorded by an earlier pass over the same revision. */
  reset?: boolean;
}

/** Resolves the pull request coordinates from a URL, or from origin plus a bare number. */
async function resolveTarget(
  target: string,
  cwd: string,
): Promise<AdoTarget & { prId: number }> {
  const fromUrl = parsePrUrl(target);
  if (fromUrl?.prId) return fromUrl as AdoTarget & { prId: number };

  const prId = Number.parseInt(target, 10);
  if (!Number.isFinite(prId)) {
    throw new Error(`Cannot interpret "${target}" as an Azure DevOps pull request URL or id.`);
  }
  const origin = await remoteUrl(cwd);
  const fromRemote = origin ? parseRemoteUrl(origin) : undefined;
  if (!fromRemote) {
    throw new Error(
      `A bare pull request id needs an Azure DevOps "origin" remote to inherit from; ` +
        `origin is "${origin || "unset"}". Pass the full pull request URL instead.`,
    );
  }
  return { ...fromRemote, prId };
}

interface OptionalEvidence<T> {
  available: boolean;
  items: T[];
  error?: string;
}

interface ScopeResult {
  meta: Omit<RunMeta, "runDir" | "ruleSources">;
  threads: ReviewThread[];
  trackingIds: Map<string, number>;
  /** Paths the Azure DevOps iteration reports as changed, for incremental runs. */
  iterationPaths?: Set<string>;
  pullRequest?: unknown;
  policies?: OptionalEvidence<PolicyEvaluation>;
  builds?: OptionalEvidence<PullRequestStatus>;
  credentialSource: string;
}

async function optionalEvidence<T>(load: () => Promise<T[]>): Promise<OptionalEvidence<T>> {
  try {
    return { available: true, items: await load() };
  } catch (err) {
    return {
      available: false,
      items: [],
      error: (err as Error).message.slice(0, 300),
    };
  }
}

/** Pins an Azure DevOps pull request iteration and fetches its evidence. */
async function prepareAdoScope(args: PrepareArgs, root: string): Promise<ScopeResult> {
  const target = await resolveTarget(args.target!, root);
  const client = new AdoClient(target);
  const [pr, iterations] = await Promise.all([
    client.getPullRequest(target.prId),
    client.listIterations(target.prId),
  ]);
  if (iterations.length === 0) {
    throw new Error(`Pull request ${target.prId} reports no iterations.`);
  }

  const iteration =
    args.iteration !== undefined
      ? iterations.find((it) => it.id === args.iteration)
      : iterations[iterations.length - 1];
  if (!iteration) {
    throw new Error(
      `Iteration ${args.iteration} not found; available: ${iterations.map((i) => i.id).join(", ")}.`,
    );
  }

  const sourceSHA = iteration.sourceRefCommit.commitId;
  const targetSHA = iteration.targetRefCommit.commitId;
  // The iteration's common commit is the authoritative merge base, so nothing
  // here has to re-derive one from local history that may not even be present.
  const baseSHA = iteration.commonRefCommit.commitId;

  const projectId = pr.repository?.project?.id;
  const unavailablePolicies: OptionalEvidence<PolicyEvaluation> = {
    available: false,
    items: [],
    error: projectId ? undefined : "Pull request metadata did not include a project id.",
  };
  const [threads, changeEntries, builds, policies] = await Promise.all([
    client.listThreads(target.prId),
    client.listIterationChanges(target.prId, iteration.id, args.since),
    optionalEvidence(() => client.listPullRequestStatuses(target.prId)),
    projectId
      ? optionalEvidence(() => client.listPolicyEvaluations(target.prId, projectId))
      : Promise.resolve(unavailablePolicies),
  ]);

  const cred = await getCredential();
  await fetchCommits(root, remoteUrlFor(target), [sourceSHA, baseSHA], cred.header);

  const trackingIds = new Map<string, number>();
  const iterationPaths = new Set<string>();
  for (const entry of changeEntries) {
    const path = (entry.item.path ?? "").replace(/^\//, "");
    if (!path || entry.item.isFolder) continue;
    iterationPaths.add(path);
    if (entry.changeTrackingId !== undefined) trackingIds.set(path, entry.changeTrackingId);
  }

  return {
    meta: {
      toolVersion: TOOL_VERSION,
      createdAt: new Date().toISOString(),
      scope: "ado-pr",
      org: target.org,
      project: target.project,
      ...(projectId ? { projectId } : {}),
      repo: target.repo,
      repoId: pr.repository?.id ?? "",
      prId: target.prId,
      title: pr.title,
      author: pr.createdBy?.displayName ?? "unknown",
      isDraft: pr.isDraft === true,
      status: pr.status,
      sourceBranch: pr.sourceRefName.replace(/^refs\/heads\//, ""),
      targetBranch: pr.targetRefName.replace(/^refs\/heads\//, ""),
      iterationId: iteration.id,
      ...(args.since !== undefined ? { compareTo: args.since } : {}),
      sourceSHA,
      targetSHA,
      baseSHA,
      repoRoot: root,
      webUrl: webUrlFor(target, target.prId),
    },
    threads,
    trackingIds,
    iterationPaths,
    pullRequest: {
      title: pr.title,
      description: pr.description ?? "",
      author: pr.createdBy?.displayName ?? "unknown",
      status: pr.status,
      isDraft: pr.isDraft,
      labels: (pr.labels ?? []).map((l) => l.name),
      iterations: iterations.map((it) => ({
        id: it.id,
        createdDate: it.createdDate,
        description: it.description,
        sourceSHA: it.sourceRefCommit.commitId,
      })),
    },
    policies,
    builds,
    credentialSource: cred.source,
  };
}

/** Pins a local branch or the working tree. No network access. */
async function prepareLocalScope(args: PrepareArgs, root: string): Promise<ScopeResult> {
  const repoName = root.slice(root.lastIndexOf("/") + 1);
  const branch = (await currentBranch(root)) || "HEAD";

  if (args.workingTree) {
    const headSHA = await revParse(root, "HEAD");
    return {
      meta: {
        toolVersion: TOOL_VERSION,
        createdAt: new Date().toISOString(),
        scope: "working-tree" as ReviewScope,
        repo: repoName,
        title: `Working tree of ${branch}`,
        sourceBranch: branch,
        targetBranch: branch,
        sourceSHA: WORKTREE,
        targetSHA: headSHA,
        baseSHA: headSHA,
        repoRoot: root,
      },
      threads: [],
      trackingIds: new Map(),
      credentialSource: "none",
    };
  }

  const baseRef = args.branch!;
  const base = await mergeBase(root, baseRef, "HEAD");
  const sourceSHA = await revParse(root, "HEAD");
  return {
    meta: {
      toolVersion: TOOL_VERSION,
      createdAt: new Date().toISOString(),
      scope: "branch" as ReviewScope,
      repo: repoName,
      title: `${branch} vs ${baseRef}`,
      sourceBranch: branch,
      targetBranch: baseRef,
      sourceSHA,
      targetSHA: await revParse(root, baseRef),
      baseSHA: base,
      repoRoot: root,
    },
    threads: [],
    trackingIds: new Map(),
    credentialSource: "none",
  };
}

export async function prepare(args: PrepareArgs): Promise<string> {
  const cwd = args.repo ?? process.cwd();
  const root = await repoRoot(cwd);

  const isLocal = args.branch !== undefined || args.workingTree === true;
  if (!isLocal && !args.target) {
    throw new Error(
      "`prr prepare` needs a pull request URL or id, or --branch <base>, or --working-tree.",
    );
  }

  const scope = isLocal
    ? await prepareLocalScope(args, root)
    : await prepareAdoScope(args, root);

  const rules = await loadRules(root, args.rule);

  let changes = await listChanges(root, scope.meta.baseSHA, scope.meta.sourceSHA);
  if (args.since !== undefined && scope.iterationPaths) {
    // Incremental review: keep only files the compared iterations actually touched.
    changes = changes.filter((c) => scope.iterationPaths!.has(c.path));
  }

  let files = triage(changes, scope.trackingIds, { maxFileTokens: 60_000, rules });
  const generated = files.filter((file) => file.category === "generated");
  if (generated.length > 1) {
    const contentPairs = await Promise.all(
      generated.map(async (file) => [
        file.path,
        await showFile(root, scope.meta.sourceSHA, file.path),
      ] as const),
    );
    files = collapseGeneratedDuplicates(files, new Map(contentPairs));
  }
  const batches = buildBatches(files, {
    maxFiles: args.maxFiles ?? 10,
    maxTokens: args.maxTokens ?? 25_000,
    planFileLines: 50,
    planGroupLines: 100,
  });

  const runDir = runDirFor(scope.meta);
  const meta: RunMeta = {
    ...scope.meta,
    runDir,
    ...(rules.sources.length > 0 ? { ruleSources: rules.sources } : {}),
  };

  const store = await RunStore.create(meta);
  const carried = await store.carriedProgress();
  if (args.reset) await store.resetProgress();

  if (scope.pullRequest) await store.writePullRequest(scope.pullRequest);
  if (scope.policies) await store.writePolicies(scope.policies);
  if (scope.builds) await store.writeBuilds(scope.builds);
  await store.writeThreads(scope.threads);
  await store.writeFiles(files);
  await store.writeBatches(batches);

  const fileMap = new Map(files.map((f) => [f.path, f]));
  for (const batch of batches) {
    const content = await renderPayload(batch, {
      repoRoot: root,
      baseSHA: meta.baseSHA,
      sourceSHA: meta.sourceSHA,
      files: fileMap,
      threads: scope.threads,
    });
    await store.writePayload(batch.payload, content);
  }

  return formatSummary(
    meta,
    files,
    batches,
    scope.threads.length,
    scope.credentialSource,
    args.reset ? 0 : carried,
    rules.sources,
    scope.policies,
    scope.builds,
  );
}

function evidenceSummary(
  evidence: OptionalEvidence<{ status?: string; state?: string }> | undefined,
): string {
  if (!evidence) return "not applicable";
  if (!evidence.available) return `unavailable (${evidence.error ?? "request failed"})`;
  if (evidence.items.length === 0) return "none reported";
  const counts = new Map<string, number>();
  for (const item of evidence.items) {
    const state = (item.status ?? item.state ?? "unknown").toLowerCase();
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts].map(([state, count]) => `${state} x${count}`).join(", ");
}

function formatSummary(
  meta: RunMeta,
  files: ChangedFile[],
  batches: ReturnType<typeof buildBatches>,
  threadCount: number,
  credSource: string,
  carried: number,
  ruleSources: string[],
  policies?: OptionalEvidence<PolicyEvaluation>,
  builds?: OptionalEvidence<PullRequestStatus>,
): string {
  const counts = { review: 0, "stat-only": 0, skip: 0 } as Record<string, number>;
  for (const f of files) counts[f.decision]++;

  const lines: string[] = [];
  if (meta.scope === "ado-pr") {
    lines.push(`PR ${meta.prId} · ${meta.title}`);
    lines.push(
      `${meta.sourceBranch} -> ${meta.targetBranch} · ${meta.status}${meta.isDraft ? " (draft)" : ""}`,
    );
    lines.push(
      `iteration ${meta.iterationId}${meta.compareTo !== undefined ? ` (since ${meta.compareTo})` : ""}` +
        ` · source ${meta.sourceSHA.slice(0, 10)} · base ${meta.baseSHA.slice(0, 10)} · auth ${credSource}`,
    );
  } else {
    lines.push(`${meta.scope} · ${meta.title}`);
    lines.push(
      `source ${meta.sourceSHA.slice(0, 10)} · base ${meta.baseSHA.slice(0, 10)} · ${meta.repoRoot}`,
    );
  }
  lines.push(
    `files ${files.length}: review ${counts.review}, stat-only ${counts["stat-only"]}, skipped ${counts.skip}` +
      (meta.scope === "ado-pr" ? ` · existing threads ${threadCount}` : ""),
  );

  const notReviewed = files.filter((f) => f.decision !== "review");
  if (notReviewed.length > 0) {
    const grouped = new Map<string, number>();
    for (const f of notReviewed) grouped.set(f.reason, (grouped.get(f.reason) ?? 0) + 1);
    lines.push(
      `  not reviewed: ${[...grouped].map(([reason, n]) => `${reason} x${n}`).join(", ")}` +
        ` (listed in files.json, must be reported in the summary)`,
    );
  }
  if (ruleSources.length > 0) {
    lines.push(`  rules: ${ruleSources.join(", ")}`);
  }
  if (meta.scope === "ado-pr") {
    lines.push(`  policies: ${evidenceSummary(policies)}`);
    lines.push(`  PR statuses/builds: ${evidenceSummary(builds)}`);
  }

  lines.push("");
  lines.push(`batches ${batches.length} (highest risk first):`);
  for (const batch of batches) {
    lines.push(
      `  b${String(batch.id).padStart(2, "0")} risk ${batch.risk} · ${batch.files.length} files · ` +
        `~${batch.estTokens} tok${batch.needsPlan ? " · plan" : ""} · ${batch.label}`,
    );
  }
  lines.push("");
  lines.push(`run dir: ${meta.runDir}`);
  if (carried > 0) {
    lines.push(
      `carried over: ${carried} verdict(s) from an earlier pass over this revision ` +
        `(re-run with --reset to start clean)`,
    );
  }
  lines.push(`next: read ${meta.runDir}/payload/b01.md`);
  return lines.join("\n");
}
