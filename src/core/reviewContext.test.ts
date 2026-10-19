import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../util/proc.ts";
import { computeRiskTier } from "./riskTier.ts";
import { guidanceForPath, isReviewConfiguration, selectGuidance } from "./guidance.ts";
import { htmlToText, intentExcerpt, PAYLOAD_INTENT_CAP, renderIntent } from "./intent.ts";
import {
  collectPriorFindings,
  fenceFor,
  findingMarker,
  parseFindingMarker,
  stripMarkers,
} from "./priorFindings.ts";
import { batchOptionsFor, buildBatches } from "./batch.ts";
import { loadRules, minSeverityForPath, parseRuleFile, rulesForPath } from "./rules.ts";
import { commitMessages, listTree } from "./git.ts";
import { renderPayload } from "./payload.ts";
import { commentBody } from "../commands/post.ts";
import type { ChangedFile, Finding, ReviewThread } from "../types.ts";

// Isolate from the developer's own ~/.config/pr-review/rules.json, which loadRules reads as the
// user layer: a test must not pass or fail depending on the machine it runs on.
process.env.XDG_CONFIG_HOME = join(tmpdir(), "prr-test-config-does-not-exist");

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    status: "edit",
    adds: 10,
    dels: 2,
    binary: false,
    category: "source",
    decision: "review",
    reason: "in-scope",
    risk: 8,
    tokens: 100,
    ...overrides,
  };
}

async function gitRepo(): Promise<{ root: string; git: (args: string[]) => Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), "prr-ctx-"));
  const git = (args: string[]) => run("git", args, { cwd: root });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "e@x"]);
  await git(["config", "user.name", "E"]);
  return { root, git };
}

async function put(root: string, path: string, content: string): Promise<void> {
  const full = join(root, path);
  await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await writeFile(full, content, "utf8");
}

// ---------------------------------------------------------------- risk tier

test("risk tier: docs and tests only is low, with a reason", () => {
  const tier = computeRiskTier([
    file("docs/guide.md", { category: "docs" }),
    file("src/app.test.ts", { category: "test" }),
  ]);
  assert.equal(tier.tier, "low");
  assert.equal(tier.approvers, 0);
  assert.match(tier.reasons[0], /docs\/test/);
});

test("risk tier: a security path, a migration or a very large change is high", () => {
  assert.equal(computeRiskTier([file("src/auth/session.ts", { signals: ["security"] })]).tier, "high");
  assert.equal(computeRiskTier([file("db/migrations/001_init.sql")]).tier, "high");
  assert.equal(computeRiskTier([file("src/a.ts", { adds: 900, dels: 200 })]).tier, "high");
  assert.equal(
    computeRiskTier([file(".ssh/id_rsa", { decision: "skip", reason: "secret-path", category: "secret" })]).tier,
    "high",
  );
});

test("risk tier: always-human paths lift a low change to standard", () => {
  const files = [file("docs/release.md", { category: "docs" })];
  assert.equal(computeRiskTier(files).tier, "low");
  const pinned = computeRiskTier(files, ["docs/release.md"]);
  assert.equal(pinned.tier, "standard");
  assert.equal(pinned.approvers, 1);
  assert.match(pinned.reasons.join(" "), /always-human path: docs\/release\.md/);
});

test("risk tier: ordinary source is standard", () => {
  const tier = computeRiskTier([file("src/orders/list.ts")]);
  assert.equal(tier.tier, "standard");
  assert.equal(tier.approvers, 1);
});

// ---------------------------------------------------------------- guidance

test("guidance: root files always apply, nested files only under their directory", () => {
  const tree = [
    "AGENTS.md",
    "REVIEW.md",
    ".github/copilot-instructions.md",
    "services/billing/AGENTS.md",
    "services/billing/REVIEW.md",
    "services/search/AGENTS.md",
    "services/billing/src/charge.ts",
  ];
  const refs = selectGuidance(tree, ["services/billing/src/charge.ts"]);
  assert.deepEqual(
    refs.map((r) => r.path),
    [".github/copilot-instructions.md", "AGENTS.md", "REVIEW.md", "services/billing/AGENTS.md", "services/billing/REVIEW.md"],
  );
  assert.equal(refs.find((r) => r.path === "services/billing/REVIEW.md")?.kind, "review");
  assert.ok(!refs.some((r) => r.path.startsWith("services/search")), "unrelated module guidance must not apply");

  const forOther = guidanceForPath("README.md", refs).map((r) => r.path);
  assert.ok(!forOther.includes("services/billing/AGENTS.md"));
  assert.ok(forOther.includes("AGENTS.md"));
});

test("guidance: edits to review configuration are recognized", () => {
  assert.ok(isReviewConfiguration(".pr-review/rules.json"));
  assert.ok(isReviewConfiguration("services/billing/REVIEW.md"));
  assert.ok(isReviewConfiguration("AGENTS.md"));
  assert.ok(!isReviewConfiguration("src/agents.ts"));
});

// ---------------------------------------------------------------- intent

test("intent: work item HTML becomes readable text", () => {
  assert.equal(
    htmlToText("<div>Do <b>this</b>&nbsp;&amp; that</div><ul><li>one</li><li>two</li></ul>"),
    "Do this & that\n\n- one\n- two",
  );
});

test("intent: renders title, description, work items and a capped excerpt", () => {
  const doc = renderIntent({
    title: "Disable checkout when the cart is empty",
    description: "Keeps the checkout button disabled.",
    workItems: [
      {
        id: 101,
        type: "User Story",
        state: "Active",
        title: "Block checkout for empty carts",
        acceptanceCriteria: "<ul><li>Checkout is disabled</li></ul>",
      },
    ],
  });
  assert.match(doc, /\*\*Title:\*\* Disable checkout/);
  assert.match(doc, /### #101 Block checkout for empty carts \(User Story, Active\)/);
  assert.match(doc, /- Checkout is disabled/);

  const long = renderIntent({ title: "t", description: "x".repeat(PAYLOAD_INTENT_CAP * 2) });
  const excerpt = intentExcerpt(long);
  assert.ok(excerpt.length < PAYLOAD_INTENT_CAP + 100);
  assert.match(excerpt, /full text is in intent\.md/);
});

test("intent: a work item failure is reported, not hidden", () => {
  const doc = renderIntent({ title: "t", description: "", workItemsError: "403 Forbidden" });
  assert.match(doc, /_\(empty\)_/);
  assert.match(doc, /Linked work items unavailable: 403 Forbidden/);
});

// ---------------------------------------------------------------- prior findings

const baseFinding: Finding = {
  id: "abc123def456",
  path: "src/app.ts",
  line: 3,
  severity: "high",
  category: "bug",
  problem: "Wrong comparison.",
  evidence: "const md = '```js';\nif (a == b) {",
  fix: "Use strict equality.",
  status: "verified",
  createdAt: new Date().toISOString(),
};

test("prior findings: the posted comment round-trips id, severity and evidence", () => {
  const body = commentBody({ ...baseFinding, rationale: "Loose equality coerces types." });
  assert.match(body, /_prr finding `abc123def456`_/);
  assert.match(body, /\*\*Why this was flagged\*\* Loose equality/);
  // Evidence containing a triple backtick needs a longer fence to stay intact.
  assert.equal(fenceFor(baseFinding.evidence), "````");
  const parsed = parseFindingMarker(body);
  assert.deepEqual(parsed, { id: "abc123def456", severity: "high", evidence: baseFinding.evidence });
  assert.equal(stripMarkers(body).includes("prr finding"), false);
});

test("prior findings: pre-existing comments are labelled as such", () => {
  const body = commentBody({ ...baseFinding, preExisting: true });
  assert.match(body.split("\n")[0], /🟣 \*\*Pre-existing\*\*.*not introduced by this pull request/);
  assert.equal(parseFindingMarker(body)?.severity, "high");
});

test("prior findings: recognizes prr threads and checks evidence at the new revision", async () => {
  const thread = (id: number, body: string, path = "src/app.ts", replies: string[] = []): ReviewThread => ({
    id,
    path,
    line: 3,
    status: "active",
    isDeleted: false,
    isBot: false,
    comments: [
      { author: "Reviewer", type: "text", body },
      ...replies.map((r) => ({ author: "Author", type: "text", body: r })),
      { author: "System", type: "system", body: "status changed" },
    ],
  });
  const threads = [
    thread(1, commentBody(baseFinding), "src/app.ts", ["Fixed in the next push."]),
    thread(2, commentBody({ ...baseFinding, id: "0000aaaa1111", evidence: "removed();" })),
    thread(3, "A human comment without a marker."),
  ];
  const prior = await collectPriorFindings(threads, async () => `x\n${baseFinding.evidence}\ny\n`);
  assert.equal(prior.length, 2);
  assert.equal(prior[0].findingId, "abc123def456");
  assert.equal(prior[0].evidenceStillPresent, true);
  assert.deepEqual(prior[0].replies, [{ author: "Author", body: "Fixed in the next push." }]);
  assert.equal(prior[1].evidenceStillPresent, false);
});

// ---------------------------------------------------------------- depth presets

test("depth presets: deep always plans and uses smaller batches; quick plans rarely", () => {
  const files = Array.from({ length: 8 }, (_, i) => file(`src/m/f${i}.ts`, { adds: 5, dels: 0 }));
  const deep = buildBatches(files, batchOptionsFor("deep"));
  assert.ok(deep.every((b) => b.files.length <= 6));
  assert.ok(deep.every((b) => b.needsPlan));
  const quick = buildBatches(files, batchOptionsFor("quick"));
  assert.equal(quick.length, 1);
  assert.equal(quick[0].needsPlan, false);
  assert.deepEqual(batchOptionsFor("standard").maxFiles, 10);
});

// ---------------------------------------------------------------- rules

test("rules: validation rejects malformed entries loudly", () => {
  assert.throws(() => parseRuleFile("[]", "r.json"), /JSON object/);
  assert.throws(() => parseRuleFile('{"rules":[{"path":"x"}]}', "r.json"), /needs "rule", "minSeverity"/);
  assert.throws(
    () => parseRuleFile('{"rules":[{"path":"x","minSeverity":"urgent"}]}', "r.json"),
    /minSeverity must be one of/,
  );
  assert.throws(() => parseRuleFile('{"maxLowFindings":-1}', "r.json"), /non-negative integer/);
  assert.throws(() => parseRuleFile('{"alwaysHuman":"src/**"}', "r.json"), /array of glob strings/);
});

test("rules: the project file is read from the base revision, not from the change", async (t) => {
  const { root, git } = await gitRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(
    root,
    ".pr-review/rules.json",
    JSON.stringify({
      rules: [{ path: "scripts/**", minSeverity: "high" }],
      maxLowFindings: 3,
      alwaysHuman: ["infra/**"],
    }),
  );
  await git(["add", "-A"]);
  await git(["commit", "-qm", "base"]);
  const base = (await git(["rev-parse", "HEAD"])).trim();

  // The change under review tries to exempt itself from review.
  await put(root, ".pr-review/rules.json", JSON.stringify({ exclude: ["**"] }));
  await git(["commit", "-qam", "change"]);

  const fromBase = await loadRules(root, undefined, { rev: base });
  assert.deepEqual(fromBase.exclude, []);
  assert.equal(fromBase.maxLowFindings, 3);
  assert.deepEqual(fromBase.alwaysHuman, ["infra/**"]);
  assert.match(fromBase.sources[0], /^\.pr-review\/rules\.json@/);
  assert.equal(minSeverityForPath("scripts/deploy.sh", fromBase), "high");

  const fromWorkingTree = await loadRules(root);
  assert.deepEqual(fromWorkingTree.exclude, ["**"], "the default still reads the working tree for authoring");
});

test("rules: a threshold-only entry keeps the built-in checklist", async (t) => {
  const { root, git } = await gitRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, ".pr-review/rules.json", JSON.stringify({ rules: [{ path: "**/*.test.ts", minSeverity: "medium" }] }));
  await git(["add", "-A"]);
  await git(["commit", "-qm", "base"]);
  const rules = await loadRules(root, undefined, { rev: "HEAD" });
  assert.match(rulesForPath("src/a.test.ts", rules)[0] ?? "", /assertions were strengthened/);
  assert.equal(minSeverityForPath("src/a.test.ts", rules), "medium");
});

// ---------------------------------------------------------------- git helpers and payload

test("payload: intent, guidance, thresholds and thread replies reach the reviewer", async (t) => {
  const { root, git } = await gitRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "AGENTS.md", "Use minor units for money.\n");
  await put(root, "src/REVIEW.md", "Always check tenant scoping.\n");
  await put(root, "src/app.ts", "export const a = 1;\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "base"]);
  const base = (await git(["rev-parse", "HEAD"])).trim();
  await put(root, "src/app.ts", "export const a = 2;\nexport const b = a == 2;\n");
  await git(["commit", "-qam", "Make b compare a\n\nRefs the spec."]);
  const head = (await git(["rev-parse", "HEAD"])).trim();

  assert.deepEqual(await commitMessages(root, base, head), ["Make b compare a\n\nRefs the spec."]);
  const tree = await listTree(root, base);
  const refs = selectGuidance(tree, ["src/app.ts"]);
  const contents = new Map([
    ["AGENTS.md", "Use minor units for money.\n"],
    ["src/REVIEW.md", "Always check tenant scoping.\n"],
  ]);

  const changed = file("src/app.ts", { minSeverity: "medium" });
  const posted = commentBody({ ...baseFinding, path: "src/app.ts", evidence: "export const b = a == 2;" });
  const payload = await renderPayload(
    { id: 1, label: "src", files: ["src/app.ts"], estTokens: 10, risk: 8, needsPlan: false, payload: "" },
    {
      repoRoot: root,
      baseSHA: base,
      sourceSHA: head,
      files: new Map([["src/app.ts", changed]]),
      threads: [
        {
          id: 7,
          path: "src/app.ts",
          line: 2,
          status: "active",
          isDeleted: false,
          isBot: false,
          comments: [
            { author: "Reviewer", type: "text", body: posted },
            { author: "Author", type: "text", body: "This is intentional; see the spec." },
          ],
        },
      ],
      depth: "deep",
      intent: "**Title:** Make b compare a",
      guidance: { refs, contents },
      priorFindings: [
        {
          threadId: 7,
          findingId: baseFinding.id,
          status: "active",
          evidenceStillPresent: true,
          replies: [{ author: "Author", body: "This is intentional; see the spec." }],
        },
      ],
    },
  );
  assert.match(payload, /Review depth: deep/);
  assert.match(payload, /## Stated intent[\s\S]*Make b compare a/);
  assert.match(payload, /Project guidance \(base revision[^)]*\): AGENTS\.md/);
  assert.match(payload, /Review instructions from src\/REVIEW\.md:\s+Always check tenant scoping\./);
  assert.match(payload, /Reporting threshold for this path: medium and above/);
  assert.match(payload, /thread 7 \[active\] \[prr finding abc123def456; evidence still present\]/);
  assert.match(payload, /↳ Author: This is intentional; see the spec\./);
  assert.doesNotMatch(payload, /_prr finding `/, "markers are stripped from excerpts");
});

test("intent: description headings are demoted, code blocks left alone", async () => {
  const { demoteHeadings } = await import("./intent.ts");
  assert.equal(
    demoteHeadings("## What\ntext\n```bash\n# install\n```\n# Why"),
    "##### What\ntext\n```bash\n# install\n```\n#### Why",
  );
});

test("guidance: nested .github instruction files apply by scope and applyTo", () => {
  const tree = [
    "web/.github/copilot-instructions.md",
    "web/.github/instructions/react.instructions.md",
    "web/.github/instructions/manual.instructions.md",
    "api/.github/copilot-instructions.md",
  ];
  const contents = new Map([
    ["web/.github/instructions/react.instructions.md", '---\ndescription: "React rules"\napplyTo: "**/*.{ts,tsx}"\n---\n# Rules'],
    ["web/.github/instructions/manual.instructions.md", "---\ndescription: attached by hand\n---\n# Manual"],
  ]);
  const refs = selectGuidance(tree, ["web/src/App.tsx", "web/README.md"], contents);
  assert.deepEqual(
    refs.map((r) => r.path).sort(),
    ["web/.github/copilot-instructions.md", "web/.github/instructions/react.instructions.md"],
  );
  const react = refs.find((r) => r.path.endsWith("react.instructions.md"))!;
  assert.equal(react.scope, "web");
  assert.deepEqual(react.applyTo, ["**/*.{ts,tsx}"]);
  assert.deepEqual(
    guidanceForPath("web/README.md", refs).map((r) => r.path),
    ["web/.github/copilot-instructions.md"],
    "applyTo limits an instructions file to matching paths",
  );
  assert.ok(isReviewConfiguration("web/.github/instructions/react.instructions.md"));
});

test("guidance: applyTo splits globs only outside brace alternations", async () => {
  const { parseApplyTo } = await import("./guidance.ts");
  assert.deepEqual(parseApplyTo('---\napplyTo: "**/*.{ts,tsx}, docs/**"\n---\n'), ["**/*.{ts,tsx}", "docs/**"]);
  assert.equal(parseApplyTo("# no front matter"), undefined);
});

test("risk paths: built-in signals are technical only; projects declare business areas", async (t) => {
  const { triage } = await import("./triage.ts");
  const change = { path: "src/ledger/settlement.ts", status: "edit" as const, adds: 10, dels: 0, binary: false };

  const plain = triage([change], new Map())[0];
  assert.equal(plain.signals, undefined, "business vocabulary is not built in");
  // Regression: the toolkit once boosted payment/billing/tax paths by default.
  for (const path of ["src/payments/charge.ts", "src/billing/invoice.ts", "src/tax/rates.ts"]) {
    const [file] = triage([{ ...change, path }], new Map());
    assert.equal(file.signals, undefined, `${path} must not get a built-in business signal`);
  }

  const { root, git } = await gitRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(
    root,
    ".pr-review/rules.json",
    JSON.stringify({ riskPaths: [{ path: "**/*{ledger,settlement}*/**", weight: 4, label: "money-movement" }] }),
  );
  await git(["add", "-A"]);
  await git(["commit", "-qm", "base"]);
  const rules = await loadRules(root, undefined, { rev: "HEAD" });
  const boosted = triage([change], new Map(), { maxFileTokens: 60_000, rules })[0];
  assert.deepEqual(boosted.signals, ["money-movement"]);
  assert.equal(boosted.risk, Math.round((plain.risk + 4) * 10) / 10);

  assert.throws(() => parseRuleFile('{"riskPaths":[{"path":"x","weight":0}]}', "r.json"), /weight must be a number from 1 to 10/);
  assert.throws(() => parseRuleFile('{"riskPaths":{}}', "r.json"), /"riskPaths" must be an array/);
});

test("risk paths: entries sharing a label count once, at the highest weight", async () => {
  const { riskPathsFor } = await import("./rules.ts");
  const riskPaths = [
    { path: "**/*ledger*/**", weight: 3, label: "money" },
    { path: "**/*ledger*", weight: 5, label: "money" },
    { path: "src/**", weight: 1 },
  ];
  const hits = riskPathsFor("src/ledger/ledgerPosting.ts", { riskPaths });
  assert.deepEqual(hits.map((h) => [h.label ?? h.path, h.weight]), [["money", 5], ["src/**", 1]]);
});
