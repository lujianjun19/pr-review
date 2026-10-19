import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { matchesAny, matchesGlob } from "./glob.ts";
import { showFile } from "./git.ts";
import type { Severity } from "../types.ts";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

/** Repository-relative location of the project rule file. */
export const PROJECT_RULE_PATH = ".pr-review/rules.json";

export interface RuleEntry {
  /** Glob the rule applies to, relative to the repository root. */
  path: string;
  /** Checklist text handed to the reviewer for matching files. Optional when only a threshold is set. */
  rule?: string;
  /** Keep the built-in rule for the same file instead of replacing it. */
  mergeBuiltin?: boolean;
  /** Lowest severity worth reporting for matching files; lower findings are suppressed. */
  minSeverity?: Severity;
}

/**
 * A project-specific risk signal.
 *
 * The built-in signals are technical only (security, contracts, concurrency,
 * state). The toolkit is business-agnostic, so which business areas of a
 * codebase deserve earlier attention is declared by the project, here.
 */
export interface RiskPathEntry {
  /** Glob matched against the repository-relative path. */
  path: string;
  /** Added to the risk score of matching files; 1–10. */
  weight: number;
  /** Signal label shown in files.json, e.g. "core-logic". */
  label?: string;
}

export interface RuleFile {
  rules?: RuleEntry[];
  /** Extra paths to drop from review, merged with the built-in exclusions. */
  exclude?: string[];
  /** Most Low findings a single review publishes; the rest are counted, not posted. */
  maxLowFindings?: number;
  /** Paths whose change always warrants a human reviewer, whatever else the risk tier says. */
  alwaysHuman?: string[];
  /** Extra risk signals that raise review priority for matching paths. */
  riskPaths?: RiskPathEntry[];
}

export interface ResolvedRules {
  /** Layers in priority order, highest first. */
  entries: RuleEntry[];
  exclude: string[];
  sources: string[];
  /** From the highest-priority layer that sets it. */
  maxLowFindings?: number;
  alwaysHuman: string[];
  /** Concatenated from every layer. */
  riskPaths: RiskPathEntry[];
}

export interface LoadRulesOptions {
  /**
   * Read the project rule file from this revision instead of the working tree.
   *
   * A pull request must not be able to configure its own review: a change that
   * adds `"exclude": ["**"]` would otherwise exempt itself. Reading the base
   * revision means rule changes take effect only once they are merged.
   */
  rev?: string;
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

/** Validates a parsed rule file, so a typo fails loudly instead of silently matching nothing. */
export function parseRuleFile(text: string, source: string): RuleFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${source} must contain a JSON object.`);
  }
  const file = raw as Record<string, unknown>;
  const out: RuleFile = {};

  if (file.rules !== undefined) {
    if (!Array.isArray(file.rules)) throw new Error(`${source}: "rules" must be an array.`);
    out.rules = file.rules.map((entry, i) => {
      const e = entry as Record<string, unknown>;
      const where = `${source}: rules[${i}]`;
      if (typeof e?.path !== "string" || !e.path) throw new Error(`${where}.path must be a non-empty string.`);
      if (e.rule !== undefined && typeof e.rule !== "string") throw new Error(`${where}.rule must be a string.`);
      if (e.minSeverity !== undefined && !SEVERITIES.includes(e.minSeverity as Severity)) {
        throw new Error(`${where}.minSeverity must be one of ${SEVERITIES.join(", ")}.`);
      }
      if (e.rule === undefined && e.minSeverity === undefined) {
        throw new Error(`${where} needs "rule", "minSeverity", or both.`);
      }
      return {
        path: e.path,
        ...(typeof e.rule === "string" ? { rule: e.rule } : {}),
        ...(e.mergeBuiltin === true ? { mergeBuiltin: true } : {}),
        ...(e.minSeverity !== undefined ? { minSeverity: e.minSeverity as Severity } : {}),
      };
    });
  }
  for (const key of ["exclude", "alwaysHuman"] as const) {
    const value = file[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(`${source}: "${key}" must be an array of glob strings.`);
    }
    out[key] = value as string[];
  }
  if (file.riskPaths !== undefined) {
    if (!Array.isArray(file.riskPaths)) throw new Error(`${source}: "riskPaths" must be an array.`);
    out.riskPaths = file.riskPaths.map((entry, i) => {
      const e = entry as Record<string, unknown>;
      const where = `${source}: riskPaths[${i}]`;
      if (typeof e?.path !== "string" || !e.path) throw new Error(`${where}.path must be a non-empty string.`);
      if (typeof e.weight !== "number" || !Number.isFinite(e.weight) || e.weight < 1 || e.weight > 10) {
        throw new Error(`${where}.weight must be a number from 1 to 10.`);
      }
      if (e.label !== undefined && (typeof e.label !== "string" || !e.label)) {
        throw new Error(`${where}.label must be a non-empty string.`);
      }
      return { path: e.path, weight: e.weight, ...(typeof e.label === "string" ? { label: e.label } : {}) };
    });
  }
  if (file.maxLowFindings !== undefined) {
    const n = file.maxLowFindings;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      throw new Error(`${source}: "maxLowFindings" must be a non-negative integer.`);
    }
    out.maxLowFindings = n;
  }
  return out;
}

async function loadRuleFile(path: string): Promise<RuleFile | undefined> {
  if (!existsSync(path)) return undefined;
  return parseRuleFile(await readFile(path, "utf8"), path);
}

/**
 * Resolves the rule layers for a repository.
 *
 * Priority is explicit file, then project, then user, then built-ins. Layers
 * are concatenated rather than merged per path, and the first matching entry
 * wins at lookup time — so a project rule shadows a built-in for the paths it
 * claims and only those.
 */
export async function loadRules(
  repoRoot: string,
  explicitPath?: string,
  opts: LoadRulesOptions = {},
): Promise<ResolvedRules> {
  const layers: { path: string; file: RuleFile | undefined }[] = [];

  if (explicitPath) {
    const file = await loadRuleFile(explicitPath);
    if (!file) throw new Error(`Rule file not found: ${explicitPath}`);
    layers.push({ path: explicitPath, file });
  }
  if (opts.rev) {
    const text = await showFile(repoRoot, opts.rev, PROJECT_RULE_PATH);
    const label = `${PROJECT_RULE_PATH}@${opts.rev.slice(0, 10)}`;
    layers.push({ path: label, file: text ? parseRuleFile(text, label) : undefined });
  } else {
    const projectPath = join(repoRoot, PROJECT_RULE_PATH);
    layers.push({ path: projectPath, file: await loadRuleFile(projectPath) });
  }
  const userPath = globalRulePath();
  layers.push({ path: userPath, file: await loadRuleFile(userPath) });

  const entries: RuleEntry[] = [];
  const exclude: string[] = [];
  const alwaysHuman: string[] = [];
  const riskPaths: RiskPathEntry[] = [];
  const sources: string[] = [];
  let maxLowFindings: number | undefined;
  for (const layer of layers) {
    if (!layer.file) continue;
    sources.push(layer.path);
    entries.push(...(layer.file.rules ?? []));
    exclude.push(...(layer.file.exclude ?? []));
    alwaysHuman.push(...(layer.file.alwaysHuman ?? []));
    riskPaths.push(...(layer.file.riskPaths ?? []));
    if (maxLowFindings === undefined && layer.file.maxLowFindings !== undefined) {
      maxLowFindings = layer.file.maxLowFindings;
    }
  }

  return {
    entries,
    exclude,
    sources,
    alwaysHuman,
    riskPaths,
    ...(maxLowFindings !== undefined ? { maxLowFindings } : {}),
  };
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

  if (!userRule) return builtin?.rule ? [builtin.rule] : [];
  const own = userRule.rule ? [userRule.rule] : [];
  // A threshold-only entry does not claim the checklist, so the built-in still applies.
  if ((userRule.mergeBuiltin || !userRule.rule) && builtin?.rule) return [...own, builtin.rule];
  return own;
}

/** Lowest severity worth reporting for a path, from the first matching rule entry. */
export function minSeverityForPath(path: string, resolved: ResolvedRules): Severity | undefined {
  return resolved.entries.find((entry) => matchesGlob(path, entry.path))?.minSeverity;
}

/** Reports whether user rules exclude a path from review. */
export function isExcludedByRules(path: string, resolved: ResolvedRules): boolean {
  return matchesAny(path, resolved.exclude);
}

/**
 * Project risk signals matching a path.
 *
 * Entries that share a label are one signal: a keyword usually needs two globs
 * (as a directory and as a file name), and a path matching both must not count
 * twice. The highest weight of the label wins.
 */
export function riskPathsFor(path: string, resolved: Pick<ResolvedRules, "riskPaths">): RiskPathEntry[] {
  const byKey = new Map<string, RiskPathEntry>();
  for (const entry of resolved.riskPaths) {
    if (!matchesGlob(path, entry.path)) continue;
    const key = entry.label ?? entry.path;
    const known = byKey.get(key);
    if (!known || entry.weight > known.weight) byKey.set(key, entry);
  }
  return [...byKey.values()];
}
