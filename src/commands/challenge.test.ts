import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../util/proc.ts";
import { RunStore } from "../core/store.ts";
import { note } from "./note.ts";
import { applySuppression, challengeRequired, finalize } from "./finalize.ts";
import type { ChangedFile, Finding, ReviewDepth, ReviewResult, RunMeta } from "../types.ts";

const SOURCE = [
  "export function total(a: number, b: number) {",
  "  if (a == b) return 0;",
  "  return a + b;",
  "}",
  "export const legacy = (x: any) => x.y.z;",
  "export const label = (n: number) => String(n);",
  "",
].join("\n");

async function buildRun(
  opts: { depth?: ReviewDepth; minSeverity?: ChangedFile["minSeverity"]; maxLowFindings?: number } = {},
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "prr-challenge-repo-"));
  const git = (args: string[]) => run("git", args, { cwd: repoRoot });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "e@x"]);
  await git(["config", "user.name", "E"]);
  await writeFile(join(repoRoot, "calc.ts"), SOURCE, "utf8");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "c"]);
  const sha = (await git(["rev-parse", "HEAD"])).trim();

  const meta: RunMeta = {
    toolVersion: "test",
    createdAt: new Date().toISOString(),
    scope: "branch",
    repo: "repo",
    title: "t",
    sourceBranch: "feature",
    targetBranch: "main",
    sourceSHA: sha,
    targetSHA: sha,
    baseSHA: sha,
    repoRoot,
    runDir: await mkdtemp(join(tmpdir(), "prr-challenge-run-")),
    ...(opts.depth ? { depth: opts.depth } : {}),
    ...(opts.maxLowFindings !== undefined ? { limits: { maxLowFindings: opts.maxLowFindings } } : {}),
    riskTier: { tier: "standard", approvers: 1, reasons: ["1 behavioural file(s)"] },
  };
  const store = await RunStore.create(meta);
  await store.writeFiles([
    {
      path: "calc.ts",
      status: "edit",
      adds: 6,
      dels: 0,
      binary: false,
      category: "source",
      decision: "review",
      reason: "in-scope",
      risk: 7,
      tokens: 60,
      ...(opts.minSeverity ? { minSeverity: opts.minSeverity } : {}),
    },
  ]);
  await store.appendVerdicts([{ path: "calc.ts", batch: 1, verdict: "findings", at: new Date().toISOString() }]);
  return {
    dir: meta.runDir,
    cleanup: async () => {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(meta.runDir, { recursive: true, force: true });
    },
  };
}

async function noteJson(dir: string, name: string, body: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(body), "utf8");
  return note({ file: path, dir });
}

async function findings(dir: string): Promise<Finding[]> {
  const text = await readFile(join(dir, "findings.jsonl"), "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Finding);
}

async function result(dir: string): Promise<ReviewResult> {
  return JSON.parse(await readFile(join(dir, "result.json"), "utf8")) as ReviewResult;
}

const HIGH = {
  path: "calc.ts",
  severity: "high",
  category: "bug",
  problem: "Loose equality treats equal totals as a refund case.",
  evidence: "if (a == b) return 0;",
  fix: "Use strict equality.",
  rationale: "== coerces; equal inputs return 0 instead of their sum.",
};

const PRE_EXISTING = {
  path: "calc.ts",
  severity: "medium",
  category: "bug",
  problem: "Unchecked property chain throws on missing y.",
  evidence: "export const legacy = (x: any) => x.y.z;",
  fix: "Guard the chain.",
  preExisting: true,
};

const LOW = {
  path: "calc.ts",
  severity: "low",
  category: "maintainability",
  problem: "Label ignores locale formatting.",
  evidence: "export const label = (n: number) => String(n);",
  fix: "Use toLocaleString.",
};

test("challenge gate: blocking findings need an independent challenge at standard depth", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  await noteJson(dir, "f.json", { findings: [HIGH] });

  const blocked = await finalize({ dir });
  assert.equal(blocked.ok, false);
  assert.match(blocked.output, /BLOCKED: 1 finding\(s\) need an independent challenge at depth standard/);
  assert.equal((await result(dir)).suggestedVerdict, "incomplete");

  const [recorded] = await findings(dir);
  const out = await noteJson(dir, "c.json", {
    challenges: [{ id: recorded.id, outcome: "confirmed", detail: "Traced: total(2,2) returns 0.", by: "subagent" }],
  });
  assert.match(out, /1 challenge\(s\): 1 confirmed/);

  const passed = await finalize({ dir });
  assert.equal(passed.ok, true, passed.output);
  const saved = await result(dir);
  assert.equal(saved.suggestedVerdict, "request-changes");
  assert.equal(saved.blocking, 1);
  assert.equal(saved.counts.high, 1);
  assert.equal(saved.riskTier?.tier, "standard");

  const rendered = await finalize({ dir, render: true });
  assert.match(rendered.output, /Why flagged: == coerces/);
  assert.match(rendered.output, /Challenge \(confirmed\): Traced/);
});

test("challenge: a refuted finding is retracted and an uncertain one goes to Open Questions", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  await noteJson(dir, "f.json", { findings: [HIGH, { ...LOW, severity: "medium" }] });
  const [high, medium] = await findings(dir);

  await noteJson(dir, "c.json", {
    challenges: [
      { id: high.id, outcome: "refuted", detail: "Callers never pass equal values; covered by a guard upstream." },
      { id: medium.id, outcome: "uncertain", detail: "Depends on whether labels are user-facing." },
    ],
  });
  const after = await findings(dir);
  assert.equal(after.find((f) => f.id === high.id)?.status, "retracted");
  assert.match(after.find((f) => f.id === high.id)?.retractReason ?? "", /guard upstream/);

  const report = await finalize({ dir });
  assert.equal(report.ok, true, report.output);
  assert.match(report.output, /1 unconfirmed/);
  assert.match(report.output, /independent challenge was uncertain/);
  const saved = await result(dir);
  assert.equal(saved.counts.unconfirmed, 1);
  assert.equal(saved.counts.retracted, 1);
  assert.equal(saved.suggestedVerdict, "needs-clarification");

  const rendered = await finalize({ dir, render: true });
  assert.match(rendered.output, /For Open Questions/);

  // Terminal outcomes cannot be challenged back into play.
  await assert.rejects(
    () => noteJson(dir, "c2.json", { challenges: [{ id: high.id, outcome: "confirmed", detail: "x" }] }),
    /terminal/,
  );
});

test("challenge input is validated", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  await noteJson(dir, "f.json", { findings: [HIGH] });
  const [high] = await findings(dir);
  await assert.rejects(
    () => noteJson(dir, "c.json", { challenges: [{ id: high.id, outcome: "maybe", detail: "x" }] }),
    /outcome/,
  );
  await assert.rejects(
    () => noteJson(dir, "c.json", { challenges: [{ id: high.id, outcome: "confirmed", detail: " " }] }),
    /detail/,
  );
  await assert.rejects(
    () => noteJson(dir, "c.json", { challenges: [{ id: "nope", outcome: "confirmed", detail: "x" }] }),
    /not a recorded finding id/,
  );
});

test("pre-existing findings never block the verdict and are rendered separately", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  await noteJson(dir, "f.json", { findings: [PRE_EXISTING] });

  const report = await finalize({ dir });
  assert.equal(report.ok, true, "pre-existing findings do not need a challenge");
  assert.match(report.output, /1 verified \(1 pre-existing\)/);
  const saved = await result(dir);
  assert.equal(saved.blocking, 0);
  assert.equal(saved.counts.preExisting, 1);
  assert.equal(saved.counts.medium, 0);
  assert.equal(saved.suggestedVerdict, "approve");

  const rendered = await finalize({ dir, render: true });
  assert.match(rendered.output, /No verified findings introduced by this change/);
  assert.match(rendered.output, /Pre-existing issues[\s\S]*🟣 \*\*Pre-existing\*\* \(Medium\)/);
});

test("suppression: path thresholds, quick depth and the Low cap hold findings back", async (t) => {
  await t.test("path threshold", async () => {
    const { dir, cleanup } = await buildRun({ minSeverity: "high" });
    try {
      await noteJson(dir, "f.json", { findings: [{ ...LOW, severity: "medium" }] });
      const report = await finalize({ dir });
      assert.match(report.output, /1 suppressed/);
      assert.match(report.output, /below the high threshold for this path/);
      assert.equal(report.ok, true, "suppressed findings need no challenge");
      assert.equal((await result(dir)).suggestedVerdict, "approve");
    } finally {
      await cleanup();
    }
  });

  await t.test("quick depth drops Low and skips the challenge gate", async () => {
    const { dir, cleanup } = await buildRun({ depth: "quick" });
    try {
      await noteJson(dir, "f.json", { findings: [HIGH, LOW] });
      const report = await finalize({ dir });
      assert.equal(report.ok, true, report.output);
      assert.match(report.output, /quick reviews report Medium and above/);
    } finally {
      await cleanup();
    }
  });

  await t.test("Low cap", async () => {
    const { dir, cleanup } = await buildRun({ maxLowFindings: 0 });
    try {
      await noteJson(dir, "f.json", { findings: [LOW] });
      const report = await finalize({ dir });
      assert.match(report.output, /over the cap of 0 Low findings/);
      const rendered = await finalize({ dir, render: true });
      assert.match(rendered.output, /1 verified finding\(s\) were suppressed/);
    } finally {
      await cleanup();
    }
  });

  await t.test("deep depth challenges Low findings too", async () => {
    const { dir, cleanup } = await buildRun({ depth: "deep" });
    try {
      await noteJson(dir, "f.json", { findings: [LOW] });
      const report = await finalize({ dir });
      assert.equal(report.ok, false);
      assert.match(report.output, /need an independent challenge at depth deep/);
    } finally {
      await cleanup();
    }
  });
});

test("suppression is recomputed, not sticky", () => {
  const base: Finding = {
    id: "1",
    path: "a.ts",
    severity: "low",
    category: "bug",
    problem: "p",
    evidence: "e",
    fix: "f",
    status: "verified",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const files = [{ path: "a.ts", minSeverity: "medium" } as ChangedFile];
  const [suppressed] = applySuppression([base], files, {});
  assert.equal(suppressed.status, "suppressed");
  const [kept] = applySuppression([base], [{ path: "a.ts" } as ChangedFile], {});
  assert.equal(kept.status, "verified");

  assert.equal(challengeRequired("standard", { ...base, severity: "medium" }), true);
  assert.equal(challengeRequired("standard", base), false);
  assert.equal(challengeRequired("deep", base), true);
  assert.equal(challengeRequired("deep", { ...base, preExisting: true }), false);
  assert.equal(challengeRequired("quick", { ...base, severity: "critical" }), false);
});

test("regression: duplicates and severity corrections apply to recorded findings", async (t) => {
  const { dir, cleanup } = await buildRun();
  t.after(() => cleanup());
  await noteJson(dir, "f.json", { findings: [HIGH, { ...LOW, severity: "medium" }] });
  const [high, medium] = await findings(dir);

  // Re-noting with a different status or severity is ignored by fingerprint, which is why
  // explicit corrections exist.
  await noteJson(dir, "again.json", { findings: [{ ...HIGH, status: "duplicate", severity: "low" }] });
  assert.equal((await findings(dir)).find((f) => f.id === high.id)?.status, "candidate");

  const out = await noteJson(dir, "fix.json", {
    duplicates: [{ id: high.id, thread: 4242 }],
    reclassify: [{ id: medium.id, severity: "low" }],
  });
  assert.match(out, /1 marked duplicate, 1 reclassified/);
  const after = await findings(dir);
  assert.equal(after.find((f) => f.id === high.id)?.status, "duplicate");
  assert.equal(after.find((f) => f.id === high.id)?.dupOfThread, 4242);
  assert.equal(after.find((f) => f.id === medium.id)?.severity, "low");

  const report = await finalize({ dir });
  assert.equal(report.ok, true, "a duplicate needs no challenge and a Low needs none at standard depth");
  assert.match(report.output, /1 marked duplicate/);

  await assert.rejects(
    () => noteJson(dir, "bad.json", { reclassify: [{ id: high.id, severity: "low" }] }),
    /terminal/,
  );
  await assert.rejects(
    () => noteJson(dir, "bad2.json", { duplicates: [{ id: medium.id, thread: 0 }] }),
    /existing thread/,
  );
});
