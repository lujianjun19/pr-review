import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTerms, scanText } from "./check-public-safety.mjs";

const rules = (text, terms = []) => scanText(text, terms).map((p) => p.rule);

test("built-in rules catch credentials, personal paths, emails and real organizations", () => {
  assert.deepEqual(rules(`token = "ghp_${"a".repeat(36)}"`), ["token"]);
  assert.deepEqual(rules("-----BEGIN RSA PRIVATE KEY-----"), ["private-key"]); // public-safety: allow
  assert.deepEqual(rules("Server=x;Password=Sup3rSecret;"), ["connection-secret"]); // public-safety: allow
  assert.deepEqual(rules("cd /home/alice/repos/app"), ["personal-path"]); // public-safety: allow
  assert.deepEqual(rules("C:\\Users\\alice\\src"), ["personal-path"]);
  assert.deepEqual(rules("mail jane.doe@corp-internal.com"), ["email"]); // public-safety: allow
  assert.deepEqual(rules("https://dev.azure.com/acme-corp/Project/_git/repo"), ["azure-devops-org"]); // public-safety: allow
  assert.deepEqual(rules("https://acme-corp.visualstudio.com/Project"), ["azure-devops-org"]); // public-safety: allow
  assert.deepEqual(rules("tenant 1b2c3d4e-0000-4000-8000-123456789abc"), ["guid"]); // public-safety: allow
});

test("synthetic fixtures, placeholders and public constants pass", () => {
  assert.deepEqual(rules("https://dev.azure.com/contoso/Operations%20Platform/_git/portal-api"), []);
  assert.deepEqual(rules("https://dev.azure.com/{org}/{project}"), []);
  assert.deepEqual(rules("git config user.email eval@example.com"), []);
  assert.deepEqual(rules("git@github.com:owner/repo.git"), []);
  assert.deepEqual(rules("resource 499b84ac-1321-427f-aa17-267ca6975798"), []);
  assert.deepEqual(rules("Password=${PASSWORD}"), []);
  assert.deepEqual(rules("~/.config/pr-review/rules.json and $HOME/.cache"), []);
  assert.deepEqual(rules(`fake = "ghp_${"b".repeat(36)}"; // public-safety: allow`), []);
});

test("private terms are plain case-insensitive text or /regex/", () => {
  const terms = parseTerms("# comment\nAcme Shipping\n/\\bproj-\\d{3}\\b/\n\n");
  assert.equal(terms.length, 2);
  assert.deepEqual(rules("built for ACME shipping", terms), ["private-term Acme Shipping"]);
  assert.deepEqual(rules("see PROJ-123", terms), ["private-term /\\bproj-\\d{3}\\b/"]);
  assert.deepEqual(rules("nothing private here", terms), []);
  // Regex metacharacters in a plain term are literal.
  assert.equal(parseTerms("a.b")[0].pattern.test("axb"), false);
});
