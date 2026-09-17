import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../core/store.ts";
import { recordExec } from "./recordExec.ts";
import type { RunMeta } from "../types.ts";

async function buildRun(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "prr-exec-"));
  const meta: RunMeta = {
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
    repoRoot: dir,
    runDir: dir,
  };
  await RunStore.create(meta);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("recordExec records argv, exit status and redacted output", async (t) => {
  const { dir, cleanup } = await buildRun();
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  t.after(async () => {
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
    await cleanup();
  });

  const result = await recordExec({
    dir,
    command: [
      process.execPath,
      "-e",
      "console.log(process.env.GITHUB_TOKEN); console.error('PASSWORD=hunter2')",
    ],
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /recorded:/);

  const records = await RunStore.open(dir).then((store) => store.readValidations());
  assert.equal(records.length, 1);
  assert.equal(records[0].exitCode, 0);
  assert.equal(records[0].sourceSHA, "a".repeat(40));
  assert.doesNotMatch(records[0].stdout, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(records[0].stdout, /REDACTED/);
  assert.equal(records[0].stderr, "PASSWORD=[REDACTED]");
});

test("recordExec preserves a failing command's exit code", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  const result = await recordExec({
    dir,
    command: [process.execPath, "-e", "console.error('failed check'); process.exit(7)"],
  });
  assert.equal(result.exitCode, 7);
  const records = await RunStore.open(dir).then((store) => store.readValidations());
  assert.equal(records[0].exitCode, 7);
  assert.equal(records[0].stderr, "failed check");
});

test("recordExec times out and records exit code 124", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  const result = await recordExec({
    dir,
    timeoutSeconds: 0.01,
    command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
  });
  assert.equal(result.exitCode, 124);
  const records = await RunStore.open(dir).then((store) => store.readValidations());
  assert.equal(records[0].timedOut, true);
});
