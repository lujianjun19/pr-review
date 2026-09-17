import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { matchesAny, matchesGlob } from "./glob.ts";

export interface RuleEntry {
  /** Glob the rule applies to, relative to the repository root. */
  path: string;
  /** Checklist text handed to the reviewer for matching files. */
  rule: string;
  /** Keep the built-in rule for the same file instead of replacing it. */
  mergeBuiltin?: boolean;
}

export interface RuleFile {
  rules?: RuleEntry[];
  /** Extra paths to drop from review, merged with the built-in exclusions. */
  exclude?: string[];
}

export interface ResolvedRules {
  /** Layers in priority order, highest first. */
  entries: RuleEntry[];
  exclude: string[];
  sources: string[];
}

/**
 * Built-in rules.
 *
 * Kept deliberately short. The general review dimensions live in
 * reference/standards.md, which the reviewer already reads; rules exist for the
 * narrower, per-path constraints a project wants enforced, so shipping a long
 * default list here would only add prompt weight without adding information.
 */
const BUILTIN_RULES: RuleEntry[] = [
  {
    path: "**/migrations/**",
    rule: "Check reversibility, locking on large tables, and behaviour against rows written by the previous version.",
  },
  {
    path: "**/*.{test,spec}.{ts,tsx,js,jsx}",
    rule: "Check that assertions were strengthened, not removed or loosened, and that new behaviour is covered.",
  },
  {
    path: "**/{Dockerfile,*.tf,*.tfvars,*.yaml,*.yml}",
    rule: "Check for credentials, over-broad permissions, and image or module sources that are not pinned.",
  },
];

function globalRulePath(): string {
  if (platform() === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "pr-review", "rules.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), ".config"), "pr-review", "rules.json");
}

async function loadRuleFile(path: string): Promise<RuleFile | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as RuleFile;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Resolves the rule layers for a repository.
 *
 * Priority is explicit file, then project, then user, then built-ins. Layers
 * are concatenated rather than merged per path, and the first matching entry
 * wins at lookup time — so a project rule shadows a built-in for the paths it
 * claims and only those.
 */
export async function loadRules(repoRoot: string, explicitPath?: string): Promise<ResolvedRules> {
  const layers: { path: string; file: RuleFile | undefined }[] = [];

  if (explicitPath) {
    const file = await loadRuleFile(explicitPath);
    if (!file) throw new Error(`Rule file not found: ${explicitPath}`);
    layers.push({ path: explicitPath, file });
  }
  const projectPath = join(repoRoot, ".pr-review", "rules.json");
  layers.push({ path: projectPath, file: await loadRuleFile(projectPath) });
  const userPath = globalRulePath();
  layers.push({ path: userPath, file: await loadRuleFile(userPath) });

  const entries: RuleEntry[] = [];
  const exclude: string[] = [];
  const sources: string[] = [];
  for (const layer of layers) {
    if (!layer.file) continue;
    sources.push(layer.path);
    entries.push(...(layer.file.rules ?? []));
    exclude.push(...(layer.file.exclude ?? []));
  }

  return { entries, exclude, sources };
}

/**
 * Returns the checklist for one path.
 *
 * At most one user rule applies — the first that matches — because a file
 * carrying five overlapping checklists tells the reviewer less than one that
 * states the constraint that actually matters. A built-in is appended only when
 * the matching rule asks for it, or when no user rule claimed the path.
 */
export function rulesForPath(path: string, resolved: ResolvedRules): string[] {
  const userRule = resolved.entries.find((entry) => matchesGlob(path, entry.path));
  const builtin = BUILTIN_RULES.find((entry) => matchesGlob(path, entry.path));

  if (!userRule) return builtin ? [builtin.rule] : [];
  if (userRule.mergeBuiltin && builtin) return [userRule.rule, builtin.rule];
  return [userRule.rule];
}

/** Reports whether user rules exclude a path from review. */
export function isExcludedByRules(path: string, resolved: ResolvedRules): boolean {
  return matchesAny(path, resolved.exclude);
}
