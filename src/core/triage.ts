import type { ChangedFile, FileCategory, FileDecision } from "../types.ts";
import type { RawChange } from "./git.ts";
import { isExcludedByRules, rulesForPath, type ResolvedRules } from "./rules.ts";

/** Rough token estimate. Four characters per token is close enough to size batches. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimates the diff size of a file from its line counts, before the diff is read. */
function estimateDiffTokens(change: RawChange): number {
  if (change.binary) return 0;
  const lines = change.adds + change.dels;
  // ~55 characters per changed line plus hunk headers and surrounding context.
  return Math.ceil((lines * 55 * 1.6) / 4) + 40;
}

const SECRET_PATTERNS = [
  /(^|\/)\.ssh\//,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)\.(netrc|npmrc|pypirc|dockercfg|pgpass)$/,
  /(^|\/)_netrc$/,
  /\.(pem|pfx|p12|keystore|jks)$/i,
];

const LOCK_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)packages\.lock\.json$/,
  /\.lock$/,
];

const GENERATED_PATTERNS = [
  /(^|\/)(dist|build|out|coverage|node_modules|vendor|__snapshots__)\//,
  /\.(generated|gen)\.[^/]+$/,
  /(^|\/)[^/]*\.pb\.[^/]+$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.snap$/,
  /(^|\/)[^/]*\.designer\.cs$/i,
  /(^|\/)migrations?\/.*\.(designer\.cs|resx)$/i,
];

const TEST_PATTERNS = [
  /(^|\/)(__tests__|__test__|tests?|spec)\//i,
  /\.(test|spec)\.[jt]sx?$/,
  /(^|\/)[^/]*_test\.(go|py|rs|zig)$/,
  /(^|\/)[^/]*Tests?\.(cs|java|kt|swift)$/,
  /(^|\/)[^/]*\.Tests?\//i,
  /(^|\/)testdata\//,
  /(^|\/)fixtures?\//,
];

const DOC_EXTENSIONS = new Set(["md", "mdx", "txt", "rst", "adoc"]);
const CONFIG_EXTENSIONS = new Set([
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "xml",
  "csproj",
  "props",
  "targets",
  "tf",
  "tfvars",
]);

/** Path fragments that raise a file's review priority. */
const RISK_SIGNALS: { pattern: RegExp; weight: number; label: string }[] = [
  { pattern: /auth|login|token|secret|credential|password|crypt|cert|permission|role|acl/i, weight: 5, label: "security" },
  { pattern: /migration|schema|entity|dto|contract|\bapi\b|controller|endpoint|proto/i, weight: 4, label: "contract" },
  { pattern: /payment|billing|invoice|price|currency|tax|emission|fuel|calculat|solver/i, weight: 3, label: "domain-math" },
  { pattern: /concurren|thread|lock|queue|worker|scheduler|retry|timeout/i, weight: 3, label: "concurrency" },
  { pattern: /cache|session|state|store|repository|persist/i, weight: 2, label: "state" },
];

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function classify(change: RawChange): FileCategory {
  const path = change.path;
  if (SECRET_PATTERNS.some((p) => p.test(path))) return "secret";
  if (change.binary) return "binary";
  if (LOCK_PATTERNS.some((p) => p.test(path))) return "lock";
  if (GENERATED_PATTERNS.some((p) => p.test(path))) return "generated";
  if (TEST_PATTERNS.some((p) => p.test(path))) return "test";
  const ext = extensionOf(path);
  if (DOC_EXTENSIONS.has(ext)) return "docs";
  if (CONFIG_EXTENSIONS.has(ext)) return "config";
  if (ext) return "source";
  return "unknown";
}

const BASE_RISK: Record<FileCategory, number> = {
  source: 6,
  config: 4,
  test: 2,
  docs: 1,
  generated: 0,
  lock: 0,
  binary: 0,
  secret: 0,
  unknown: 3,
};

/**
 * Scores a file so batches can be ordered highest risk first.
 *
 * The score mixes what the file is (category), what it touches (path signals)
 * and how much of it changed (churn, damped so one huge formatting commit
 * cannot outrank a small security change).
 */
export function riskScore(change: RawChange, category: FileCategory): number {
  let score = BASE_RISK[category];
  for (const signal of RISK_SIGNALS) {
    if (signal.pattern.test(change.path)) score += signal.weight;
  }
  const churn = change.adds + change.dels;
  score += Math.min(6, Math.log2(churn + 1));
  if (change.status === "delete") score += 1;
  if (category === "test" || category === "docs") score = Math.min(score, 6);
  return Math.round(score * 10) / 10;
}

export interface TriageOptions {
  /** Diffs larger than this estimate are dropped: they cannot fit a review prompt. */
  maxFileTokens: number;
  /** Resolved rule layers, used for per-path checklists and extra exclusions. */
  rules?: ResolvedRules;
}

export const DEFAULT_TRIAGE: TriageOptions = { maxFileTokens: 60_000 };

/**
 * Turns raw git changes into per-file decisions.
 *
 * Pure and total: every input produces exactly one decision, so a preview and
 * a real run can never disagree about what is in scope. Nothing here consults
 * the model, the network or the clock.
 */
export function triage(
  changes: RawChange[],
  trackingIds: Map<string, number>,
  opts: TriageOptions = DEFAULT_TRIAGE,
): ChangedFile[] {
  return changes.map((change) => {
    const category = classify(change);
    const tokens = estimateDiffTokens(change);

    let decision: FileDecision = "review";
    let reason = "in-scope";
    if (category === "secret") {
      decision = "skip";
      reason = "secret-path";
    } else if (category === "binary") {
      decision = "skip";
      reason = "binary";
    } else if (opts.rules && isExcludedByRules(change.path, opts.rules)) {
      // A project exclusion is a deliberate scoping decision, so it is recorded
      // as its own reason rather than hidden behind a built-in category.
      decision = "skip";
      reason = "excluded-by-rule";
    } else if (change.status === "delete") {
      decision = "stat-only";
      reason = "deleted";
    } else if (category === "lock") {
      decision = "stat-only";
      reason = "lock-file";
    } else if (category === "generated") {
      decision = "stat-only";
      reason = "generated";
    } else if (tokens > opts.maxFileTokens) {
      decision = "stat-only";
      reason = "diff-too-large";
    }

    const rules =
      decision === "review" && opts.rules ? rulesForPath(change.path, opts.rules) : [];

    return {
      path: change.path,
      oldPath: change.oldPath,
      status: change.status,
      adds: change.adds,
      dels: change.dels,
      binary: change.binary,
      category,
      decision,
      reason,
      risk: riskScore(change, category),
      tokens,
      changeTrackingId: trackingIds.get(change.path),
      ...(rules.length > 0 ? { rules } : {}),
    } satisfies ChangedFile;
  });
}
