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
  | "retracted";

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
}
