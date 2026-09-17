import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../util/proc.ts";
import {
  WORKTREE,
  fileDiff,
  grepAtRev,
  listChanges,
  mergeBase,
  revParse,
  showFile,
} from "../core/git.ts";
import { annotateDiff } from "../core/payload.ts";
import { triage } from "../core/triage.ts";
import { buildBatches } from "../core/batch.ts";
import { locate, resolveEvidence } from "../core/locate.ts";

/**
 * End-to-end checks of the deterministic layer against a real repository.
 *
 * What this measures is worth stating plainly: it exercises selection,
 * batching, line annotation and evidence verification, which are the parts
 * that are supposed to be mechanical. It says nothing about how many real
 * defects a reviewer finds — that depends on the model, and claiming otherwise
 * from a fixture would be dishonest.
 */

const BASE_FILES: Record<string, string> = {
  "src/pay/charge.ts": [
    "export function charge(order: Order, card: Card): Receipt {",
    "  const total = order.total;",
    "  return gateway.charge(card, total);",
    "}",
  ].join("\n"),
  "src/pay/__tests__/charge.test.ts": [
    'import { charge } from "../charge";',
    "",
    'test("charges the total", () => {',
    "  expect(charge(order, card).amount).toBe(100);",
    "});",
  ].join("\n"),
  "src/auth/token.ts": ["export function verify(token: string): boolean {", "  return true;", "}"].join(
    "\n",
  ),
  "docs/guide.md": "# Guide\n\nHow to use the thing.\n",
  "package-lock.json": '{\n  "lockfileVersion": 3\n}\n',
  "src/generated/api.gen.ts": "export type Api = { v: 1 };\n",
};

const HEAD_FILES: Record<string, string> = {
  "src/pay/charge.ts": [
    "export function charge(order: Order, card: Card): Receipt {",
    "  const total = order.total;",
    "  if (order.refunded === total) {",
    "    return gateway.refund(card, total);",
    "  }",
    "  return gateway.charge(card, total);",
    "}",
  ].join("\n"),
  "src/pay/__tests__/charge.test.ts": [
    'import { charge } from "../charge";',
    "",
    'test("charges the total", () => {',
    "  expect(charge(order, card).amount).toBe(100);",
    "});",
    "",
    'test("refunds when already refunded", () => {',
    "  expect(charge(refundedOrder, card).kind).toBe(\"refund\");",
    "});",
  ].join("\n"),
  "src/auth/token.ts": [
    "export function verify(token: string): boolean {",
    "  return decode(token).exp > Date.now();",
    "}",
  ].join("\n"),
  "docs/guide.md": "# Guide\n\nHow to use the thing, now with refunds.\n",
  "package-lock.json": '{\n  "lockfileVersion": 3,\n  "bumped": true\n}\n',
  "src/generated/api.gen.ts": "export type Api = { v: 2 };\n",
  "src/pay/refund.ts": ["export function refund(order: Order): number {", "  return order.total;", "}"].join(
    "\n",
  ),
};

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, `${content}\n`, "utf8");
  }
}

interface Fixture {
  root: string;
  base: string;
  head: string;
  cleanup: () => Promise<void>;
}

async function buildFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "prr-eval-"));
  const git = (args: string[]) => run("git", args, { cwd: root });

  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "eval@example.com"]);
  await git(["config", "user.name", "Eval"]);
  await git(["config", "commit.gpgsign", "false"]);

  await writeTree(root, BASE_FILES);
  await git(["add", "-A"]);
  await git(["commit", "-qm", "base"]);
  const base = await revParse(root, "HEAD");

  await git(["checkout", "-qb", "feature"]);
  await writeTree(root, HEAD_FILES);
  await git(["add", "-A"]);
  await git(["commit", "-qm", "feature"]);
  const head = await revParse(root, "HEAD");

  return { root, base, head, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("eval: selection, batching, annotation and verification on a real repository", async (t) => {
  const fixture = await buildFixture();
  t.after(() => fixture.cleanup());
  const { root, base, head } = fixture;

  await t.test("merge base is the divergence point, not the base tip", async () => {
    assert.equal(await mergeBase(root, "main", "feature"), base);
  });

  const changes = await listChanges(root, base, head);
  const files = triage(changes, new Map());

  await t.test("every changed file is accounted for exactly once", () => {
    assert.equal(files.length, changes.length);
    assert.equal(new Set(files.map((f) => f.path)).size, files.length);
  });

  await t.test("triage routes each file by what it is", () => {
    const decisionOf = (path: string) => files.find((f) => f.path === path)?.decision;
    assert.equal(decisionOf("src/pay/charge.ts"), "review");
    assert.equal(decisionOf("src/pay/refund.ts"), "review");
    assert.equal(decisionOf("src/auth/token.ts"), "review");
    assert.equal(decisionOf("package-lock.json"), "stat-only");
    assert.equal(decisionOf("src/generated/api.gen.ts"), "stat-only");
  });

  await t.test("the security-sensitive file outranks the documentation change", () => {
    const risk = (path: string) => files.find((f) => f.path === path)?.risk ?? 0;
    assert.ok(risk("src/auth/token.ts") > risk("docs/guide.md"));
  });

  const batches = buildBatches(files);

  await t.test("batching covers every reviewable file", () => {
    const reviewable = files.filter((f) => f.decision === "review").map((f) => f.path).sort();
    const batched = batches.flatMap((b) => b.files).sort();
    assert.deepEqual(batched, reviewable);
  });

  await t.test("an implementation is batched with its test", () => {
    const batch = batches.find((b) => b.files.includes("src/pay/charge.ts"));
    assert.ok(batch, "charge.ts must be batched");
    assert.ok(batch.files.includes("src/pay/__tests__/charge.test.ts"));
  });

  await t.test("every annotated line number matches the source revision", async () => {
    let checked = 0;
    for (const file of files.filter((f) => f.decision === "review")) {
      const diff = await fileDiff(root, base, head, file.path);
      const actual = (await showFile(root, head, file.path)).split("\n");
      for (const line of annotateDiff(diff).split("\n")) {
        const match = /^\s*(\d+)([+ ])(.*)$/.exec(line);
        if (!match) continue;
        const number = Number.parseInt(match[1], 10);
        assert.equal(
          actual[number - 1],
          match[3],
          `${file.path}:${number} disagrees with the source revision`,
        );
        checked++;
      }
    }
    assert.ok(checked > 20, `expected a meaningful sample, annotated ${checked} lines`);
  });

  await t.test("verification accepts true evidence and resolves its line", async () => {
    const result = await resolveEvidence(
      root,
      head,
      "src/pay/charge.ts",
      "if (order.refunded === total) {",
      files.map((f) => f.path),
    );
    assert.equal(result.outcome, "resolved");
    assert.equal(result.location?.startLine, 3);
  });

  await t.test("verification rejects evidence that is not in the revision", async () => {
    const result = await resolveEvidence(
      root,
      head,
      "src/pay/charge.ts",
      "const fee = total * 0.03;",
      files.map((f) => f.path),
    );
    assert.equal(result.outcome, "not-found");
  });

  await t.test("verification re-files a finding onto the file its evidence comes from", async () => {
    const result = await resolveEvidence(
      root,
      head,
      "src/pay/charge.ts",
      "export function refund(order: Order): number {",
      files.map((f) => f.path),
    );
    assert.equal(result.outcome, "relocated");
    assert.equal(result.relocatedTo, "src/pay/refund.ts");
  });

  await t.test("search reads the revision and caps its output", async () => {
    const { matches } = await grepAtRev(root, head, "gateway", { max: 100 });
    assert.ok(matches.length >= 2);
    assert.ok(matches.every((m) => m.path === "src/pay/charge.ts"));

    const capped = await grepAtRev(root, head, "e", { max: 1 });
    assert.equal(capped.matches.length, 1);
    assert.equal(capped.truncated, true);
  });
});

test("eval: working-tree scope sees uncommitted and untracked work", async (t) => {
  const fixture = await buildFixture();
  t.after(() => fixture.cleanup());
  const { root, head } = fixture;

  await writeFile(
    join(root, "src/pay/charge.ts"),
    `${HEAD_FILES["src/pay/charge.ts"]}\n// uncommitted edit\n`,
    "utf8",
  );
  await writeFile(join(root, "src/pay/fees.ts"), "export const FEE = 0.03;\n", "utf8");

  const changes = await listChanges(root, head, WORKTREE);
  const paths = changes.map((c) => c.path).sort();

  await t.test("modified and untracked files are both in scope", () => {
    assert.deepEqual(paths, ["src/pay/charge.ts", "src/pay/fees.ts"]);
    assert.equal(changes.find((c) => c.path === "src/pay/fees.ts")?.status, "add");
  });

  await t.test("an untracked file still produces an annotated diff", async () => {
    const diff = await fileDiff(root, head, WORKTREE, "src/pay/fees.ts");
    const annotated = annotateDiff(diff);
    assert.match(annotated, /1\+export const FEE = 0\.03;/);
  });

  await t.test("evidence is verified against the file on disk", async () => {
    const content = await showFile(root, WORKTREE, "src/pay/fees.ts");
    assert.deepEqual(locate(content, "export const FEE = 0.03;"), { startLine: 1, endLine: 1 });
  });
});
