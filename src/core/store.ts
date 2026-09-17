import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { run } from "../util/proc.ts";
import type {
  Batch,
  ChangedFile,
  FileVerdict,
  Finding,
  ReviewThread,
  RunMeta,
} from "../types.ts";

/** Cache root for run state. Never written inside the repository under review. */
export function cacheRoot(): string {
  const override = process.env.PR_REVIEW_HOME;
  if (override) return override;
  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, "pr-review");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg || join(homedir(), ".cache"), "pr-review");
}

/**
 * Names the run directory.
 *
 * The revision is part of the key so a new push starts a clean run instead of
 * inheriting verdicts that describe code no longer under review. A working
 * tree has no revision of its own, so it is keyed by the commit it sits on.
 */
export function runDirFor(meta: {
  scope: string;
  org?: string;
  repo: string;
  prId?: number;
  sourceSHA: string;
  targetSHA: string;
}): string {
  const revision = meta.sourceSHA === "WORKTREE" ? meta.targetSHA : meta.sourceSHA;
  const subject =
    meta.scope === "ado-pr"
      ? `${meta.org}-${meta.repo}-pr${meta.prId}`
      : `${meta.repo}-${meta.scope}`;
  const slug = `${subject}-${revision.slice(0, 12)}`.replace(/[^\w.-]/g, "_");
  return join(cacheRoot(), slug);
}

/**
 * Locates the run to operate on.
 *
 * Commands after `prepare` take no target argument, so the run has to be
 * inferred. Inferring it from time alone is not enough: preparing a second
 * review in another repository would silently redirect every later command at
 * that one. Runs rooted in the current repository are therefore preferred, and
 * only when none exist does the most recent run anywhere win.
 */
export async function findLatestRun(cwd?: string): Promise<string> {
  const root = cacheRoot();
  if (!existsSync(root)) throw new Error("No prepared run found. Run `prr prepare <pr>` first.");

  const here = (
    await run("git", ["rev-parse", "--show-toplevel"], {
      cwd: cwd ?? process.cwd(),
      allowFailure: true,
    })
  ).trim();

  const entries = await readdir(root, { withFileTypes: true });
  const candidates: { dir: string; at: number; repoRoot: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(root, entry.name, "run.json");
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
    candidates.push({
      dir: join(root, entry.name),
      at: Date.parse(meta.createdAt) || 0,
      repoRoot: meta.repoRoot ?? "",
    });
  }
  if (candidates.length === 0) {
    throw new Error("No prepared run found. Run `prr prepare <pr>` first.");
  }

  const local = here ? candidates.filter((c) => c.repoRoot === here) : [];
  const pool = local.length > 0 ? local : candidates;
  pool.sort((a, b) => b.at - a.at);
  return pool[0].dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** Filesystem-backed state for one review run. */
export class RunStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  static async create(meta: RunMeta): Promise<RunStore> {
    await mkdir(join(meta.runDir, "payload"), { recursive: true });
    const store = new RunStore(meta.runDir);
    await writeJson(store.path("run.json"), meta);
    return store;
  }

  static async open(dir?: string): Promise<RunStore> {
    const resolved = dir ?? (await findLatestRun());
    if (!existsSync(join(resolved, "run.json"))) {
      throw new Error(`Not a prepared run directory: ${resolved}`);
    }
    return new RunStore(resolved);
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  meta(): Promise<RunMeta> {
    return readJson<RunMeta>(this.path("run.json"), undefined as unknown as RunMeta);
  }

  writePullRequest(value: unknown): Promise<void> {
    return writeJson(this.path("pr.json"), value);
  }

  writeThreads(threads: ReviewThread[]): Promise<void> {
    return writeJson(this.path("threads.json"), threads);
  }

  readThreads(): Promise<ReviewThread[]> {
    return readJson<ReviewThread[]>(this.path("threads.json"), []);
  }

  writeFiles(files: ChangedFile[]): Promise<void> {
    return writeJson(this.path("files.json"), files);
  }

  readFiles(): Promise<ChangedFile[]> {
    return readJson<ChangedFile[]>(this.path("files.json"), []);
  }

  writeBatches(batches: Batch[]): Promise<void> {
    return writeJson(this.path("batches.json"), batches);
  }

  readBatches(): Promise<Batch[]> {
    return readJson<Batch[]>(this.path("batches.json"), []);
  }

  writePayload(relative: string, content: string): Promise<void> {
    return writeFile(this.path(relative), content, "utf8");
  }

  readVerdicts(): Promise<FileVerdict[]> {
    return readJsonl<FileVerdict>(this.path("verdicts.jsonl"));
  }

  async appendVerdicts(verdicts: FileVerdict[]): Promise<void> {
    if (verdicts.length === 0) return;
    const lines = verdicts.map((v) => JSON.stringify(v)).join("\n");
    await appendFile(this.path("verdicts.jsonl"), `${lines}\n`, "utf8");
  }

  readFindings(): Promise<Finding[]> {
    return readJsonl<Finding>(this.path("findings.jsonl"));
  }

  async appendFindings(findings: Finding[]): Promise<void> {
    if (findings.length === 0) return;
    const lines = findings.map((f) => JSON.stringify(f)).join("\n");
    await appendFile(this.path("findings.jsonl"), `${lines}\n`, "utf8");
  }

  async replaceFindings(findings: Finding[]): Promise<void> {
    const lines = findings.map((f) => JSON.stringify(f)).join("\n");
    await writeFile(this.path("findings.jsonl"), findings.length ? `${lines}\n` : "", "utf8");
  }

  /** Number of verdicts already recorded for this revision. */
  async carriedProgress(): Promise<number> {
    const verdicts = await this.readVerdicts();
    return new Set(verdicts.map((v) => v.path)).size;
  }

  /**
   * Clears recorded progress while keeping the pinned evidence.
   *
   * Re-running `prepare` on the same revision is normally a resume, so
   * verdicts and findings survive by default; discarding them has to be asked
   * for explicitly.
   */
  async resetProgress(): Promise<void> {
    await writeFile(this.path("verdicts.jsonl"), "", "utf8");
    await writeFile(this.path("findings.jsonl"), "", "utf8");
  }
}
