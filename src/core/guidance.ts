/**
 * Repository guidance files that apply to a change.
 *
 * Teams already write down how their code should look in agent instruction
 * files. A review that ignores them re-derives conventions the owners stated
 * explicitly, and misses violations of rules that exist only there. Like the
 * rule file, guidance is read from the base revision: a pull request must not
 * be able to rewrite the instructions it is reviewed against.
 */

import { matchesAny } from "./glob.ts";

/** File names honoured in any directory on the path to a changed file. */
const SCOPED_NAMES = ["AGENTS.md", "CLAUDE.md", "REVIEW.md"];

/**
 * Copilot instruction files, honoured in any `.github` directory.
 *
 * A monorepo often keeps one `.github` per workspace (for example
 * `web/.github/`), so the directory holding `.github` is the scope.
 */
const COPILOT_FILE = /^(?:(.*)\/)?\.github\/copilot-instructions\.md$/;
const INSTRUCTIONS_FILE = /^(?:(.*)\/)?\.github\/instructions\/[^/]+\.instructions\.md$/;

export interface GuidanceRef {
  /** Repository-relative path of the guidance file. */
  path: string;
  /** "review" for review-only instructions, "project" for general agent guidance. */
  kind: "review" | "project";
  /** Directory the file governs; empty for the repository root. */
  scope: string;
  /** Globs relative to the scope, from an instructions file's `applyTo` front matter. */
  applyTo?: string[];
}

/** Path-scoped instruction files in a tree; their content is needed to read `applyTo`. */
export function instructionFiles(tree: string[]): string[] {
  return tree.filter((path) => INSTRUCTIONS_FILE.test(path));
}

/**
 * Reads the `applyTo` globs from an instructions file's front matter.
 *
 * Returns undefined when the file declares none: such files are attached by
 * hand in the editor and are not meant to apply automatically.
 */
export function parseApplyTo(content: string): string[] | undefined {
  const front = /^---\r?\n([^]*?)\r?\n---/.exec(content);
  if (!front) return undefined;
  const line = /^applyTo:\s*(.+)$/m.exec(front[1]);
  if (!line) return undefined;
  const value = line[1].trim().replace(/^["']|["']$/g, "");
  // Commas separate globs, except inside a brace alternation such as *.{ts,tsx}.
  const globs: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      globs.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  globs.push(current);
  const cleaned = globs.map((glob) => glob.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

function relativeTo(scope: string, path: string): string {
  return scope ? path.slice(scope.length + 1) : path;
}

function underScope(scope: string, path: string): boolean {
  return scope === "" || path.startsWith(`${scope}/`);
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Every ancestor directory of a path, root first. */
function ancestors(path: string): string[] {
  const dirs = [""];
  const parts = dirOf(path).split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
  return dirs;
}

/**
 * Selects the guidance files that govern at least one changed path.
 *
 * Pure: `tree` is the file list of the base revision. A subdirectory file
 * applies only when the change touches something underneath it, so a
 * monorepo's per-module instructions do not leak into unrelated reviews.
 */
export function selectGuidance(
  tree: string[],
  changedPaths: string[],
  instructionContents: Map<string, string> = new Map(),
): GuidanceRef[] {
  const present = new Set(tree);
  const selected = new Map<string, GuidanceRef>();

  for (const path of tree) {
    const copilot = COPILOT_FILE.exec(path);
    if (copilot) {
      const scope = copilot[1] ?? "";
      if (changedPaths.some((changed) => underScope(scope, changed))) {
        selected.set(path, { path, kind: "project", scope });
      }
      continue;
    }
    const scoped = INSTRUCTIONS_FILE.exec(path);
    if (scoped) {
      const scope = scoped[1] ?? "";
      const applyTo = parseApplyTo(instructionContents.get(path) ?? "");
      if (!applyTo) continue;
      const ref: GuidanceRef = { path, kind: "project", scope, applyTo };
      if (changedPaths.some((changed) => appliesTo(ref, changed))) selected.set(path, ref);
    }
  }
  const dirs = new Set<string>();
  for (const path of changedPaths) for (const dir of ancestors(path)) dirs.add(dir);
  for (const dir of dirs) {
    for (const name of SCOPED_NAMES) {
      const candidate = dir ? `${dir}/${name}` : name;
      if (!present.has(candidate)) continue;
      selected.set(candidate, {
        path: candidate,
        kind: name === "REVIEW.md" ? "review" : "project",
        scope: dir,
      });
    }
  }
  return [...selected.values()].sort(
    (a, b) => a.scope.split("/").length - b.scope.split("/").length || a.path.localeCompare(b.path),
  );
}

function appliesTo(ref: GuidanceRef, path: string): boolean {
  if (!underScope(ref.scope, path)) return false;
  return ref.applyTo ? matchesAny(relativeTo(ref.scope, path), ref.applyTo) : true;
}

/** Guidance that governs one path: every selected file whose scope and globs contain it. */
export function guidanceForPath(path: string, refs: GuidanceRef[]): GuidanceRef[] {
  return refs.filter((ref) => appliesTo(ref, path));
}

/** Reports whether a changed path is itself review configuration or guidance. */
export function isReviewConfiguration(path: string): boolean {
  if (path === ".pr-review/rules.json") return true;
  if (COPILOT_FILE.test(path) || INSTRUCTIONS_FILE.test(path)) return true;
  return SCOPED_NAMES.includes(baseName(path));
}

/** Largest share of one guidance file copied into the run. */
export const GUIDANCE_FILE_CAP = 12_000;

/** Renders the selected guidance files into one document for the run directory. */
export function renderGuidance(refs: GuidanceRef[], contents: Map<string, string>): string {
  const parts = [
    "# Repository guidance",
    "",
    "Read from the base revision. A violation of a stated rule is a finding at whatever severity",
    "the consequence warrants; guidance about style or tone is not a reason to report anything.",
    "",
  ];
  for (const ref of refs) {
    const text = (contents.get(ref.path) ?? "").trim();
    if (!text) continue;
    const capped =
      text.length > GUIDANCE_FILE_CAP
        ? `${text.slice(0, GUIDANCE_FILE_CAP)}\n\n[truncated at ${GUIDANCE_FILE_CAP} characters]`
        : text;
    const governs = ref.scope ? `${ref.scope}/` : "the whole repository";
    parts.push(
      `## ${ref.path} (${ref.kind}, governs ${governs}${ref.applyTo ? `, applyTo ${ref.applyTo.join(", ")}` : ""})`,
    );
    parts.push("");
    parts.push(capped);
    parts.push("");
  }
  return parts.join("\n");
}
