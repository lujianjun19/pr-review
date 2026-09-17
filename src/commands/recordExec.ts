import { spawn } from "node:child_process";
import { RunStore } from "../core/store.ts";
import type { ValidationRecord } from "../types.ts";

const MAX_CAPTURE_CHARS = 16_000;
const SECRET_ENV_KEYS = [
  "AZURE_DEVOPS_EXT_PAT",
  "AZURE_DEVOPS_PAT",
  "SYSTEM_ACCESSTOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

export interface RecordExecArgs {
  command: string[];
  dir?: string;
  timeoutSeconds?: number;
}

function redact(text: string): string {
  let result = text;
  for (const key of SECRET_ENV_KEYS) {
    const secret = process.env[key];
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, "$1[REDACTED]@")
    .replace(
      /^([^\n=]*(?:TOKEN|PASSWORD|SECRET|API_KEY)[^\n=]*)=.*$/gim,
      "$1=[REDACTED]",
    );
}

function truncate(text: string): string {
  if (text.length <= MAX_CAPTURE_CHARS) return text;
  const omitted = text.length - MAX_CAPTURE_CHARS;
  return `[... ${omitted} character(s) omitted ...]\n${text.slice(-MAX_CAPTURE_CHARS)}`;
}

function commandLabel(command: string[]): string {
  return command.map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

/**
 * Executes one explicit argv vector and records the result in the review run.
 *
 * No shell is involved: redirects, substitutions and pipes are not interpreted.
 * That keeps the command auditable and avoids turning a validation helper into
 * an arbitrary shell interpolation surface.
 */
export async function recordExec(
  args: RecordExecArgs,
): Promise<{ output: string; exitCode: number }> {
  if (args.command.length === 0) {
    throw new Error("`prr exec --record` requires a command after `--`.");
  }
  const store = await RunStore.open(args.dir);
  const meta = await store.meta();
  const [executable, ...commandArgs] = args.command;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const timeoutMs = Math.max(1, args.timeoutSeconds ?? 300) * 1000;

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(executable, commandArgs, {
      cwd: meta.repoRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      stderr += `${err.message}\n`;
      resolve(127);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(timedOut ? 124 : (code ?? 1));
    });
  });

  const record: ValidationRecord = {
    command: args.command.map(redact),
    cwd: meta.repoRoot,
    sourceSHA: meta.sourceSHA,
    startedAt,
    durationMs: Date.now() - started,
    exitCode,
    timedOut,
    stdout: truncate(redact(stdout.trimEnd())),
    stderr: truncate(redact(stderr.trimEnd())),
  };
  await store.appendValidation(record);

  return {
    output: [
      `${meta.scope === "ado-pr" ? `PR ${meta.prId}` : meta.scope} · ${meta.sourceSHA.slice(0, 10)}`,
      `validation: ${commandLabel(record.command)}`,
      `exit ${exitCode} · ${record.durationMs} ms${timedOut ? " · timed out" : ""}`,
      `recorded: ${store.path("validations.jsonl")}`,
    ].join("\n"),
    exitCode,
  };
}
