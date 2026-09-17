/** Identifies one Azure DevOps repository plus, optionally, a pull request. */
export interface AdoTarget {
  org: string;
  project: string;
  repo: string;
  prId?: number;
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Parses a pull request URL in any of the forms Azure DevOps hands out.
 *
 * Both the modern `dev.azure.com/{org}/{project}` host and the legacy
 * `{org}.visualstudio.com/{project}` host are accepted; API calls always go to
 * dev.azure.com afterwards.
 */
export function parsePrUrl(input: string): AdoTarget | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decode);
  const host = url.hostname.toLowerCase();

  let org: string | undefined;
  let rest = segments;
  if (host === "dev.azure.com" || host.endsWith(".dev.azure.com")) {
    org = segments[0];
    rest = segments.slice(1);
  } else if (host.endsWith(".visualstudio.com")) {
    org = host.slice(0, -".visualstudio.com".length);
  } else {
    return undefined;
  }
  if (!org) return undefined;

  const gitIndex = rest.findIndex((s) => s === "_git");
  if (gitIndex < 1) return undefined;
  let projectSegments = rest.slice(0, gitIndex).filter((s) => s !== "_apis");
  // `DefaultCollection` is the legacy name of the one collection an account
  // has; it appears in older clone URLs but is not part of the project path the
  // REST API expects, and leaving it in produces a 404 on every call.
  if (
    projectSegments.length > 1 &&
    projectSegments[0].toLowerCase() === "defaultcollection"
  ) {
    projectSegments = projectSegments.slice(1);
  }
  const project = projectSegments.join("/");
  const repo = rest[gitIndex + 1];
  if (!project || !repo) return undefined;

  let prId: number | undefined;
  const prIndex = rest.findIndex((s) => s.toLowerCase() === "pullrequest");
  if (prIndex >= 0) {
    const raw = rest[prIndex + 1];
    const parsed = Number.parseInt(raw ?? "", 10);
    if (Number.isFinite(parsed)) prId = parsed;
  }

  return { org, project, repo, prId };
}

/**
 * Derives the repository coordinates from a git remote URL, so a bare pull
 * request number can inherit them from `origin`.
 */
export function parseRemoteUrl(remote: string): Omit<AdoTarget, "prId"> | undefined {
  const trimmed = remote.trim().replace(/\.git$/, "");

  // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  const ssh = /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com[:/]v3\/(.+)$/.exec(trimmed);
  if (ssh) {
    const parts = ssh[1].split("/").map(decode).filter(Boolean);
    if (parts.length >= 3) {
      return { org: parts[0], project: parts.slice(1, -1).join("/"), repo: parts[parts.length - 1] };
    }
    return undefined;
  }

  const parsed = parsePrUrl(trimmed);
  if (parsed) return { org: parsed.org, project: parsed.project, repo: parsed.repo };
  return undefined;
}

/** Builds the https clone URL for a target, used to fetch pinned commits. */
export function remoteUrlFor(target: AdoTarget): string {
  return `https://dev.azure.com/${encodeURIComponent(target.org)}/${encodeURIComponent(
    target.project,
  )}/_git/${encodeURIComponent(target.repo)}`;
}

/** Builds the browser URL of a pull request. */
export function webUrlFor(target: AdoTarget, prId: number): string {
  return `${remoteUrlFor(target)}/pullrequest/${prId}`;
}
