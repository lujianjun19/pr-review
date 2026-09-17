import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Raised when an external process exits non-zero. */
export class ProcError extends Error {
  readonly stderr: string;
  readonly code: number | null;

  constructor(message: string, stderr: string, code: number | null) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

export interface RunOptions {
  cwd?: string;
  /** Extra environment entries merged over process.env. */
  env?: Record<string, string>;
  /** 64 MiB by default: git diffs of large pull requests overflow the node default. */
  maxBuffer?: number;
  /** Return an empty string instead of throwing when the process fails. */
  allowFailure?: boolean;
  /**
   * Exit codes that mean success for this command.
   *
   * `git diff --no-index` exits 1 to report that the files differ, which is the
   * answer being asked for; without this the output would be discarded as a
   * failure and an added file would silently produce an empty diff.
   */
  okExitCodes?: number[];
}

/** Runs a command and returns trimmed stdout. */
export async function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout.trimEnd();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; code?: number };
    const code = typeof e.code === "number" ? e.code : null;
    if (code !== null && opts.okExitCodes?.includes(code)) {
      return (e.stdout ?? "").toString().trimEnd();
    }
    if (opts.allowFailure) return "";
    const stderr = (e.stderr ?? "").toString().trim();
    throw new ProcError(
      `${cmd} ${args.join(" ")} failed: ${stderr || e.message}`,
      stderr,
      code,
    );
  }
}

/** Reports whether a command exists on PATH. */
export async function exists(cmd: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(probe, [cmd]);
    return true;
  } catch {
    return false;
  }
}
