#!/usr/bin/env node
/**
 * Public-safety scan: blocks commits that would expose secrets, personal data,
 * or private organization details.
 *
 * Generic patterns (credentials, personal paths, emails, real Azure DevOps
 * organizations, GUIDs) are built in. Organization, project, customer and
 * person names are deliberately NOT listed here — committing a deny-list of
 * private names would publish exactly what it protects. They are read from a
 * file outside the repository instead:
 *
 *   $PR_REVIEW_PRIVATE_TERMS, else ~/.config/pr-review/private-terms.txt
 *
 * one case-insensitive term or /regex/ per line; `#` starts a comment.
 *
 * Usage:
 *   node scripts/check-public-safety.mjs            scan tracked + untracked files
 *   node scripts/check-public-safety.mjs --staged   scan the staged content (pre-commit)
 *
 * A line that must keep a matching value (a synthetic fixture) can carry the
 * marker `public-safety: allow` in a comment on the same line.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Values that look sensitive but are public or synthetic by design. */
const ALLOWED_VALUES = [
  "499b84ac-1321-427f-aa17-267ca6975798", // Azure DevOps first-party resource id (public)
  "00000000-0000-0000-0000-000000000000",
];

/** Organization names that are synthetic or placeholders in URLs. */
const ALLOWED_ORGS = new Set(["contoso", "org", "fabrikam", "example", "my-org", "myorg"]);

/** Email domains that never identify a real mailbox. */
const ALLOWED_EMAIL_DOMAINS = /(^|\.)(example\.(com|org|net)|users\.noreply\.github\.com|localhost|x)$/i;

const ALLOW_MARKER = "public-safety: allow";

/** Binary or generated paths whose content is checked by their source instead. */
const SKIP_PATHS = [/^package-lock\.json$/, /\.(png|jpe?g|gif|ico|pdf|zip)$/i];

/** Built-in rules: each returns a finding message for a line, or undefined. */
export const BUILTIN_RULES = [
  {
    id: "private-key",
    test: (line) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line),
  },
  {
    id: "token",
    test: (line) =>
      /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}/.test(
        line,
      ),
  },
  {
    id: "connection-secret",
    test: (line) =>
      /(AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd)\s*=\s*[^;\s"'`]{6,}/i.test(line) &&
      !/=\s*(\$\{|<|\{\{|\[REDACTED\]|hunter2)/i.test(line),
  },
  {
    id: "personal-path",
    test: (line) =>
      /(^|[\s"'`(=])(\/home\/(?!user\b|runner\b|you\b|<)[a-z][\w.-]*\/|\/Users\/(?!Shared\b|user\b|you\b|<)[A-Za-z][\w.-]*\/|[A-Z]:\\Users\\(?!Public\b|user\b|<)[A-Za-z][\w.-]*\\)/.test(
        line,
      ),
  },
  {
    id: "email",
    test: (line) => {
      for (const match of line.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g)) {
        const domain = match[1];
        if (/^(github\.com|ssh\.dev\.azure\.com|dev\.azure\.com|vs-ssh\.visualstudio\.com)$/i.test(domain)) continue;
        if (!ALLOWED_EMAIL_DOMAINS.test(domain)) return true;
      }
      return false;
    },
  },
  {
    id: "azure-devops-org",
    test: (line) => {
      const orgs = [
        ...line.matchAll(/dev\.azure\.com\/([A-Za-z0-9][\w.-]*)/g),
        ...line.matchAll(/\/\/([A-Za-z0-9][\w-]*)\.visualstudio\.com/g),
        ...line.matchAll(/ssh\.dev\.azure\.com:v3\/([A-Za-z0-9][\w.-]*)/g),
      ].map((m) => m[1].toLowerCase());
      return orgs.some((org) => !ALLOWED_ORGS.has(org) && !org.startsWith("_apis"));
    },
  },
  {
    id: "guid",
    test: (line) => {
      for (const match of line.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) {
        if (!ALLOWED_VALUES.includes(match[0].toLowerCase())) return true;
      }
      return false;
    },
  },
];

/** Parses the private-terms file into matchers. */
export function parseTerms(text) {
  const terms = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const regex = /^\/(.+)\/([a-z]*)$/.exec(line);
    terms.push(
      regex
        ? { label: line, pattern: new RegExp(regex[1], regex[2].includes("i") ? regex[2] : `${regex[2]}i`) }
        : { label: line, pattern: new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
    );
  }
  return terms;
}

function privateTermsPath() {
  return process.env.PR_REVIEW_PRIVATE_TERMS || join(homedir(), ".config", "pr-review", "private-terms.txt");
}

/** Scans one file's text. Returns `{ line, rule }` for every problem. */
export function scanText(text, terms) {
  const problems = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(ALLOW_MARKER)) continue;
    for (const rule of BUILTIN_RULES) {
      if (rule.test(line)) problems.push({ line: i + 1, rule: rule.id });
    }
    for (const term of terms) {
      if (term.pattern.test(line)) problems.push({ line: i + 1, rule: `private-term ${term.label}` });
    }
  }
  return problems;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function filesToScan(staged) {
  const out = staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
    : git(["ls-files", "-co", "--exclude-standard", "-z"]);
  return out.split("\0").filter((path) => path && !SKIP_PATHS.some((p) => p.test(path)));
}

function readContent(path, staged) {
  if (staged) return git(["show", `:${path}`]);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function main() {
  const staged = process.argv.includes("--staged");
  const termsPath = privateTermsPath();
  const terms = existsSync(termsPath) ? parseTerms(readFileSync(termsPath, "utf8")) : [];

  const report = [];
  for (const path of filesToScan(staged)) {
    const content = readContent(path, staged);
    if (content.includes("\0")) continue; // binary
    for (const problem of scanText(content, terms)) report.push(`${path}:${problem.line}: ${problem.rule}`);
    // The path itself can leak a private name.
    for (const term of terms) {
      if (term.pattern.test(path)) report.push(`${path}: private-term in file name ${term.label}`);
    }
  }

  // The commit identity is published with every commit.
  const email = (() => {
    try {
      return git(["config", "user.email"]).trim();
    } catch {
      return "";
    }
  })();
  if (email && terms.some((term) => term.pattern.test(email))) {
    report.push(`git config user.email (${email.replace(/^[^@]+/, "***")}): matches a private term`);
  }

  const scope = staged ? "staged changes" : "working tree";
  if (terms.length === 0) {
    console.warn(
      `public-safety: no private terms file at ${termsPath}; only built-in patterns were checked. ` +
        "Add organization, project, customer and person names there (one per line).",
    );
  }
  if (report.length > 0) {
    console.error(`public-safety: ${report.length} problem(s) in ${scope}:`);
    for (const line of report.slice(0, 200)) console.error(`  ${line}`);
    console.error(
      `Remove or anonymize them (use contoso / portal-api style fixtures). For an intentional synthetic ` +
        `value, add a "${ALLOW_MARKER}" comment on that line.`,
    );
    process.exit(1);
  }
  console.log(`public-safety: OK (${scope}, ${terms.length} private term(s) checked)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
