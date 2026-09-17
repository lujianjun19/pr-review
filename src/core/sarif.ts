import type { Finding, RunMeta, Severity } from "../types.ts";

/**
 * SARIF severity mapping.
 *
 * Code scanning surfaces distinguish only three levels, so Critical and High
 * both map to `error`: both block a merge, and collapsing them here is less
 * misleading than promoting Medium to match.
 */
const SARIF_LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
};

const SEVERITY_SCORE: Record<Severity, string> = {
  critical: "9.5",
  high: "8.0",
  medium: "5.0",
  low: "2.0",
};

/**
 * Renders findings as SARIF 2.1.0.
 *
 * Only verified findings are emitted: an unlocated finding has no line to
 * attach to, and a code scanning surface would either drop it silently or pin
 * it to line 1 of the file, which is worse than not reporting it at all.
 */
export function renderSarif(findings: Finding[], meta: RunMeta): string {
  const publishable = findings.filter((f) => f.status === "verified" && f.line !== undefined);

  const ruleIds = [...new Set(publishable.map((f) => f.category))].sort();
  const rules = ruleIds.map((id) => ({
    id,
    name: id,
    shortDescription: { text: `${id} finding reported by pr-review` },
    defaultConfiguration: { level: "warning" as const },
  }));

  const results = publishable.map((finding) => ({
    ruleId: finding.category,
    level: SARIF_LEVEL[finding.severity],
    message: { text: `${finding.problem}\n\nFix: ${finding.fix}` },
    properties: {
      severity: finding.severity,
      "security-severity": SEVERITY_SCORE[finding.severity],
      fingerprint: finding.id,
    },
    partialFingerprints: { prReviewFindingId: finding.id },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: finding.path },
          region: {
            startLine: finding.line,
            endLine: finding.endLine ?? finding.line,
            snippet: { text: finding.evidence },
          },
        },
      },
    ],
  }));

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "pr-review",
            version: meta.toolVersion,
            informationUri: "https://github.com/",
            rules,
          },
        },
        versionControlProvenance: [
          {
            repositoryUri: meta.webUrl ?? meta.repoRoot,
            revisionId: meta.sourceSHA,
            branch: meta.sourceBranch,
          },
        ],
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

/** Renders the full findings set as JSON, including items that cannot be published. */
export function renderJson(findings: Finding[], meta: RunMeta): string {
  return JSON.stringify(
    {
      scope: meta.scope,
      repo: meta.repo,
      prId: meta.prId,
      sourceSHA: meta.sourceSHA,
      baseSHA: meta.baseSHA,
      findings,
    },
    null,
    2,
  );
}
