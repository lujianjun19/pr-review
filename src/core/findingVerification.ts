import type { FindingVerification, VerificationMethod } from "../types.ts";

export const VERIFICATION_METHODS: VerificationMethod[] = [
  "runtime",
  "test-run",
  "declaration",
];

/**
 * Phrases that assert something about an API surface rather than about the
 * changed code.
 *
 * The single worst failure this toolkit has produced was a pair of High
 * findings claiming a library method did not exist, based on a text search over
 * a minified bundle. `evidence` could not catch it: the quoted call site was
 * real; the claim about it was not. These patterns route that claim class into
 * a stricter gate.
 */
const DEPENDENCY_CLAIM_PATTERNS: RegExp[] = [
  /\b(does|do|did)\s+not\s+exist\b/i,
  /\b(is|are|was|were)\s+not\s+(a\s+)?(real|valid|public|available)\b/i,
  /\bno\s+such\s+(method|function|property|member|api|export)\b/i,
  /\b(is|are)\s+not\s+(a\s+)?(method|function|property|member|export)\b/i,
  /\bnot\s+(a\s+)?(method|function|property|member|export)\s+on\b/i,
  /\bundefined\s+(method|function|property|member|export)\b/i,
  /\balways\s+throws?\b/i,
  /\bnever\s+(exists|resolves|returns|fires|runs)\b/i,
  /\bis\s+(a\s+)?typo\s+for\b/i,
  /\bTypeError\b/,
  /\bis\s+not\s+a\s+function\b/i,
];

/** Reports whether a finding asserts something about a dependency's API. */
export function assertsDependencyApi(problem: string, fix: string): boolean {
  const text = `${problem}\n${fix}`;
  return DEPENDENCY_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

/** Runtime validation of a persisted finding verification record. */
export function isValidFindingVerification(
  verification: FindingVerification | undefined,
): boolean {
  return Boolean(
    verification &&
      VERIFICATION_METHODS.includes(verification.method) &&
      verification.detail.trim(),
  );
}
