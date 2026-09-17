import { showFile } from "./git.ts";

export interface Location {
  startLine: number;
  endLine: number;
}

function normalize(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/**
 * Finds a verbatim excerpt inside file content.
 *
 * Matching ignores indentation and collapses runs of whitespace, because a
 * quoted excerpt is frequently re-indented when it is written into a report,
 * but it never ignores the code itself: a match means those exact tokens
 * appear in that order in the reviewed revision.
 *
 * An excerpt that appears more than once is treated as unresolved rather than
 * guessed. Boilerplate repeated across a file cannot be anchored safely, and a
 * wrong anchor is worse than none.
 */
export function locate(content: string, evidence: string): Location | "ambiguous" | undefined {
  const needle = evidence
    .split("\n")
    .map(normalize)
    .filter((l) => l.length > 0);
  if (needle.length === 0) return undefined;

  const lines = content.split("\n");
  const normalized = lines.map(normalize);
  const matches: Location[] = [];

  for (let i = 0; i + needle.length <= normalized.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (normalized[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push({ startLine: i + 1, endLine: i + needle.length });
  }

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // A single short line repeated in the file is ambiguous; longer excerpts
    // that repeat verbatim are still real duplicates, so both decline.
    return "ambiguous";
  }

  // Last resort for a one-line excerpt: allow it to be a substring of a longer
  // line, which happens when a reviewer quotes an expression rather than a
  // statement.
  if (needle.length === 1) {
    const hits: Location[] = [];
    for (let i = 0; i < normalized.length; i++) {
      if (normalized[i].includes(needle[0])) hits.push({ startLine: i + 1, endLine: i + 1 });
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return "ambiguous";
  }

  return undefined;
}

export interface ResolveResult {
  location?: Location;
  /** Set when the excerpt was found in a different changed file. */
  relocatedTo?: string;
  /** Files that contain the excerpt when it is not unique. */
  candidates?: string[];
  outcome: "resolved" | "relocated" | "ambiguous" | "ambiguous-elsewhere" | "not-found";
}

/**
 * Resolves a finding's location from its evidence.
 *
 * The declared file is tried first. When the excerpt is absent there but
 * appears in exactly one other changed file, the finding is re-filed to that
 * file: reviewers regularly describe code from a related file they read for
 * context, and the excerpt is the reliable signal of where it actually lives.
 */
export async function resolveEvidence(
  repoRoot: string,
  sourceSHA: string,
  declaredPath: string,
  evidence: string,
  otherPaths: string[],
): Promise<ResolveResult> {
  const own = await showFile(repoRoot, sourceSHA, declaredPath);
  const hit = own ? locate(own, evidence) : undefined;
  if (hit && hit !== "ambiguous") return { location: hit, outcome: "resolved" };
  if (hit === "ambiguous") return { outcome: "ambiguous" };

  const relocations: { path: string; location: Location }[] = [];
  const ambiguousIn: string[] = [];
  for (const path of otherPaths) {
    if (path === declaredPath) continue;
    const content = await showFile(repoRoot, sourceSHA, path);
    if (!content) continue;
    const found = locate(content, evidence);
    if (found === "ambiguous") ambiguousIn.push(path);
    else if (found) relocations.push({ path, location: found });
  }
  if (relocations.length === 1 && ambiguousIn.length === 0) {
    return {
      location: relocations[0].location,
      relocatedTo: relocations[0].path,
      outcome: "relocated",
    };
  }
  if (relocations.length + ambiguousIn.length > 1) {
    // The excerpt is real but shared by several changed files, so it cannot
    // identify one of them. Naming the candidates lets the reviewer quote a
    // longer span instead of guessing.
    return {
      outcome: "ambiguous-elsewhere",
      candidates: [...relocations.map((r) => r.path), ...ambiguousIn],
    };
  }
  return { outcome: "not-found" };
}
