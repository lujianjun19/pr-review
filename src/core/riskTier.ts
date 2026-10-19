import type { ChangedFile, RiskTier } from "../types.ts";
import { matchesAny } from "./glob.ts";

/** Total changed lines above which a change is treated as high risk on size alone. */
const LARGE_CHURN = 1000;

/** Largest change still eligible for the low tier. */
const SMALL_CHURN = 300;

/** Categories that cannot change production behaviour on their own. */
const LOW_RISK_CATEGORIES = new Set(["docs", "test", "generated", "lock"]);

const MIGRATION = /(^|\/)migrations?\//i;

/**
 * Classifies a whole change into a suggested human-review tier.
 *
 * The tier is advice for the Summary, never an action: the toolkit does not
 * vote, approve or assign reviewers. It is deterministic so two runs over the
 * same change agree, and every tier carries the reasons that produced it, so a
 * reader can disagree with a specific signal rather than with an opaque score.
 */
export function computeRiskTier(files: ChangedFile[], alwaysHuman: string[] = []): RiskTier {
  const high: string[] = [];
  const humans: string[] = [];

  const security = files.filter((f) => f.decision !== "skip" && f.signals?.includes("security"));
  if (security.length > 0) {
    high.push(`security-sensitive path: ${listPaths(security)}`);
  }
  const migrations = files.filter((f) => MIGRATION.test(f.path) && f.category !== "generated");
  if (migrations.length > 0) {
    high.push(`schema migration: ${listPaths(migrations)}`);
  }
  const secrets = files.filter((f) => f.reason === "secret-path");
  if (secrets.length > 0) {
    high.push(`credential-like file changed: ${listPaths(secrets)}`);
  }
  const churn = files
    .filter((f) => f.decision === "review")
    .reduce((sum, f) => sum + f.adds + f.dels, 0);
  if (churn > LARGE_CHURN) {
    high.push(`${churn} reviewable lines changed (> ${LARGE_CHURN})`);
  }

  if (alwaysHuman.length > 0) {
    const pinned = files.filter((f) => matchesAny(f.path, alwaysHuman));
    if (pinned.length > 0) humans.push(`always-human path: ${listPaths(pinned)}`);
  }

  if (high.length > 0) {
    return { tier: "high", approvers: 2, reasons: [...high, ...humans] };
  }

  const behavioural = files.filter((f) => !LOW_RISK_CATEGORIES.has(f.category));
  if (behavioural.length === 0 && churn <= SMALL_CHURN && humans.length === 0) {
    return {
      tier: "low",
      approvers: 0,
      reasons: [`only ${describeCategories(files)} changed, ${churn} lines`],
    };
  }

  const reasons = [...humans];
  if (behavioural.length > 0) {
    reasons.push(`${behavioural.length} behavioural file(s), ${churn} reviewable lines`);
  }
  return { tier: "standard", approvers: 1, reasons };
}

function listPaths(files: ChangedFile[]): string {
  const shown = files.slice(0, 3).map((f) => f.path);
  return files.length > 3 ? `${shown.join(", ")} (+${files.length - 3} more)` : shown.join(", ");
}

function describeCategories(files: ChangedFile[]): string {
  const categories = [...new Set(files.map((f) => f.category))].sort();
  return categories.length > 0 ? categories.join("/") : "no";
}
