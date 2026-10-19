import type { Finding, PriorFinding, ReviewThread, Severity } from "../types.ts";
import { locate } from "./locate.ts";

/**
 * Identity footer appended to every posted finding.
 *
 * Azure DevOps does not document HTML comments or collapsible sections in pull
 * request comments, so the marker is a short visible line rather than hidden
 * markup. It lets a later run recognize its own threads; the evidence is read
 * back from the comment's own Evidence block, which this toolkit generates.
 */
const MARKER = /prr finding `([0-9a-f]{6,40})`/;

const SEVERITY_WORDS: [RegExp, Severity][] = [
  [/\*\*Critical\*\*/, "critical"],
  [/\*\*High\*\*/, "high"],
  [/\*\*Medium\*\*/, "medium"],
  [/\*\*Low\*\*/, "low"],
];

export function findingMarker(finding: Pick<Finding, "id">): string {
  return `_prr finding \`${finding.id}\`_`;
}

/**
 * Returns a code fence longer than any backtick run inside the text.
 *
 * Evidence is arbitrary code; a fixed three-backtick fence would be closed early
 * by code that itself contains one, breaking the comment and the read-back.
 */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function readEvidenceBlock(body: string): string | undefined {
  const lines = body.split("\n");
  const heading = lines.findIndex((line) => line.trim() === "**Evidence**");
  if (heading < 0) return undefined;
  const open = lines[heading + 1]?.trim() ?? "";
  if (!/^`{3,}$/.test(open)) return undefined;
  const close = lines.findIndex((line, i) => i > heading + 1 && line.trim() === open);
  if (close < 0) return undefined;
  return lines.slice(heading + 2, close).join("\n");
}

export function parseFindingMarker(
  body: string,
): { id: string; severity?: Severity; evidence?: string } | undefined {
  const match = MARKER.exec(body);
  if (!match) return undefined;
  const firstLine = body.split("\n")[0] ?? "";
  const severity = SEVERITY_WORDS.find(([pattern]) => pattern.test(firstLine))?.[1];
  const evidence = readEvidenceBlock(body);
  return {
    id: match[1],
    ...(severity ? { severity } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

/** Removes markup noise so excerpts shown to the reviewer stay readable. */
export function stripMarkers(body: string): string {
  return body
    .replace(/<!--[^]*?-->/g, "")
    .replace(/_?prr finding `[0-9a-f]+`_?/g, "")
    .trim();
}

/**
 * Recognizes threads posted by earlier prr runs and checks each against the
 * new source revision.
 *
 * "Evidence still present" is a mechanical signal, not a verdict: code can be
 * fixed in place without changing the quoted span, or the span can vanish in a
 * refactor that kept the defect. It tells the reviewer which threads to look
 * at first; resolving one remains a judgement and a gated write.
 */
export async function collectPriorFindings(
  threads: ReviewThread[],
  readFile: (path: string) => Promise<string>,
): Promise<PriorFinding[]> {
  const out: PriorFinding[] = [];
  const cache = new Map<string, string>();
  for (const thread of threads) {
    if (thread.isDeleted || thread.comments.length === 0) continue;
    const marker = parseFindingMarker(thread.comments[0].body);
    if (!marker) continue;

    let evidenceStillPresent: boolean | null = null;
    if (thread.path && marker.evidence) {
      if (!cache.has(thread.path)) cache.set(thread.path, await readFile(thread.path));
      const content = cache.get(thread.path)!;
      evidenceStillPresent = content ? locate(content, marker.evidence) !== undefined : false;
    }

    out.push({
      threadId: thread.id,
      findingId: marker.id,
      ...(thread.path ? { path: thread.path } : {}),
      ...(thread.line !== undefined ? { line: thread.line } : {}),
      status: thread.status,
      ...(marker.severity ? { severity: marker.severity } : {}),
      ...(marker.evidence ? { evidence: marker.evidence } : {}),
      evidenceStillPresent,
      replies: thread.comments
        .slice(1)
        .filter((comment) => comment.type !== "system")
        .map((comment) => ({ author: comment.author, body: stripMarkers(comment.body) })),
    });
  }
  return out;
}

/** Thread statuses in which a finding is still asking the author for something. */
export function isOpenThreadStatus(status: string): boolean {
  return status === "active" || status === "pending" || status === "unknown";
}
