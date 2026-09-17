import type { Batch, ChangedFile } from "../types.ts";

export interface BatchOptions {
  maxFiles: number;
  maxTokens: number;
  /** Largest single-file churn that triggers an explicit risk plan for the batch. */
  planFileLines: number;
  /** Combined churn across two or more files that triggers a risk plan. */
  planGroupLines: number;
}

export const DEFAULT_BATCH: BatchOptions = {
  maxFiles: 10,
  maxTokens: 25_000,
  planFileLines: 50,
  planGroupLines: 100,
};

/**
 * Minimum relatedness for a file to join an existing batch.
 *
 * Four is the score of two files in the same directory, which is the weakest
 * relationship still worth reviewing together.
 */
const MIN_AFFINITY = 4;

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Strips test and extension decorations so an implementation and its tests share a stem. */
function stemOf(path: string): string {
  let base = path.slice(path.lastIndexOf("/") + 1);
  base = base.replace(/\.(test|spec)\b/i, "");
  const dot = base.indexOf(".");
  if (dot > 0) base = base.slice(0, dot);
  return base.replace(/(Tests?|Spec)$/i, "").toLowerCase();
}

/** Nearest common ancestor directory, used to label a batch. */
function commonDir(paths: string[]): string {
  if (paths.length === 0) return "";
  const split = paths.map((p) => dirOf(p).split("/"));
  const first = split[0];
  let i = 0;
  for (; i < first.length; i++) {
    if (!split.every((parts) => parts[i] === first[i])) break;
  }
  return first.slice(0, i).join("/");
}

/**
 * Scores how strongly two files belong in the same review pass.
 *
 * Keeping related files together is what lets cross-file contracts be checked
 * inside one batch instead of across batches: an implementation reviewed
 * beside its tests and its siblings needs no follow-up read.
 *
 * Paths are compared relative to the prefix every changed file shares, so a
 * deep monorepo root cannot make two unrelated modules look adjacent.
 */
function affinity(a: ChangedFile, b: ChangedFile, rel: (path: string) => string): number {
  let score = 0;
  if (stemOf(a.path) === stemOf(b.path)) score += 6;
  const da = dirOf(rel(a.path));
  const db = dirOf(rel(b.path));
  if (da === db) score += 4;
  else if (da.startsWith(`${db}/`) || db.startsWith(`${da}/`)) score += 2;
  else {
    const shared = commonDir([rel(a.path), rel(b.path)]).split("/").filter(Boolean).length;
    score += Math.min(2, shared);
  }
  if (a.category === b.category) score += 1;
  return score;
}

/**
 * Partitions reviewable files into risk-ordered batches.
 *
 * Deterministic by construction: seeds come from the risk order, members are
 * pulled in by affinity, and both caps are hard. Batching only controls how
 * much is read at once; every reviewable file lands in exactly one batch, so
 * coverage is never traded away for size.
 */
export function buildBatches(
  files: ChangedFile[],
  opts: BatchOptions = DEFAULT_BATCH,
): Batch[] {
  const pool = files
    .filter((f) => f.decision === "review")
    .slice()
    .sort((a, b) => b.risk - a.risk || a.path.localeCompare(b.path));

  const remaining = new Set(pool.map((f) => f.path));
  const byPath = new Map(pool.map((f) => [f.path, f]));
  const batches: Batch[] = [];

  const globalPrefix = commonDir(pool.map((f) => f.path));
  const rel = (path: string): string =>
    globalPrefix && path.startsWith(`${globalPrefix}/`)
      ? path.slice(globalPrefix.length + 1)
      : path;

  while (remaining.size > 0) {
    const seed = pool.find((f) => remaining.has(f.path));
    if (!seed) break;
    remaining.delete(seed.path);

    const members = [seed];
    let tokens = seed.tokens;

    while (members.length < opts.maxFiles) {
      let best: { file: ChangedFile; score: number } | undefined;
      for (const path of remaining) {
        const candidate = byPath.get(path)!;
        if (tokens + candidate.tokens > opts.maxTokens) continue;
        const related = Math.max(...members.map((m) => affinity(m, candidate, rel)));
        // Relatedness is a gate, not a weight: a high-risk file that shares
        // nothing with the batch belongs in its own batch, where it gets
        // undivided attention, rather than diluting this one.
        if (related < MIN_AFFINITY) continue;
        const score = related + candidate.risk / 100;
        if (!best || score > best.score) best = { file: candidate, score };
      }
      if (!best) break;
      members.push(best.file);
      tokens += best.file.tokens;
      remaining.delete(best.file.path);
    }

    const maxFileLines = Math.max(...members.map((m) => m.adds + m.dels));
    const totalLines = members.reduce((sum, m) => sum + m.adds + m.dels, 0);
    batches.push({
      id: 0,
      label: commonDir(members.map((m) => m.path)) || members[0].path,
      files: members.map((m) => m.path),
      estTokens: tokens,
      risk: Math.max(...members.map((m) => m.risk)),
      needsPlan:
        maxFileLines >= opts.planFileLines ||
        (members.length >= 2 && totalLines >= opts.planGroupLines),
      payload: "",
    });
  }

  batches.sort((a, b) => b.risk - a.risk || a.label.localeCompare(b.label));

  const merged = mergeSiblings(batches, opts, rel);

  // Labels are meant to tell batches apart at a glance. The prefix every file
  // shares carries no information, so it is dropped from all of them.
  merged.forEach((batch, index) => {
    batch.id = index + 1;
    batch.payload = `payload/b${String(batch.id).padStart(2, "0")}.md`;
    if (globalPrefix && batch.label.startsWith(globalPrefix)) {
      batch.label = batch.label.slice(globalPrefix.length).replace(/^\//, "") || "(root)";
    }
    if (batch.files.length === 1) {
      const only = batch.files[0];
      batch.label = `${batch.label}/${only.slice(only.lastIndexOf("/") + 1)}`.replace(/^\//, "");
    }
  });
  return merged;
}

/**
 * Merges batches that sit in the same subtree while both caps still hold.
 *
 * Affinity-gated seeding produces correct but finely split batches, and each
 * extra batch costs a round trip. Merging neighbours recovers that cost
 * without mixing unrelated code: only batches whose directories are the same
 * or nested are candidates.
 */
function mergeSiblings(
  batches: Batch[],
  opts: BatchOptions,
  rel: (path: string) => string,
): Batch[] {
  const result = batches.slice();
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i];
        const b = result[j];
        if (a.files.length + b.files.length > opts.maxFiles) continue;
        if (a.estTokens + b.estTokens > opts.maxTokens) continue;
        const da = dirOf(rel(a.files[0]));
        const db = dirOf(rel(b.files[0]));
        const nested = da === db || da.startsWith(`${db}/`) || db.startsWith(`${da}/`);
        if (!nested) continue;

        const files = [...a.files, ...b.files];
        result[i] = {
          ...a,
          label: commonDir(files) || a.label,
          files,
          estTokens: a.estTokens + b.estTokens,
          risk: Math.max(a.risk, b.risk),
          needsPlan: a.needsPlan || b.needsPlan,
        };
        result.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return result;
}
