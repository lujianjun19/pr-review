import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../util/proc.ts";
import type { ChangeStatus } from "../types.ts";

/**
 * Sentinel revision standing for the uncommitted working tree.
 *
 * A working-tree review has no commit to name, but every other part of the
 * toolkit is written against a revision. Rather than thread a second code path
 * through triage, payload and verification, the worktree is given a revision
 * identity here and the few git calls that cannot take it branch internally.
 */
export const WORKTREE = "WORKTREE";

export function isWorktree(rev: string): boolean {
  return rev === WORKTREE;
}

export interface RawChange {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  adds: number;
  dels: number;
  binary: boolean;
}

/** Resolves the repository root containing `cwd`. */
export async function repoRoot(cwd: string): Promise<string> {
  return run("git", ["rev-parse", "--show-toplevel"], { cwd });
}

export async function remoteUrl(cwd: string, name = "origin"): Promise<string> {
  return run("git", ["remote", "get-url", name], { cwd, allowFailure: true });
}

/** Resolves a ref to its commit id. */
export async function revParse(cwd: string, ref: string): Promise<string> {
  const sha = await run("git", ["rev-parse", ref], { cwd, allowFailure: true });
  if (!sha) throw new Error(`Cannot resolve "${ref}" in ${cwd}.`);
  return sha;
}

/** Returns the current branch name, or an empty string on a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string> {
  const name = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    allowFailure: true,
  });
  return name === "HEAD" ? "" : name;
}

/**
 * Resolves the merge base of two refs.
 *
 * A branch review must compare against the point the branch diverged, not
 * against the tip of the base: otherwise every commit landed on the base since
 * the branch started shows up as a change the author did not make.
 */
export async function mergeBase(cwd: string, base: string, head: string): Promise<string> {
  const sha = await run("git", ["merge-base", base, head], { cwd, allowFailure: true });
  if (!sha) {
    throw new Error(
      `No common ancestor between "${base}" and "${head}". ` +
        `Fetch the base branch first, or pass a ref that exists locally.`,
    );
  }
  return sha;
}

export async function hasCommit(cwd: string, sha: string): Promise<boolean> {
  const type = await run("git", ["cat-file", "-t", sha], { cwd, allowFailure: true });
  return type === "commit";
}

/**
 * Makes both pinned commits available locally.
 *
 * A shallow fetch of the two exact commits is enough for `git diff A B`, which
 * needs the trees rather than shared history, so a full clone or a deep
 * history fetch is never required. The credential is passed as a one-shot
 * http.extraHeader instead of being written to any git config.
 */
export async function fetchCommits(
  cwd: string,
  url: string,
  shas: string[],
  authHeader: string,
): Promise<void> {
  const missing: string[] = [];
  for (const sha of shas) {
    if (!(await hasCommit(cwd, sha))) missing.push(sha);
  }
  if (missing.length === 0) return;
  await run(
    "git",
    [
      "-c",
      `http.extraHeader=Authorization: ${authHeader}`,
      "fetch",
      "--depth=1",
      "--no-tags",
      "--quiet",
      url,
      ...missing,
    ],
    { cwd },
  );
}

function splitZ(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

const STATUS_MAP: Record<string, ChangeStatus> = {
  A: "add",
  M: "edit",
  D: "delete",
  R: "rename",
  C: "add",
  T: "edit",
};

/**
 * Lists the changes between two revisions with rename detection.
 *
 * numstat and name-status are read separately because numstat alone cannot
 * distinguish an add from a modify, and name-status alone carries no line
 * counts. Both are read in NUL-delimited form so paths containing spaces or
 * quotes survive intact.
 */
export async function listChanges(
  cwd: string,
  base: string,
  head: string,
): Promise<RawChange[]> {
  const range = isWorktree(head) ? [base] : [base, head];
  const numstatOut = await run("git", ["diff", "-M", "--numstat", "-z", ...range], { cwd });
  const nameStatusOut = await run("git", ["diff", "-M", "--name-status", "-z", ...range], {
    cwd,
  });

  const statusByPath = new Map<string, { status: ChangeStatus; oldPath?: string }>();
  const nsFields = splitZ(nameStatusOut);
  for (let i = 0; i < nsFields.length; ) {
    const code = nsFields[i++];
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = nsFields[i++];
      const newPath = nsFields[i++];
      statusByPath.set(newPath, { status: STATUS_MAP[letter] ?? "edit", oldPath });
    } else {
      const path = nsFields[i++];
      statusByPath.set(path, { status: STATUS_MAP[letter] ?? "edit" });
    }
  }

  const changes: RawChange[] = [];
  const nsNumstat = splitZ(numstatOut);
  for (let i = 0; i < nsNumstat.length; ) {
    const head3 = nsNumstat[i++];
    const parts = head3.split("\t");
    const adds = parts[0];
    const dels = parts[1];
    let path = parts[2] ?? "";
    let oldPath: string | undefined;
    if (path === "") {
      // Rename entries emit an empty third column followed by old and new paths.
      oldPath = nsNumstat[i++];
      path = nsNumstat[i++];
    }
    const meta = statusByPath.get(path);
    const binary = adds === "-" || dels === "-";
    changes.push({
      path,
      oldPath: oldPath ?? meta?.oldPath,
      status: meta?.status ?? "edit",
      adds: binary ? 0 : Number.parseInt(adds, 10) || 0,
      dels: binary ? 0 : Number.parseInt(dels, 10) || 0,
      binary,
    });
  }

  if (isWorktree(head)) changes.push(...(await listUntracked(cwd)));
  return changes;
}

/**
 * Lists untracked files as additions.
 *
 * `git diff` cannot see them, but a new file is exactly the kind of change a
 * review must not miss, so they are collected separately and measured with a
 * no-index diff against an empty file.
 */
async function listUntracked(cwd: string): Promise<RawChange[]> {
  const out = await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd,
    allowFailure: true,
  });
  const paths = splitZ(out);
  const changes: RawChange[] = [];
  for (const path of paths) {
    const numstat = await run(
      "git",
      ["diff", "--no-index", "--numstat", "--", "/dev/null", path],
      { cwd, allowFailure: true, okExitCodes: [1] },
    );
    const [adds, dels] = (numstat.split("\n")[0] ?? "").split("\t");
    const binary = adds === "-" || dels === "-";
    changes.push({
      path,
      status: "add",
      adds: binary ? 0 : Number.parseInt(adds ?? "", 10) || 0,
      dels: 0,
      binary,
    });
  }
  return changes;
}

/** Returns the unified diff of one path between two revisions. */
export async function fileDiff(
  cwd: string,
  base: string,
  head: string,
  path: string,
  context = 3,
): Promise<string> {
  if (isWorktree(head)) {
    const tracked = await run(
      "git",
      ["diff", "-M", `--unified=${context}`, base, "--", path],
      { cwd, allowFailure: true },
    );
    if (tracked) return tracked;
    // Untracked: compare against an empty file so the result is a normal diff.
    return run(
      "git",
      ["diff", "--no-index", `--unified=${context}`, "--", "/dev/null", path],
      { cwd, allowFailure: true, okExitCodes: [1] },
    );
  }
  return run(
    "git",
    ["diff", "-M", `--unified=${context}`, base, head, "--", path],
    { cwd, allowFailure: true },
  );
}

/** Returns file content at a revision, or an empty string when absent. */
export async function showFile(cwd: string, sha: string, path: string): Promise<string> {
  if (isWorktree(sha)) {
    try {
      return await readFile(join(cwd, path), "utf8");
    } catch {
      return "";
    }
  }
  return run("git", ["show", `${sha}:${path}`], { cwd, allowFailure: true });
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepOptions {
  /** Treat the pattern as an extended regular expression instead of a literal. */
  regex?: boolean;
  /** Limit the search to these pathspecs. */
  pathspec?: string[];
  max: number;
}

/**
 * Parses `git grep -n` output for a revision.
 *
 * Split from the process call so the fiddly part is testable: git prefixes
 * every line with the revision, and both the revision prefix and the path may
 * themselves contain colons, so the two separators have to be found in order
 * rather than by splitting the whole line.
 */
export function parseGrepOutput(sha: string, out: string): GrepMatch[] {
  if (!out) return [];
  const prefix = sha ? `${sha}:` : "";
  const matches: GrepMatch[] = [];
  for (const raw of out.split("\n")) {
    if (!raw) continue;
    const line = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    const first = line.indexOf(":");
    if (first < 0) continue;
    const second = line.indexOf(":", first + 1);
    if (second < 0) continue;
    const lineNumber = Number.parseInt(line.slice(first + 1, second), 10);
    if (!Number.isFinite(lineNumber)) continue;
    matches.push({
      path: line.slice(0, first),
      line: lineNumber,
      text: line.slice(second + 1).trim(),
    });
  }
  return matches;
}

/**
 * Searches the tree at a revision.
 *
 * Searching the revision rather than the working tree is not a detail: the
 * repository may hold nothing but the two fetched commits, with no checkout at
 * all, so an ordinary grep would find nothing. Binary files are skipped and
 * results are capped, because a search that returns everything is a search the
 * reader has to redo.
 */
export async function grepAtRev(
  cwd: string,
  sha: string,
  pattern: string,
  opts: GrepOptions,
): Promise<{ matches: GrepMatch[]; truncated: boolean }> {
  const args = ["grep", "-I", "-n", opts.regex ? "-E" : "-F", "-e", pattern];
  // Searching the worktree also covers files that are not committed yet.
  if (!isWorktree(sha)) args.push(sha);
  if (opts.pathspec && opts.pathspec.length > 0) args.push("--", ...opts.pathspec);

  const out = await run("git", args, { cwd, allowFailure: true });
  const matches = parseGrepOutput(isWorktree(sha) ? "" : sha, out);
  return { matches: matches.slice(0, opts.max), truncated: matches.length > opts.max };
}
