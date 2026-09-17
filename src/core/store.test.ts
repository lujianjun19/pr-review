import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../util/proc.ts";
import { findLatestRun, RunStore } from "./store.ts";
import type { RunMeta } from "../types.ts";

async function gitRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  return root;
}

function meta(repoRoot: string, runDir: string): RunMeta {
  return {
    toolVersion: "test",
    createdAt: new Date().toISOString(),
    scope: "branch",
    repo: "repo",
    title: "test",
    sourceBranch: "feature",
    targetBranch: "main",
    sourceSHA: "a".repeat(40),
    targetSHA: "b".repeat(40),
    baseSHA: "c".repeat(40),
    repoRoot,
    runDir,
  };
}

test("findLatestRun refuses a run from another repository", async (t) => {
  const cache = await mkdtemp(join(tmpdir(), "prr-store-cache-"));
  const repoA = await gitRepo("prr-store-a-");
  const repoB = await gitRepo("prr-store-b-");
  const oldHome = process.env.PR_REVIEW_HOME;
  process.env.PR_REVIEW_HOME = cache;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.PR_REVIEW_HOME;
    else process.env.PR_REVIEW_HOME = oldHome;
    await rm(cache, { recursive: true, force: true });
    await rm(repoA, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  });

  const runA = join(cache, "run-a");
  await RunStore.create(meta(repoA, runA));
  assert.equal(await findLatestRun(repoA), runA);
  await assert.rejects(() => findLatestRun(repoB), /No prepared run matches/);
});

test("findLatestRun requires --dir outside a git repository", async (t) => {
  const cache = await mkdtemp(join(tmpdir(), "prr-store-cache-"));
  const repo = await gitRepo("prr-store-repo-");
  const outside = await mkdtemp(join(tmpdir(), "prr-store-outside-"));
  const oldHome = process.env.PR_REVIEW_HOME;
  process.env.PR_REVIEW_HOME = cache;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.PR_REVIEW_HOME;
    else process.env.PR_REVIEW_HOME = oldHome;
    await rm(cache, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  await RunStore.create(meta(repo, join(cache, "run")));
  await assert.rejects(() => findLatestRun(outside), /outside a git repository/);
});
