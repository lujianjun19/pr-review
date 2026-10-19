/**
 * The stated intent of a change.
 *
 * Correctness is relative to intent: code that is internally consistent can
 * still implement the wrong thing. The toolkit cannot judge that, but it can
 * put the title, description and linked work items in front of the reviewer
 * instead of leaving them in a JSON file nobody opens.
 */

export interface WorkItemIntent {
  id: number;
  type?: string;
  state?: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
}

export interface ChangeIntent {
  title: string;
  description?: string;
  workItems?: WorkItemIntent[];
  /** Commit messages, for scopes without a pull request description. */
  commits?: string[];
  /** Set when linked work items could not be fetched. */
  workItemsError?: string;
}

const DESCRIPTION_CAP = 4000;
const WORK_ITEM_FIELD_CAP = 1500;
const COMMIT_CAP = 400;

/** Upper bound of the intent excerpt repeated in every batch payload. */
export const PAYLOAD_INTENT_CAP = 2500;

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * Reduces the HTML Azure DevOps stores in work item fields to plain text.
 *
 * Only structure that carries meaning survives: paragraphs and list items
 * become lines. Everything else is markup the reviewer would have to read
 * around.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\/\s*(p|div|h[1-6]|tr|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Pushes markdown headings in author-written text below the document's own.
 *
 * Pull request descriptions routinely use `##` headings, which would otherwise
 * sit at the same level as the sections that frame them.
 */
export function demoteHeadings(text: string): string {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker.startsWith(fence)) fence = undefined;
        return line;
      }
      return fence ? line : line.replace(/^(#{1,4})(\s)/, "###$1$2");
    })
    .join("\n");
}

function cap(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)} …[truncated]` : trimmed;
}

/** Renders the intent document written to `intent.md`. */
export function renderIntent(intent: ChangeIntent): string {
  const parts = ["# Change intent", "", `**Title:** ${intent.title}`, ""];
  if (intent.description !== undefined) {
    parts.push("## Description", "");
    parts.push(
      intent.description.trim() ? demoteHeadings(cap(intent.description, DESCRIPTION_CAP)) : "_(empty)_",
    );
    parts.push("");
  }
  if (intent.workItems && intent.workItems.length > 0) {
    parts.push("## Linked work items", "");
    for (const item of intent.workItems) {
      const label = [item.type, item.state].filter(Boolean).join(", ");
      parts.push(`### #${item.id} ${item.title ?? ""}${label ? ` (${label})` : ""}`.trimEnd());
      if (item.description) {
        parts.push("", cap(htmlToText(item.description), WORK_ITEM_FIELD_CAP));
      }
      if (item.acceptanceCriteria) {
        parts.push("", "**Acceptance criteria**", "", cap(htmlToText(item.acceptanceCriteria), WORK_ITEM_FIELD_CAP));
      }
      parts.push("");
    }
  } else if (intent.workItemsError) {
    parts.push(`_Linked work items unavailable: ${intent.workItemsError}_`, "");
  } else if (intent.workItems) {
    parts.push("_No linked work items._", "");
  }
  if (intent.commits && intent.commits.length > 0) {
    parts.push("## Commit messages (newest first)", "");
    for (const message of intent.commits) {
      parts.push(`- ${cap(message, COMMIT_CAP).replace(/\n+/g, "\n  ")}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

/** The excerpt of the intent document placed at the top of each payload. */
export function intentExcerpt(rendered: string): string {
  const body = rendered.replace(/^# Change intent\s*/, "").trim();
  if (body.length <= PAYLOAD_INTENT_CAP) return body;
  return `${body.slice(0, PAYLOAD_INTENT_CAP)}\n\n…[excerpt; the full text is in intent.md]`;
}
