import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateDiff } from "./payload.ts";
import { locate } from "./locate.ts";
import { classify, riskScore, triage } from "./triage.ts";
import { buildBatches } from "./batch.ts";
import { parseGrepOutput } from "./git.ts";
import type { RawChange } from "./git.ts";
import type { ChangedFile } from "../types.ts";

function change(path: string, over: Partial<RawChange> = {}): RawChange {
  return { path, status: "edit", adds: 10, dels: 2, binary: false, ...over };
}

test("annotateDiff numbers added and context lines from the hunk header", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "index 111..222 100644",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -10,3 +10,4 @@ function f() {",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " return a;",
  ].join("\n");

  const out = annotateDiff(diff).split("\n");
  assert.equal(out[0].trim(), "@@ -10,3 +10,4 @@ function f() {");
  assert.equal(out[1], "   10 const a = 1;");
  // Removed lines carry no number: they do not exist in the reviewed revision.
  assert.equal(out[2], "    -|const b = 2;");
  assert.equal(out[3], "   11+const b = 3;");
  assert.equal(out[4], "   12+const c = 4;");
  assert.equal(out[5], "   13 return a;");
});

test("annotateDiff restarts numbering at every hunk", () => {
  const diff = [
    "@@ -1,1 +1,1 @@",
    "+first",
    "@@ -50,2 +80,2 @@",
    " context",
    "+second",
  ].join("\n");
  const out = annotateDiff(diff).split("\n");
  assert.equal(out[1], "    1+first");
  assert.equal(out[3], "   80 context");
  assert.equal(out[4], "   81+second");
});

test("locate finds a unique excerpt and ignores indentation", () => {
  const content = ["function f() {", "  const x = 1;", "  return x;", "}"].join("\n");
  assert.deepEqual(locate(content, "const x = 1;"), { startLine: 2, endLine: 2 });
  assert.deepEqual(locate(content, "const x = 1;\nreturn x;"), { startLine: 2, endLine: 3 });
});

test("locate declines rather than guessing when an excerpt repeats", () => {
  const content = ["if (!x) return;", "doWork();", "if (!x) return;"].join("\n");
  assert.equal(locate(content, "if (!x) return;"), "ambiguous");
});

test("locate reports a missing excerpt as not found", () => {
  assert.equal(locate("const a = 1;", "const b = 2;"), undefined);
});

test("classify separates tests, generated output and locks from source", () => {
  assert.equal(classify(change("src/app/user.ts")), "source");
  assert.equal(classify(change("src/app/__tests__/user.test.ts")), "test");
  assert.equal(classify(change("src/api/client.gen.go")), "generated");
  assert.equal(classify(change("package-lock.json")), "lock");
  assert.equal(classify(change("README.md")), "docs");
  assert.equal(classify(change("config/app.yaml")), "config");
  assert.equal(classify(change("certs/server.pem")), "secret");
  assert.equal(classify(change("logo.png", { binary: true })), "binary");
});

test("riskScore ranks a security path above an equally sized doc change", () => {
  const auth = riskScore(change("src/auth/token.ts"), "source");
  const doc = riskScore(change("docs/guide.md"), "docs");
  assert.ok(auth > doc, `${auth} should exceed ${doc}`);
});

test("triage never drops a file and always explains itself", () => {
  const changes = [
    change("src/a.ts"),
    change("yarn.lock"),
    change("keys/id_rsa"),
    change("img.png", { binary: true }),
    change("src/gone.ts", { status: "delete" }),
  ];
  const files = triage(changes, new Map());
  assert.equal(files.length, changes.length);
  assert.ok(files.every((f) => f.reason.length > 0));
  assert.deepEqual(
    files.map((f) => f.decision),
    ["review", "stat-only", "skip", "skip", "stat-only"],
  );
});

test("triage demotes a diff that cannot fit a review prompt", () => {
  const huge = triage([change("src/big.ts", { adds: 100_000, dels: 0 })], new Map());
  assert.equal(huge[0].decision, "stat-only");
  assert.equal(huge[0].reason, "diff-too-large");
});

function file(path: string, over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    status: "edit",
    adds: 10,
    dels: 1,
    binary: false,
    category: "source",
    decision: "review",
    reason: "in-scope",
    risk: 5,
    tokens: 500,
    ...over,
  };
}

test("buildBatches keeps an implementation with its test", () => {
  const batches = buildBatches([
    file("src/pay/charge.ts", { risk: 12 }),
    file("src/pay/__tests__/charge.test.ts", { category: "test", risk: 3 }),
    file("docs/unrelated.md", { category: "docs", risk: 1 }),
  ]);
  const withImpl = batches.find((b) => b.files.includes("src/pay/charge.ts"))!;
  assert.ok(withImpl.files.includes("src/pay/__tests__/charge.test.ts"));
  assert.ok(!withImpl.files.includes("docs/unrelated.md"));
});

test("buildBatches covers every reviewable file exactly once", () => {
  const files = Array.from({ length: 37 }, (_, i) =>
    file(`src/mod${i % 5}/file${i}.ts`, { risk: (i % 7) + 1, tokens: 3000 }),
  );
  const batches = buildBatches(files);
  const seen = batches.flatMap((b) => b.files);
  assert.equal(seen.length, new Set(seen).size, "no file appears twice");
  assert.deepEqual(new Set(seen), new Set(files.map((f) => f.path)));
});

test("buildBatches honours the file and token caps", () => {
  const files = Array.from({ length: 40 }, (_, i) =>
    file(`src/same/file${i}.ts`, { tokens: 4000 }),
  );
  const batches = buildBatches(files, {
    maxFiles: 10,
    maxTokens: 25_000,
    planFileLines: 50,
    planGroupLines: 100,
  });
  for (const batch of batches) {
    assert.ok(batch.files.length <= 10, `${batch.files.length} files exceeds the cap`);
    assert.ok(batch.estTokens <= 25_000 || batch.files.length === 1);
  }
});

test("buildBatches excludes files that are not reviewed", () => {
  const batches = buildBatches([
    file("src/a.ts"),
    file("yarn.lock", { decision: "stat-only", category: "lock" }),
    file("logo.png", { decision: "skip", category: "binary" }),
  ]);
  assert.deepEqual(batches.flatMap((b) => b.files), ["src/a.ts"]);
});

test("parseGrepOutput strips the revision prefix and keeps colons in the text", () => {
  const sha = "2faf7da948";
  const out = [
    `${sha}:src/app/user.ts:42:  const url = "https://example.com";`,
    `${sha}:src/app/user.ts:88:  return { a: 1 };`,
  ].join("\n");
  assert.deepEqual(parseGrepOutput(sha, out), [
    { path: "src/app/user.ts", line: 42, text: 'const url = "https://example.com";' },
    { path: "src/app/user.ts", line: 88, text: "return { a: 1 };" },
  ]);
});

test("parseGrepOutput ignores empty output and malformed lines", () => {
  assert.deepEqual(parseGrepOutput("abc123", ""), []);
  assert.deepEqual(parseGrepOutput("abc123", "abc123:src/a.ts"), []);
  assert.deepEqual(parseGrepOutput("abc123", "abc123:src/a.ts:notanumber:body"), []);
});
