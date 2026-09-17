import { getCredential } from "./auth.ts";
import type { AdoTarget } from "./url.ts";
import type { ReviewThread } from "../types.ts";

const API_VERSION = "7.1";

export interface PullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string;
  isDraft: boolean;
  createdBy?: { displayName?: string };
  sourceRefName: string;
  targetRefName: string;
  repository: { id: string; name: string };
  labels?: { name: string }[];
}

export interface Iteration {
  id: number;
  createdDate: string;
  description?: string;
  sourceRefCommit: { commitId: string };
  targetRefCommit: { commitId: string };
  commonRefCommit: { commitId: string };
}

export interface IterationChange {
  changeTrackingId?: number;
  changeType: string;
  item: { path?: string; originalPath?: string; isFolder?: boolean };
}

/** Thin Azure DevOps Git REST client. Native fetch only, no dependencies. */
export class AdoClient {
  private readonly target: AdoTarget;

  constructor(target: AdoTarget) {
    this.target = target;
  }

  private base(): string {
    const { org, project, repo } = this.target;
    return (
      `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
      `/_apis/git/repositories/${encodeURIComponent(repo)}`
    );
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const cred = await getCredential();
    const url = `${this.base()}${path}${path.includes("?") ? "&" : "?"}api-version=${API_VERSION}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: cred.header,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      throw new Error(`Azure DevOps ${res.status} ${res.statusText} for ${url}\n${body}`);
    }
    // A non-JSON body here means the org rejected the token and served the sign-in page.
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `Azure DevOps returned a non-JSON response for ${url}. The credential is probably ` +
          `not valid for this organization.`,
      );
    }
  }

  getPullRequest(prId: number): Promise<PullRequest> {
    return this.request<PullRequest>(`/pullRequests/${prId}`);
  }

  async listIterations(prId: number): Promise<Iteration[]> {
    const res = await this.request<{ value: Iteration[] }>(`/pullRequests/${prId}/iterations`);
    return res.value ?? [];
  }

  async listIterationChanges(
    prId: number,
    iterationId: number,
    compareTo?: number,
  ): Promise<IterationChange[]> {
    const query = new URLSearchParams({ $top: "2000" });
    if (compareTo !== undefined) query.set("$compareTo", String(compareTo));
    const res = await this.request<{ changeEntries: IterationChange[] }>(
      `/pullRequests/${prId}/iterations/${iterationId}/changes?${query.toString()}`,
    );
    return res.changeEntries ?? [];
  }

  async listThreads(prId: number): Promise<ReviewThread[]> {
    const res = await this.request<{ value: RawThread[] }>(`/pullRequests/${prId}/threads`);
    return (res.value ?? []).map(normalizeThread);
  }

  /** Creates a comment thread. The body is sent as JSON, so emoji survive intact. */
  createThread(prId: number, body: Record<string, unknown>): Promise<{ id: number }> {
    return this.request<{ id: number }>(`/pullRequests/${prId}/threads`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

interface RawComment {
  author?: { displayName?: string; isContainer?: boolean; uniqueName?: string };
  commentType?: string | number;
  content?: string;
  isDeleted?: boolean;
}

interface RawThread {
  id: number;
  status?: string | number;
  isDeleted?: boolean;
  comments?: RawComment[];
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line?: number };
    leftFileStart?: { line?: number };
  };
}

const COMMENT_TYPES = ["unknown", "text", "codeChange", "system"];
const THREAD_STATUSES = [
  "unknown",
  "active",
  "fixed",
  "wontFix",
  "closed",
  "byDesign",
  "pending",
];

function enumName(value: string | number | undefined, names: string[], fallback: string): string {
  if (typeof value === "number") return names[value] ?? fallback;
  if (typeof value === "string" && value) return value;
  return fallback;
}

const BOT_HINT = /\b(bot|service|build|pipeline|automation|copilot|sonar)\b/i;

/**
 * Converts a thread into the shape the agent consumes: enum values normalized
 * to strings (requests send integers but responses may use either), the path
 * stripped of its leading slash so it matches git paths, and system threads
 * marked so they never count as human review coverage.
 */
function normalizeThread(raw: RawThread): ReviewThread {
  const comments = (raw.comments ?? [])
    .filter((c) => !c.isDeleted)
    .map((c) => ({
      author: c.author?.displayName ?? "unknown",
      type: enumName(c.commentType, COMMENT_TYPES, "text"),
      body: (c.content ?? "").trim(),
    }));
  const ctx = raw.threadContext;
  const isSystem = comments.length > 0 && comments.every((c) => c.type === "system");
  const isBot =
    isSystem ||
    (comments.length > 0 && comments.every((c) => BOT_HINT.test(c.author)));
  return {
    id: raw.id,
    path: ctx?.filePath ? ctx.filePath.replace(/^\//, "") : undefined,
    line: ctx?.rightFileStart?.line ?? ctx?.leftFileStart?.line,
    status: enumName(raw.status, THREAD_STATUSES, "unknown"),
    isDeleted: raw.isDeleted === true,
    isBot,
    comments,
  };
}
