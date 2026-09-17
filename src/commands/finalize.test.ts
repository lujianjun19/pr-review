import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../util/proc.ts";
import { RunStore } from "../core/store.ts";
import { note } from "./note.ts";
import { finalize } from "./finalize.ts";
import type { RunMeta } from "../types.ts";

/**
 * Builds a minimal run directory over a real one-commit repository, so
 * `finalize`'s evidence check has genuine source to resolve against.
 */
async function buildRun(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "prr-note-repo-"));
  const git = (args: string[]) => run("git", args, { cwd: repoRoot });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "e@x"]);
  await git(["config", "user.name", "E"]);
  await run("bash", ["-c", "echo 'export const q = () => qc.query(x);' > f.ts"], { cwd: repoRoot });
  await git(["add", "-A"]);
  await git(["commit", "-qm", "c"]);
  const sha = (await git(["rev-parse", "HEAD"])).trim();

  const meta: RunMeta = {
    toolVersion: "test",
    createdAt: new Date().toISOString(),
    scope: "branch",
    repo: "repo",
    title: "t",
    sourceBranch: "main",
    targetBranch: "main",
    sourceSHA: sha,
    targetSHA: sha,
    baseSHA: sha,
    repoRoot,
    runDir: await mkdtemp(join(tmpdir(), "prr-note-run-")),
  };
  const store = await RunStore.create(meta);
  await store.writeFiles([
    {
      path: "f.ts",
      status: "add",
      adds: 1,
      dels: 0,
      binary: false,
      category: "source",
      decision: "review",
      reason: "in-scope",
      risk: 5,
      tokens: 10,
    },
  ]);
  await store.appendVerdicts([{ path: "f.ts", batch: 1, verdict: "findings", at: new Date().toISOString() }]);

  return {
    dir: meta.runDir,
    cleanup: async () => {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(meta.runDir, { recursive: true, force: true });
    },
  };
}

test("a retracted finding is never resurrected by finalize's evidence check", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());

  const notePath = join(dir, "in.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    notePath,
    JSON.stringify({
      findings: [
        {
          path: "f.ts",
          severity: "high",
          category: "bug",
          problem: "qc.query is not a real method",
          evidence: "qc.query(x)",
          fix: "use fetchQuery",
          verification: {
            method: "runtime",
            detail: "synthetic regression fixture: assume the claim was checked before retraction",
          },
        },
      ],
    }),
    "utf8",
  );
  await note({ file: notePath, dir });

  const before = JSON.parse((await readFile(join(dir, "findings.jsonl"), "utf8")).trim());
  assert.equal(before.status, "candidate");

  // The evidence is genuine code, so an ordinary finalize verifies it.
  const firstPass = await finalize({ dir });
  assert.match(firstPass.output, /1 verified/);

  // Retracting must stick even though the evidence still resolves.
  await note({ file: notePath, dir }); // no-op: identical fingerprint, already recorded
  const retractPath = join(dir, "retract.json");
  await writeFile(retractPath, JSON.stringify({ retract: [before.id] }), "utf8");
  await note({ file: retractPath, dir });

  const afterRetract = JSON.parse((await readFile(join(dir, "findings.jsonl"), "utf8")).trim());
  assert.equal(afterRetract.status, "retracted");

  const secondPass = await finalize({ dir });
  assert.match(secondPass.output, /0 verified/);
  assert.match(secondPass.output, /1 retracted/);

  const stillRetracted = JSON.parse((await readFile(join(dir, "findings.jsonl"), "utf8")).trim());
  assert.equal(stillRetracted.status, "retracted", "finalize must not overturn a retraction");
});

test("note --retract rejects an unknown finding id", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  const { writeFile } = await import("node:fs/promises");
  const retractPath = join(dir, "retract.json");
  await writeFile(retractPath, JSON.stringify({ retract: ["doesnotexist"] }), "utf8");
  await assert.rejects(() => note({ file: retractPath, dir }), /is not a recorded finding id/);
});

test("dependency API claims require runtime, test, or declaration verification", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  const { writeFile } = await import("node:fs/promises");
  const notePath = join(dir, "dependency-claim.json");
  const finding = {
    path: "f.ts",
    severity: "high",
    category: "bug",
    problem: "queryClient.query does not exist on the dependency API.",
    evidence: "qc.query(x)",
    fix: "Use fetchQuery instead.",
  };
  await writeFile(notePath, JSON.stringify({ findings: [finding] }), "utf8");

  await assert.rejects(
    () => note({ file: notePath, dir }),
    /asserts something about a dependency's API surface/,
  );

  await writeFile(
    notePath,
    JSON.stringify({
      findings: [
        {
          ...finding,
          verification: {
            method: "runtime",
            detail: "node -e \"console.log(typeof new QueryClient().query)\" => function",
          },
        },
      ],
    }),
    "utf8",
  );
  await note({ file: notePath, dir });
  const stored = JSON.parse((await readFile(join(dir, "findings.jsonl"), "utf8")).trim());
  assert.deepEqual(stored.verification, {
    method: "runtime",
    detail: "node -e \"console.log(typeof new QueryClient().query)\" => function",
  });

  await finalize({ dir });
  const rendered = await finalize({ dir, render: true });
  assert.match(
    rendered.output,
    /Verification \(runtime\): node -e "console\.log\(typeof new QueryClient\(\)\.query\)" => function/,
  );
});

test("ordinary findings do not require dependency verification", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  const { writeFile } = await import("node:fs/promises");
  const notePath = join(dir, "ordinary.json");
  await writeFile(
    notePath,
    JSON.stringify({
      findings: [
        {
          path: "f.ts",
          severity: "medium",
          category: "bug",
          problem: "The condition uses the wrong value and skips valid rows.",
          evidence: "qc.query(x)",
          fix: "Compare the row value instead.",
        },
      ],
    }),
    "utf8",
  );
  await note({ file: notePath, dir });
  const stored = JSON.parse((await readFile(join(dir, "findings.jsonl"), "utf8")).trim());
  assert.equal(stored.status, "candidate");
  assert.equal(stored.verification, undefined);
});

test("finalize downgrades a persisted dependency claim that lacks verification", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  const store = await RunStore.open(dir);
  await store.appendFindings([
    {
      id: "legacy-record",
      path: "f.ts",
      severity: "high",
      category: "bug",
      problem: "qc.query does not exist on the dependency API.",
      evidence: "qc.query(x)",
      fix: "Use fetchQuery instead.",
      status: "candidate",
      createdAt: new Date().toISOString(),
    },
  ]);

  const result = await finalize({ dir });
  assert.match(result.output, /dependency API claim lacks/);
  assert.match(result.output, /0 verified, 1 not publishable/);

  const stored = JSON.parse((await readFile(join(dir, "findings.jsonl"), "utf8")).trim());
  assert.equal(stored.status, "unverified");
});
