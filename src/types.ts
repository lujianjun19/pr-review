/**
 * Shared data contracts.
 *
 * These types are the stable interface between the deterministic toolkit and
 * the reviewing agent. Everything written into the run directory conforms to
 * one of them, so a change here is a breaking change for SKILL.md as well.
 */

export type FileDecision = "review" | "stat-only" | "skip";

/** What the run is comparing: a pull request, a branch, or uncommitted work. */
export type ReviewScope = "ado-pr" | "branch" | "working-tree";

export type FileCategory =
  | "source"
  | "test"
  | "config"
  | "docs"
  | "generated"
  | "lock"
  | "binary"
  | "secret"
  | "unknown";

export type ChangeStatus = "add" | "edit" | "delete" | "rename";

/** One changed file with its pre-dispatch decision. Produced by triage. */
export interface ChangedFile {
  /** Repository-relative path, no leading slash. Post-rename path when renamed. */
  path: string;
  /** Pre-rename path, only set for renames. */
  oldPath?: string;
  status: ChangeStatus;
  adds: number;
  dels: number;
  binary: boolean;
  category: FileCategory;
  decision: FileDecision;
  /** Machine-readable justification for the decision, e.g. "lock-file". */
  reason: string;
  /** Risk score, higher is reviewed earlier. */
  risk: number;
  /** Estimated tokens of this file's diff. */
  tokens: number;
  /** Azure DevOps change tracking id, required to anchor comments across iterations. */
  changeTrackingId?: number;
  /** Per-path review checklist resolved from the rule layers. */
  rules?: string[];
  /** Lowest severity worth reporting for this path, from the matching rule. */
  minSeverity?: Severity;
  /** Risk labels matched from the path, e.g. "security" or "contract". */
  signals?: string[];
}

/** A risk-ordered group of files reviewed together in one pass. */
export interface Batch {
  id: number;
  label: string;
  files: string[];
  estTokens: number;
  risk: number;
  /** True when the batch is large enough to deserve an explicit risk plan first. */
  needsPlan: boolean;
  payload: string;
}

/** How thorough a review run is. Changes batching, planning and the challenge gate. */
export type ReviewDepth = "quick" | "standard" | "deep";

/** Pull-request-level risk classification, advisory only. */
export interface RiskTier {
  tier: "low" | "standard" | "high";
  /** Suggested number of human approvers. Never acted on by the toolkit. */
  approvers: 0 | 1 | 2;
  reasons: string[];
}

/** Normalized existing review thread. */
export interface ReviewThread {
  id: number;
  path?: string;
  line?: number;
  status: string;
  isDeleted: boolean;
  /** True when every comment author looks like a bot or service identity. */
  isBot: boolean;
  comments: { author: string; type: string; body: string }[];
}

/** Immutable identity of one review run. */
export interface RunMeta {
  toolVersion: string;
  createdAt: string;
  scope: ReviewScope;
  /** Azure DevOps coordinates. Absent for local scopes. */
  org?: string;
  project?: string;
  projectId?: string;
  repo: string;
  repoId?: string;
  prId?: number;
  title: string;
  author?: string;
  isDraft?: boolean;
  status?: string;
  sourceBranch: string;
  targetBranch: string;
  /** Iteration reviewed. Latest unless --iteration was given. Azure DevOps only. */
  iterationId?: number;
  /** When set, only changes since this iteration are in scope. */
  compareTo?: number;
  /** Revision under review. The WORKTREE sentinel for a working-tree review. */
  sourceSHA: string;
  targetSHA: string;
  /** Merge base. Taken from the iteration's commonRefCommit for a pull request. */
  baseSHA: string;
  repoRoot: string;
  webUrl?: string;
  runDir: string;
  /** Rule files that contributed to this run, highest priority first. */
  ruleSources?: string[];
  /** Review depth. Absent in runs prepared before depth existed; treated as standard. */
  depth?: ReviewDepth;
  /** Caps that shape what finalize publishes. */
  limits?: { maxLowFindings?: number };
  riskTier?: RiskTier;
  /** Repository guidance files read from the base revision. */
  guidanceFiles?: string[];
}

export type Severity = "critical" | "high" | "medium" | "low";

export type FindingStatus =
  | "candidate"
  | "verified"
  | "unverified"
  | "unlocated"
  | "duplicate"
  /** A human determined the underlying claim was wrong, independent of whether
   * the evidence text resolves. Terminal: verify must never overturn it. */
  | "retracted"
  /** An independent challenge could not confirm the claim. Belongs in Open Questions. */
  | "unconfirmed"
  /** Real and verified, but below a path threshold or over a cap. Recomputed by finalize. */
  | "suppressed";

/**
 * How a claim about a dependency's API surface was checked.
 *
 * A grep over vendored, bundled, or minified code proves nothing about an API:
 * formatting, re-exports and build output all defeat it. Claims of the form
 * "this method does not exist" therefore carry a heavier burden of proof than
 * claims about the changed code itself, which `evidence` already anchors.
 */
export type VerificationMethod =
  /** Runtime introspection, e.g. `typeof client.method`. */
  | "runtime"
  /** The repository's own tests exercised the path. */
  | "test-run"
  /** Published type declarations or official API documentation. */
  | "declaration";

export interface FindingVerification {
  method: VerificationMethod;
  /** The command run or the source consulted. */
  detail: string;
}

export type ChallengeOutcome = "confirmed" | "refuted" | "uncertain";

/**
 * Result of an independent attempt to disprove a finding.
 *
 * Evidence verification proves the quoted code exists; it cannot prove the
 * claim about it. A second reader with fresh context, asked to refute rather
 * than to agree, is the cheapest available check on the claim itself.
 */
export interface FindingChallenge {
  outcome: ChallengeOutcome;
  /** What the challenger checked and why it agrees or disagrees. */
  detail: string;
  /** Who challenged, e.g. "subagent" or "self". */
  by: string;
  at: string;
}

/** One review finding. Free-form prose is confined to problem/fix. */
export interface Finding {
  id: string;
  path: string;
  line?: number;
  endLine?: number;
  severity: Severity;
  category: string;
  problem: string;
  /** Verbatim excerpt from the source revision. Used to resolve the line. */
  evidence: string;
  fix: string;
  fixedCode?: string;
  status: FindingStatus;
  /** Required when the finding asserts something about a dependency's API. */
  verification?: FindingVerification;
  /** Existing thread id when this finding duplicates one. */
  dupOfThread?: number;
  /** True when the defect exists in the base revision and was not introduced by this change. */
  preExisting?: boolean;
  /** Why the reviewer flagged it: the reasoning chain, shown collapsed in posted comments. */
  rationale?: string;
  challenge?: FindingChallenge;
  /** Why finalize suppressed it. Set only while status is "suppressed". */
  suppressedReason?: string;
  /** Why it was retracted, when a challenge refuted it. */
  retractReason?: string;
  batch?: number;
  createdAt: string;
}

export type VerdictValue = "clean" | "findings" | "cross-batch";

export interface FileVerdict {
  path: string;
  batch: number;
  verdict: VerdictValue;
  note?: string;
  at: string;
}

export interface ValidationRecord {
  command: string[];
  cwd: string;
  sourceSHA: string;
  startedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Payload accepted by `prr note --file`. */
export interface NoteInput {
  batch?: number;
  verdicts?: { path: string; verdict: VerdictValue; note?: string }[];
  findings?: Partial<Finding>[];
  /** Finding ids to mark retracted: the underlying claim was wrong. Terminal. */
  retract?: string[];
  /** Independent challenge results keyed by finding id. */
  challenges?: { id: string; outcome: ChallengeOutcome; detail: string; by?: string }[];
  /** Findings that an existing thread already covers. Terminal. */
  duplicates?: { id: string; thread: number }[];
  /** Severity corrections for recorded findings; the fingerprint does not depend on severity. */
  reclassify?: { id: string; severity: Severity }[];
}

/**
 * A finding posted by an earlier prr run, recognized from its hidden marker.
 *
 * Run directories are keyed by revision, so a new push starts a fresh run with
 * no memory of what was posted. The marker inside each posted comment is what
 * carries that memory across iterations.
 */
export interface PriorFinding {
  threadId: number;
  findingId: string;
  path?: string;
  line?: number;
  /** Thread status at prepare time, e.g. "active" or "fixed". */
  status: string;
  severity?: Severity;
  evidence?: string;
  /** Whether the quoted evidence still exists at the new source revision. */
  evidenceStillPresent: boolean | null;
  /** Comments after the finding itself: author replies and follow-ups. */
  replies: { author: string; body: string }[];
}

/** Machine-readable outcome written by finalize and embedded in the posted summary. */
export interface ReviewResult {
  tool: "prr";
  version: string;
  scope: ReviewScope;
  prId?: number;
  iterationId?: number;
  sourceSHA: string;
  depth: ReviewDepth;
  ok: boolean;
  coverage: { covered: number; total: number };
  counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    preExisting: number;
    suppressed: number;
    unconfirmed: number;
    notPublishable: number;
    duplicate: number;
    retracted: number;
  };
  /** Verified, non-pre-existing Critical/High/Medium findings. */
  blocking: number;
  suggestedVerdict: "approve" | "request-changes" | "needs-clarification" | "incomplete";
  riskTier?: RiskTier;
}
