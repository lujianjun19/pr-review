import { prepare } from "./commands/prepare.ts";
import { note } from "./commands/note.ts";
import { finalize } from "./commands/finalize.ts";
import { post } from "./commands/post.ts";
import { RunStore } from "./core/store.ts";
import { showFile, grepAtRev, repoRoot } from "./core/git.ts";
import { loadRules, rulesForPath, isExcludedByRules } from "./core/rules.ts";
import { TOOL_VERSION } from "./version.ts";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Lines returned by `prr context` when no explicit range is given. */
const DEFAULT_CONTEXT_LINES = 120;

/** Hard ceiling for a single context read, however wide the request. */
const MAX_CONTEXT_LINES = 500;

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[arg.slice(2)] = argv[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function num(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const USAGE = `prr ${TOOL_VERSION} — deterministic toolkit for Azure DevOps pull request review

Usage:
  prr prepare <pr-url|pr-id> [--repo <path>] [--iteration <n>] [--since <n>]
                             [--max-files <n>] [--max-tokens <n>] [--rule <path>]
                             [--reset]
  prr prepare --branch <base-ref> [...]
  prr prepare --working-tree [...]
      Pin the revisions, triage every changed file, build risk-ordered batches
      and write one review payload per batch. Run this once per review.
      --branch reviews the current branch against its merge base with <base-ref>;
      --working-tree reviews uncommitted and untracked work against HEAD.

  prr note --file <path.json> [--dir <run>]
      Record file verdicts and candidate findings from a JSON file.

  prr finalize [--render] [--format md|sarif|json] [--dir <run>]
      Verify every finding's evidence against the source revision, resolve its
      line, check coverage. --render prints the findings.

  prr context --path <p> [--start <n>] [--end <n>] [--dir <run>]
      Read a window of a file at the source revision. Defaults to 120 lines
      from --start; an explicit --end widens it up to 500.

  prr grep <pattern> [--path <pathspec>] [--regex] [--files-only] [--max <n>]
           [--dir <run>]
      Search the source revision for a symbol or literal. Use this instead of
      shell grep: the repository may have no checkout, only the fetched commits.

  prr rules check <path> [--repo <path>] [--rule <path>]
      Show which review rules apply to a path, and from which layer.

  prr post [--min-severity critical|high|medium|low] [--summary <path.md>]
           [--dry-run] [--dir <run>]
      Publish verified findings as inline threads. Requires explicit user
      approval. Idempotent: a finding already posted is never posted again.

  prr status [--dir <run>]
      Print the current state of the run.
`;

async function context(flags: Record<string, string | boolean>): Promise<string> {
  const store = await RunStore.open(str(flags.dir));
  const meta = await store.meta();
  const path = str(flags.path);
  if (!path) throw new Error("`prr context` requires --path.");
  const content = await showFile(meta.repoRoot, meta.sourceSHA, path);
  if (!content) throw new Error(`${path} does not exist at ${meta.sourceSHA.slice(0, 10)}.`);

  const lines = content.split("\n");
  const start = Math.max(1, num(flags.start) ?? 1);
  // A default window that answers "what does this function do" without pulling a
  // whole file into the conversation. An explicit --end may widen it up to the
  // hard cap, so one read cannot flood the context either way.
  const requestedEnd = num(flags.end) ?? start + DEFAULT_CONTEXT_LINES - 1;
  const end = Math.min(lines.length, requestedEnd, start + MAX_CONTEXT_LINES - 1);
  const slice = lines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(5, " ")} ${line}`);
  const suffix = end < lines.length ? `\n... ${lines.length - end} more line(s)` : "";
  return `${path} @ ${meta.sourceSHA.slice(0, 10)} lines ${start}-${end} of ${lines.length}\n${slice.join("\n")}${suffix}`;
}

/**
 * Searches the reviewed revision for a symbol or literal.
 *
 * The repository often holds only the two fetched commits with no checkout, so
 * an ordinary grep over the working tree finds nothing. This searches the tree
 * the review is actually about.
 */
async function grep(
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<string> {
  const store = await RunStore.open(str(flags.dir));
  const meta = await store.meta();
  const pattern = positional[0] ?? str(flags.pattern);
  if (!pattern) throw new Error("`prr grep` requires a pattern.");

  const pathspec = str(flags.path);
  const max = num(flags.max) ?? 100;
  const { matches, truncated } = await grepAtRev(meta.repoRoot, meta.sourceSHA, pattern, {
    regex: flags.regex === true,
    ...(pathspec ? { pathspec: [pathspec] } : {}),
    max,
  });

  if (matches.length === 0) {
    return `no match for ${JSON.stringify(pattern)} at ${meta.sourceSHA.slice(0, 10)}`;
  }

  if (flags["files-only"] === true) {
    const files = [...new Set(matches.map((m) => m.path))];
    return `${files.length} file(s) match ${JSON.stringify(pattern)}\n${files.join("\n")}`;
  }

  const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text.slice(0, 200)}`);
  const header = `${matches.length} match(es) for ${JSON.stringify(pattern)} at ${meta.sourceSHA.slice(0, 10)}`;
  return truncated
    ? `${header} (capped at ${max}; narrow with --path or --files-only)\n${lines.join("\n")}`
    : `${header}\n${lines.join("\n")}`;
}

/** Shows which rules apply to a path, so a project can verify its own configuration. */
async function rulesCheck(
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<string> {
  if (positional[0] !== "check" || !positional[1]) {
    throw new Error("Usage: prr rules check <path>");
  }
  const path = positional[1].replace(/^\//, "");
  const root = await repoRoot(str(flags.repo) ?? process.cwd());
  const resolved = await loadRules(root, str(flags.rule));

  const lines = [`${path} @ ${root}`];
  lines.push(
    resolved.sources.length > 0
      ? `rule files: ${resolved.sources.join(", ")}`
      : "rule files: none (built-in rules only)",
  );
  if (isExcludedByRules(path, resolved)) {
    lines.push("excluded: yes — this path is skipped before review");
    return lines.join("\n");
  }
  const applicable = rulesForPath(path, resolved);
  if (applicable.length === 0) {
    lines.push("rules: none — reviewed against reference/standards.md only");
  } else {
    lines.push("rules:");
    lines.push(...applicable.map((rule) => `  - ${rule}`));
  }
  return lines.join("\n");
}

async function status(flags: Record<string, string | boolean>): Promise<string> {
  const store = await RunStore.open(str(flags.dir));
  const meta = await store.meta();
  const files = await store.readFiles();
  const batches = await store.readBatches();
  const verdicts = await store.readVerdicts();
  const findings = await store.readFindings();

  const reviewable = files.filter((f) => f.decision === "review");
  const done = new Set(verdicts.map((v) => v.path));
  const pending = batches.filter((b) => !b.files.every((f) => done.has(f)));

  const lines = [
    meta.scope === "ado-pr" ? `PR ${meta.prId} · ${meta.title}` : `${meta.scope} · ${meta.title}`,
    `source ${meta.sourceSHA.slice(0, 10)} · run ${meta.runDir}`,
    `coverage ${done.size}/${reviewable.length} · findings ${findings.length}`,
  ];
  if (pending.length > 0) {
    lines.push(`pending batches: ${pending.map((b) => `b${String(b.id).padStart(2, "0")}`).join(", ")}`);
    lines.push(`next: read ${meta.runDir}/${pending[0].payload}`);
  } else {
    lines.push("all batches reviewed · next: prr finalize");
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case "prepare": {
      const target = positional[0] ?? str(flags.pr);
      const branch = str(flags.branch);
      const workingTree = flags["working-tree"] === true;
      console.log(
        await prepare({
          ...(target ? { target } : {}),
          ...(branch ? { branch } : {}),
          workingTree,
          repo: str(flags.repo),
          iteration: num(flags.iteration),
          since: num(flags.since),
          maxFiles: num(flags["max-files"]),
          maxTokens: num(flags["max-tokens"]),
          rule: str(flags.rule),
          reset: flags.reset === true,
        }),
      );
      return 0;
    }
    case "note": {
      const file = str(flags.file) ?? positional[0];
      if (!file) throw new Error("`prr note` requires --file <path.json>.");
      console.log(await note({ file, dir: str(flags.dir) }));
      return 0;
    }
    case "finalize": {
      const format = str(flags.format) as "md" | "sarif" | "json" | undefined;
      const result = await finalize({
        dir: str(flags.dir),
        render: flags.render === true || format !== undefined,
        ...(format ? { format } : {}),
      });
      console.log(result.output);
      return result.ok ? 0 : 1;
    }
    case "context":
      console.log(await context(flags));
      return 0;
    case "grep":
      console.log(await grep(positional, flags));
      return 0;
    case "rules":
      console.log(await rulesCheck(positional, flags));
      return 0;
    case "post": {
      const severity = str(flags["min-severity"]) as
        | "critical"
        | "high"
        | "medium"
        | "low"
        | undefined;
      console.log(
        await post({
          dir: str(flags.dir),
          minSeverity: severity,
          dryRun: flags["dry-run"] === true,
          summaryFile: str(flags.summary),
        }),
      );
      return 0;
    }
    case "status":
      console.log(await status(flags));
      return 0;
    case "--version":
    case "version":
      console.log(TOOL_VERSION);
      return 0;
    default:
      console.log(USAGE);
      return command && command !== "--help" && command !== "help" ? 2 : 0;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`prr: ${(err as Error).message}`);
    process.exitCode = 1;
  });
