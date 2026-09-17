import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { RunStore } from "../core/store.ts";
import type { FileVerdict, Finding, NoteInput, Severity, VerdictValue } from "../types.ts";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const VERDICTS: VerdictValue[] = ["clean", "findings", "cross-batch"];

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Stable identity for a finding.
 *
 * Derived from the defect rather than from the wording, so re-running a batch
 * cannot create a second record of the same problem and posting can stay
 * idempotent across runs.
 */
function fingerprint(path: string, evidence: string, problem: string): string {
  const normalized = `${path}|${evidence.replace(/\s+/g, " ").trim()}|${problem
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)}`;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

function validateFinding(raw: Partial<Finding>, index: number, knownPaths: Set<string>): Finding {
  const where = `findings[${index}]`;
  const path = (raw.path ?? "").replace(/^\//, "");
  if (!path) fail(`${where}: "path" is required.`);
  if (!knownPaths.has(path)) {
    fail(
      `${where}: "${path}" is not a changed file in this pull request. ` +
        `Use a path exactly as it appears in files.json.`,
    );
  }
  const severity = raw.severity as Severity;
  if (!SEVERITIES.includes(severity)) {
    fail(`${where}: "severity" must be one of ${SEVERITIES.join(", ")}.`);
  }
  for (const field of ["problem", "evidence", "fix"] as const) {
    if (!raw[field] || !String(raw[field]).trim()) {
      fail(`${where}: "${field}" is required and must be non-empty.`);
    }
  }
  return {
    id: fingerprint(path, raw.evidence!, raw.problem!),
    path,
    line: typeof raw.line === "number" ? raw.line : undefined,
    endLine: typeof raw.endLine === "number" ? raw.endLine : undefined,
    severity,
    category: raw.category?.trim() || "bug",
    problem: raw.problem!.trim(),
    evidence: raw.evidence!,
    fix: raw.fix!.trim(),
    fixedCode: raw.fixedCode,
    status: "candidate",
    batch: raw.batch,
    createdAt: new Date().toISOString(),
  };
}

export interface NoteArgs {
  file: string;
  dir?: string;
}

/**
 * Records verdicts and candidate findings from a JSON file.
 *
 * Input arrives as a file rather than on stdin because the agent writes it
 * with its own file tool: no shell quoting, no heredocs, and no encoding
 * surprises with the severity icons that have to survive to the posted
 * comment.
 */
export async function note(args: NoteArgs): Promise<string> {
  const store = await RunStore.open(args.dir);
  const raw = await readFile(args.file, "utf8");
  let input: NoteInput;
  try {
    input = JSON.parse(raw) as NoteInput;
  } catch (err) {
    throw new Error(`${args.file} is not valid JSON: ${(err as Error).message}`);
  }

  const files = await store.readFiles();
  const knownPaths = new Set(files.map((f) => f.path));
  const reviewable = new Set(files.filter((f) => f.decision === "review").map((f) => f.path));

  const now = new Date().toISOString();
  const verdicts: FileVerdict[] = [];
  for (const [index, entry] of (input.verdicts ?? []).entries()) {
    const path = (entry.path ?? "").replace(/^\//, "");
    if (!reviewable.has(path)) {
      fail(
        `verdicts[${index}]: "${path}" is not a file this run reviews. ` +
          `Reviewable paths are listed in files.json with decision "review".`,
      );
    }
    if (!VERDICTS.includes(entry.verdict)) {
      fail(`verdicts[${index}]: "verdict" must be one of ${VERDICTS.join(", ")}.`);
    }
    verdicts.push({
      path,
      batch: input.batch ?? 0,
      verdict: entry.verdict,
      note: entry.note,
      at: now,
    });
  }

  const incoming = (input.findings ?? []).map((f, i) =>
    validateFinding({ ...f, batch: f.batch ?? input.batch }, i, knownPaths),
  );

  const existing = await store.readFindings();
  const seen = new Set(existing.map((f) => f.id));
  const fresh = incoming.filter((f) => !seen.has(f.id));

  await store.appendVerdicts(verdicts);
  await store.appendFindings(fresh);

  const retractIds = input.retract ?? [];
  let retracted = 0;
  if (retractIds.length > 0) {
    // Retraction rewrites in place rather than appending: a retracted finding
    // must disappear from the postable set, not merely gain a second, later
    // record that a reader could still mistake for current.
    const all = [...existing, ...fresh];
    const byId = new Map(all.map((f) => [f.id, f]));
    for (const id of retractIds) {
      if (!byId.has(id)) {
        fail(`retract: "${id}" is not a recorded finding id.`);
      }
    }
    const updated = all.map((f) =>
      retractIds.includes(f.id) ? { ...f, status: "retracted" as const } : f,
    );
    await store.replaceFindings(updated);
    retracted = retractIds.length;
  }

  const duplicates = incoming.length - fresh.length;
  const bySeverity = new Map<string, number>();
  for (const f of fresh) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);

  const lines = [
    `recorded ${verdicts.length} verdict(s), ${fresh.length} finding(s)` +
      (duplicates > 0 ? ` (${duplicates} already recorded, ignored)` : "") +
      (retracted > 0 ? `, ${retracted} finding(s) retracted` : ""),
  ];
  if (fresh.length > 0) {
    lines.push(`  severities: ${[...bySeverity].map(([s, n]) => `${s} x${n}`).join(", ")}`);
  }
  const done = new Set((await store.readVerdicts()).map((v) => v.path));
  lines.push(`coverage: ${done.size}/${reviewable.size} reviewable files have a verdict`);
  return lines.join("\n");
}
