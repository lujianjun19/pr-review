import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../core/store.ts";
import { noteBatch } from "./note.ts";
import type { Batch, RunMeta } from "../types.ts";

async function buildRun(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "prr-batch-note-"));
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
  const store = await RunStore.create(meta);
  const batch: Batch = {
    id: 2,
    label: "src",
    files: ["src/a.ts", "src/a.test.ts", "src/b.ts"],
    estTokens: 100,
    risk: 5,
    needsPlan: false,
    payload: "payload/b02.md",
  };
  await store.writeBatches([batch]);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("noteBatch marks a batch clean with explicit exceptions", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  const output = await noteBatch({
    dir,
    batch: 2,
    allClean: true,
    exceptions: new Map([["src/b.ts", "findings"]]),
  });
  assert.match(output, /recorded 3 verdict/);

  const verdicts = await RunStore.open(dir).then((store) => store.readVerdicts());
  assert.deepEqual(
    verdicts.map((v) => [v.path, v.verdict]),
    [
      ["src/a.ts", "clean"],
      ["src/a.test.ts", "clean"],
      ["src/b.ts", "findings"],
    ],
  );
});

test("noteBatch is idempotent and refuses to erase a non-clean verdict", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  await noteBatch({
    dir,
    batch: 2,
    allClean: true,
    exceptions: new Map([["src/b.ts", "findings"]]),
  });
  const second = await noteBatch({
    dir,
    batch: 2,
    allClean: true,
    exceptions: new Map([["src/b.ts", "findings"]]),
  });
  assert.match(second, /0 verdict\(s\), 3 already identical/);

  await assert.rejects(
    () => noteBatch({ dir, batch: 2, allClean: true, exceptions: new Map() }),
    /Refusing to change src\/b\.ts from "findings" to "clean"/,
  );
});

test("noteBatch rejects an exception outside the batch", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  await assert.rejects(
    () =>
      noteBatch({
        dir,
        batch: 2,
        allClean: true,
        exceptions: new Map([["src/other.ts", "findings"]]),
      }),
    /is not in batch 2/,
  );
});
