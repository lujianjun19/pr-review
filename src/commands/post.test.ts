import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../core/store.ts";
import { post } from "./post.ts";
import type { Finding, RunMeta } from "../types.ts";

process.env.AZURE_DEVOPS_EXT_PAT = "test-token";

async function buildAdoRun(finding?: Finding): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "prr-post-run-"));
  const meta: RunMeta = {
    toolVersion: "test",
    createdAt: new Date().toISOString(),
    scope: "ado-pr",
    org: "contoso",
    project: "Platform",
    repo: "portal-api",
    repoId: "repo-id",
    prId: 42,
    title: "Test PR",
    author: "Reviewer",
    isDraft: false,
    status: "active",
    sourceBranch: "feature/test",
    targetBranch: "main",
    iterationId: 3,
    sourceSHA: "a".repeat(40),
    targetSHA: "b".repeat(40),
    baseSHA: "c".repeat(40),
    repoRoot: dir,
    webUrl: "https://dev.azure.com/contoso/Platform/_git/portal-api/pullrequest/42",
    runDir: dir,
  };
  const store = await RunStore.create(meta);
  await store.writeFiles([]);
  if (finding) await store.appendFindings([finding]);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function retractedFinding(): Finding {
  return {
    id: "deadbeef1234",
    path: "src/app.ts",
    line: 7,
    severity: "high",
    category: "bug",
    problem: "This claim was wrong.",
    evidence: "client.method()",
    fix: "No change needed.",
    status: "retracted",
    batch: 1,
    createdAt: new Date().toISOString(),
  };
}

test("post --retract replies to and closes the posted thread exactly once", async (t) => {
  const finding = retractedFinding();
  const { dir, cleanup } = await buildAdoRun(finding);
  t.after(() => cleanup());
  await writeFile(join(dir, "posted.json"), JSON.stringify({ [finding.id]: 99 }), "utf8");

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return jsonResponse({ id: 2, status: "closed" });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const output = await post({ dir, retract: [finding.id] });
  assert.match(output, /corrected and closed/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /threads\/99\/comments/);
  assert.match(String((calls[0].body as { content: string }).content), /finding is incorrect/);
  assert.equal(calls[1].method, "PATCH");
  assert.match(calls[1].url, /threads\/99\?/);
  assert.deepEqual(calls[1].body, { status: "closed" });

  const ledger = JSON.parse(await readFile(join(dir, "posted.json"), "utf8")) as Record<string, number>;
  assert.equal(ledger[`retracted:${finding.id}`], 99);

  calls.length = 0;
  const second = await post({ dir, retract: [finding.id] });
  assert.match(second, /already corrected and closed/);
  assert.equal(calls.length, 0, "idempotent retry must not add a second correction reply");
});

test("post --retract requires the local finding to be retracted first", async (t) => {
  const finding = { ...retractedFinding(), status: "verified" as const };
  const { dir, cleanup } = await buildAdoRun(finding);
  t.after(() => cleanup());
  await writeFile(join(dir, "posted.json"), JSON.stringify({ [finding.id]: 99 }), "utf8");

  await assert.rejects(
    () => post({ dir, retract: [finding.id] }),
    /Mark it retracted first/,
  );
});

test("post --update-summary appends one correction and deduplicates identical text", async (t) => {
  const { dir, cleanup } = await buildAdoRun();
  t.after(() => cleanup());
  await writeFile(join(dir, "posted.json"), JSON.stringify({ __summary__: 77 }), "utf8");
  const summary = join(dir, "summary.md");
  await writeFile(summary, "## Corrected summary\n\n2 Medium findings remain.\n", "utf8");

  const calls: { url: string; method: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return jsonResponse({ id: 3 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const first = await post({ dir, updateSummary: true, summaryFile: summary });
  assert.match(first, /summary correction appended to thread 77/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /threads\/77\/comments/);

  calls.length = 0;
  const second = await post({ dir, updateSummary: true, summaryFile: summary });
  assert.match(second, /already posted/);
  assert.equal(calls.length, 0);
});

test("post --update-summary requires corrected summary text", async (t) => {
  const { dir, cleanup } = await buildAdoRun();
  t.after(() => cleanup());
  await assert.rejects(
    () => post({ dir, updateSummary: true }),
    /requires --summary/,
  );
});

test("ordinary post reports retracted findings separately from unpublishable findings", async (t) => {
  const finding = retractedFinding();
  const { dir, cleanup } = await buildAdoRun(finding);
  t.after(() => cleanup());

  const output = await post({ dir, dryRun: true, minSeverity: "low" });
  assert.match(output, /0 not publishable, 1 duplicate\/retracted/);
});

test("post rejects combining retraction and summary update writes", async (t) => {
  const finding = retractedFinding();
  const { dir, cleanup } = await buildAdoRun(finding);
  t.after(() => cleanup());
  await assert.rejects(
    () => post({ dir, retract: [finding.id], updateSummary: true, summaryFile: "x.md" }),
    /separate write actions/,
  );
});

test("a newly posted summary records its content hash for later update deduplication", async (t) => {
  const { dir, cleanup } = await buildAdoRun();
  t.after(() => cleanup());
  const summary = join(dir, "summary.md");
  await writeFile(summary, "## Summary\n\nNo findings.\n", "utf8");

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse({ id: 88 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const first = await post({ dir, summaryFile: summary });
  assert.match(first, /summary comment posted as thread 88/);
  assert.equal(calls, 1);

  calls = 0;
  const second = await post({ dir, updateSummary: true, summaryFile: summary });
  assert.match(second, /already posted/);
  assert.equal(calls, 0);
});
