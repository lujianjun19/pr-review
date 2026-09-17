import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesGlob } from "./glob.ts";
import { loadRules, rulesForPath, isExcludedByRules } from "./rules.ts";

test("matchesGlob handles the patterns rules are written with", () => {
  assert.ok(matchesGlob("src/app/user.ts", "**/*.ts"));
  assert.ok(matchesGlob("user.ts", "**/*.ts"));
  assert.ok(matchesGlob("src/app/user.test.ts", "**/*.{test,spec}.ts"));
  assert.ok(!matchesGlob("src/app/user.ts", "**/*.{test,spec}.ts"));

  assert.ok(matchesGlob("db/migrations/001_init.sql", "**/migrations/**"));
  assert.ok(matchesGlob("migrations/001_init.sql", "**/migrations/**"));
  assert.ok(!matchesGlob("db/migrationsX/001.sql", "**/migrations/**"));

  // A single star must not cross a directory separator.
  assert.ok(matchesGlob("src/user.ts", "src/*.ts"));
  assert.ok(!matchesGlob("src/app/user.ts", "src/*.ts"));

  // A bare name matches at any depth, as gitignore does.
  assert.ok(matchesGlob("a/b/package-lock.json", "package-lock.json"));

  // A trailing slash means everything underneath.
  assert.ok(matchesGlob("dist/main.js", "dist/"));
  assert.ok(!matchesGlob("distant/main.js", "dist/"));

  // Regex metacharacters in a path must not be interpreted.
  assert.ok(matchesGlob("src/a.b.ts", "src/a.b.ts"));
  assert.ok(!matchesGlob("src/axbxts", "src/a.b.ts"));
});

async function withRepo(
  ruleFile: unknown | undefined,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "prr-rules-"));
  try {
    if (ruleFile !== undefined) {
      await mkdir(join(root, ".pr-review"), { recursive: true });
      await writeFile(
        join(root, ".pr-review", "rules.json"),
        JSON.stringify(ruleFile, null, 2),
        "utf8",
      );
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a project rule replaces the built-in for the paths it claims", async () => {
  await withRepo(
    {
      rules: [
        { path: "**/*.{test,spec}.ts", rule: "Tests must assert on behaviour, not on call counts." },
      ],
    },
    async (root) => {
      const resolved = await loadRules(root);
      assert.deepEqual(rulesForPath("src/a.test.ts", resolved), [
        "Tests must assert on behaviour, not on call counts.",
      ]);
    },
  );
});

test("mergeBuiltin keeps both the project rule and the built-in", async () => {
  await withRepo(
    {
      rules: [{ path: "**/migrations/**", rule: "Every migration needs a down script.", mergeBuiltin: true }],
    },
    async (root) => {
      const resolved = await loadRules(root);
      const applied = rulesForPath("db/migrations/001.sql", resolved);
      assert.equal(applied.length, 2);
      assert.equal(applied[0], "Every migration needs a down script.");
      assert.match(applied[1], /reversibility/);
    },
  );
});

test("the first matching rule wins, so order expresses precedence", async () => {
  await withRepo(
    {
      rules: [
        { path: "src/payments/**", rule: "Money must be handled in minor units." },
        { path: "**/*.ts", rule: "General TypeScript rule." },
      ],
    },
    async (root) => {
      assert.deepEqual(rulesForPath("src/payments/charge.ts", await loadRules(root)), [
        "Money must be handled in minor units.",
      ]);
      assert.deepEqual(rulesForPath("src/other/util.ts", await loadRules(root)), [
        "General TypeScript rule.",
      ]);
    },
  );
});

test("project exclusions drop paths from review", async () => {
  await withRepo({ exclude: ["**/__fixtures__/**", "vendor/"] }, async (root) => {
    const resolved = await loadRules(root);
    assert.ok(isExcludedByRules("src/__fixtures__/big.json", resolved));
    assert.ok(isExcludedByRules("vendor/lib.js", resolved));
    assert.ok(!isExcludedByRules("src/app.ts", resolved));
  });
});

test("built-in rules apply when no rule file exists", async () => {
  await withRepo(undefined, async (root) => {
    const resolved = await loadRules(root);
    assert.equal(resolved.sources.length, 0);
    assert.match(rulesForPath("db/migrations/001.sql", resolved)[0] ?? "", /reversibility/);
    assert.deepEqual(rulesForPath("src/app.ts", resolved), []);
  });
});

test("an unreadable rule file fails loudly instead of being ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "prr-rules-bad-"));
  try {
    await mkdir(join(root, ".pr-review"), { recursive: true });
    await writeFile(join(root, ".pr-review", "rules.json"), "{ not json", "utf8");
    await assert.rejects(() => loadRules(root), /not valid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
