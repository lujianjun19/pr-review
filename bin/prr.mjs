#!/usr/bin/env node

// src/util/proc.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var ProcError = class extends Error {
  stderr;
  code;
  constructor(message, stderr, code) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
};
async function run(cmd, args, opts = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      encoding: "utf8"
    });
    return stdout.trimEnd();
  } catch (err) {
    const e = err;
    const code = typeof e.code === "number" ? e.code : null;
    if (code !== null && opts.okExitCodes?.includes(code)) {
      return (e.stdout ?? "").toString().trimEnd();
    }
    if (opts.allowFailure) return "";
    const stderr = (e.stderr ?? "").toString().trim();
    throw new ProcError(
      `${cmd} ${args.join(" ")} failed: ${stderr || e.message}`,
      stderr,
      code
    );
  }
}

// src/ado/auth.ts
var ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
var cached;
async function getCredential() {
  if (cached) return cached;
  const pat = process.env.AZURE_DEVOPS_EXT_PAT || process.env.AZURE_DEVOPS_PAT || process.env.SYSTEM_ACCESSTOKEN;
  if (pat && pat.trim()) {
    const basic = Buffer.from(`:${pat.trim()}`).toString("base64");
    cached = { header: `Basic ${basic}`, source: "pat-env" };
    return cached;
  }
  let token;
  try {
    token = await run("az", [
      "account",
      "get-access-token",
      "--resource",
      ADO_RESOURCE,
      "--query",
      "accessToken",
      "-o",
      "tsv"
    ]);
  } catch {
    throw new Error(
      "No Azure DevOps credential. Set AZURE_DEVOPS_EXT_PAT, or run `az login` so `az account get-access-token` can issue a token."
    );
  }
  token = token.replace(/[\r\n]/g, "").trim();
  if (!token) throw new Error("az returned an empty access token; run `az login` again.");
  cached = { header: `Bearer ${token}`, source: "az-cli" };
  return cached;
}

// src/ado/client.ts
var API_VERSION = "7.1";
var WORK_ITEM_FIELDS = [
  "System.Title",
  "System.WorkItemType",
  "System.State",
  "System.Description",
  "Microsoft.VSTS.Common.AcceptanceCriteria",
  "Microsoft.VSTS.TCM.ReproSteps"
];
var AdoClient = class {
  target;
  constructor(target) {
    this.target = target;
  }
  base() {
    const { org, project, repo } = this.target;
    return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
  }
  async request(path, init) {
    const url = `${this.base()}${path}${path.includes("?") ? "&" : "?"}api-version=${API_VERSION}`;
    return this.requestUrl(url, init);
  }
  async requestUrl(url, init) {
    const cred = await getCredential();
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: cred.header,
        Accept: "application/json",
        ...init?.body ? { "Content-Type": "application/json" } : {},
        ...init?.headers
      }
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      throw new Error(`Azure DevOps ${res.status} ${res.statusText} for ${url}
${body}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `Azure DevOps returned a non-JSON response for ${url}. The credential is probably not valid for this organization.`
      );
    }
  }
  getPullRequest(prId) {
    return this.request(`/pullRequests/${prId}`);
  }
  async listIterations(prId) {
    const res = await this.request(`/pullRequests/${prId}/iterations`);
    return res.value ?? [];
  }
  async listIterationChanges(prId, iterationId, compareTo) {
    const query = new URLSearchParams({ $top: "2000" });
    if (compareTo !== void 0) query.set("$compareTo", String(compareTo));
    const res = await this.request(
      `/pullRequests/${prId}/iterations/${iterationId}/changes?${query.toString()}`
    );
    return res.changeEntries ?? [];
  }
  async listThreads(prId) {
    const res = await this.request(`/pullRequests/${prId}/threads`);
    return (res.value ?? []).map(normalizeThread);
  }
  async listPullRequestStatuses(prId) {
    const res = await this.request(`/pullRequests/${prId}/statuses`);
    return res.value ?? [];
  }
  async listPolicyEvaluations(prId, projectId) {
    const { org, project } = this.target;
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
    const query = new URLSearchParams({ artifactId, "api-version": "7.1-preview.1" });
    const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/policy/evaluations?${query.toString()}`;
    const res = await this.requestUrl(url);
    return res.value ?? [];
  }
  /** Ids of the work items linked to a pull request. */
  async listPullRequestWorkItemIds(prId) {
    const res = await this.request(
      `/pullRequests/${prId}/workitems`
    );
    return (res.value ?? []).map((ref) => Number(ref.id)).filter((id) => Number.isInteger(id) && id > 0);
  }
  /**
   * Reads the fields that state what a work item asks for.
   *
   * `errorPolicy=Omit` keeps one deleted or inaccessible item from failing the
   * whole request; it comes back as null and is dropped.
   */
  async getWorkItems(ids) {
    if (ids.length === 0) return [];
    const { org, project } = this.target;
    const query = new URLSearchParams({
      ids: ids.join(","),
      fields: WORK_ITEM_FIELDS.join(","),
      errorPolicy: "Omit",
      "api-version": API_VERSION
    });
    const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems?${query.toString()}`;
    const res = await this.requestUrl(url);
    return (res.value ?? []).filter((item) => item !== null);
  }
  /** Creates a comment thread. The body is sent as JSON, so emoji survive intact. */
  createThread(prId, body) {
    return this.request(`/pullRequests/${prId}/threads`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }
  /**
   * Appends a comment to an existing thread.
   *
   * Corrections are replies rather than edits: the original comment stays
   * visible so a reader can see what was claimed and what it was replaced by.
   */
  replyToThread(prId, threadId, content) {
    return this.request(`/pullRequests/${prId}/threads/${threadId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content, commentType: 1 })
    });
  }
  /** Changes a thread's status, e.g. to close a retracted finding. */
  setThreadStatus(prId, threadId, status2) {
    return this.request(
      `/pullRequests/${prId}/threads/${threadId}`,
      { method: "PATCH", body: JSON.stringify({ status: status2 }) }
    );
  }
};
var COMMENT_TYPES = ["unknown", "text", "codeChange", "system"];
var THREAD_STATUSES = [
  "unknown",
  "active",
  "fixed",
  "wontFix",
  "closed",
  "byDesign",
  "pending"
];
function enumName(value, names, fallback) {
  if (typeof value === "number") return names[value] ?? fallback;
  if (typeof value === "string" && value) return value;
  return fallback;
}
var BOT_HINT = /\b(bot|service|build|pipeline|automation|copilot|sonar)\b/i;
function normalizeThread(raw) {
  const comments = (raw.comments ?? []).filter((c) => !c.isDeleted).map((c) => ({
    author: c.author?.displayName ?? "unknown",
    type: enumName(c.commentType, COMMENT_TYPES, "text"),
    body: (c.content ?? "").trim()
  }));
  const ctx = raw.threadContext;
  const isSystem = comments.length > 0 && comments.every((c) => c.type === "system");
  const isBot = isSystem || comments.length > 0 && comments.every((c) => BOT_HINT.test(c.author));
  return {
    id: raw.id,
    path: ctx?.filePath ? ctx.filePath.replace(/^\//, "") : void 0,
    line: ctx?.rightFileStart?.line ?? ctx?.leftFileStart?.line,
    status: enumName(raw.status, THREAD_STATUSES, "unknown"),
    isDeleted: raw.isDeleted === true,
    isBot,
    comments
  };
}

// src/ado/url.ts
function decode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
function parsePrUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return void 0;
  }
  const segments = url.pathname.split("/").filter(Boolean).map(decode);
  const host = url.hostname.toLowerCase();
  let org;
  let rest = segments;
  if (host === "dev.azure.com" || host.endsWith(".dev.azure.com")) {
    org = segments[0];
    rest = segments.slice(1);
  } else if (host.endsWith(".visualstudio.com")) {
    org = host.slice(0, -".visualstudio.com".length);
  } else {
    return void 0;
  }
  if (!org) return void 0;
  const gitIndex = rest.findIndex((s) => s === "_git");
  if (gitIndex < 1) return void 0;
  let projectSegments = rest.slice(0, gitIndex).filter((s) => s !== "_apis");
  if (projectSegments.length > 1 && projectSegments[0].toLowerCase() === "defaultcollection") {
    projectSegments = projectSegments.slice(1);
  }
  const project = projectSegments.join("/");
  const repo = rest[gitIndex + 1];
  if (!project || !repo) return void 0;
  let prId;
  const prIndex = rest.findIndex((s) => s.toLowerCase() === "pullrequest");
  if (prIndex >= 0) {
    const raw = rest[prIndex + 1];
    const parsed = Number.parseInt(raw ?? "", 10);
    if (Number.isFinite(parsed)) prId = parsed;
  }
  return { org, project, repo, prId };
}
function parseRemoteUrl(remote) {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const ssh = /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com[:/]v3\/(.+)$/.exec(trimmed);
  if (ssh) {
    const parts = ssh[1].split("/").map(decode).filter(Boolean);
    if (parts.length >= 3) {
      return { org: parts[0], project: parts.slice(1, -1).join("/"), repo: parts[parts.length - 1] };
    }
    return void 0;
  }
  const parsed = parsePrUrl(trimmed);
  if (parsed) return { org: parsed.org, project: parsed.project, repo: parsed.repo };
  return void 0;
}
function remoteUrlFor(target) {
  return `https://dev.azure.com/${encodeURIComponent(target.org)}/${encodeURIComponent(
    target.project
  )}/_git/${encodeURIComponent(target.repo)}`;
}
function webUrlFor(target, prId) {
  return `${remoteUrlFor(target)}/pullrequest/${prId}`;
}

// src/core/git.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
var WORKTREE = "WORKTREE";
function isWorktree(rev) {
  return rev === WORKTREE;
}
async function repoRoot(cwd) {
  return run("git", ["rev-parse", "--show-toplevel"], { cwd });
}
async function remoteUrl(cwd, name = "origin") {
  return run("git", ["remote", "get-url", name], { cwd, allowFailure: true });
}
async function revParse(cwd, ref) {
  const sha = await run("git", ["rev-parse", ref], { cwd, allowFailure: true });
  if (!sha) throw new Error(`Cannot resolve "${ref}" in ${cwd}.`);
  return sha;
}
async function currentBranch(cwd) {
  const name = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    allowFailure: true
  });
  return name === "HEAD" ? "" : name;
}
async function mergeBase(cwd, base, head) {
  const sha = await run("git", ["merge-base", base, head], { cwd, allowFailure: true });
  if (!sha) {
    throw new Error(
      `No common ancestor between "${base}" and "${head}". Fetch the base branch first, or pass a ref that exists locally.`
    );
  }
  return sha;
}
async function hasCommit(cwd, sha) {
  const type = await run("git", ["cat-file", "-t", sha], { cwd, allowFailure: true });
  return type === "commit";
}
async function fetchCommits(cwd, url, shas, authHeader) {
  const missing = [];
  for (const sha of shas) {
    if (!await hasCommit(cwd, sha)) missing.push(sha);
  }
  if (missing.length === 0) return;
  await run(
    "git",
    [
      "-c",
      `http.extraHeader=Authorization: ${authHeader}`,
      "fetch",
      "--depth=1",
      "--no-tags",
      "--quiet",
      url,
      ...missing
    ],
    { cwd }
  );
}
function splitZ(out) {
  return out.split("\0").filter((s) => s.length > 0);
}
var STATUS_MAP = {
  A: "add",
  M: "edit",
  D: "delete",
  R: "rename",
  C: "add",
  T: "edit"
};
async function listChanges(cwd, base, head) {
  const range = isWorktree(head) ? [base] : [base, head];
  const numstatOut = await run("git", ["diff", "-M", "--numstat", "-z", ...range], { cwd });
  const nameStatusOut = await run("git", ["diff", "-M", "--name-status", "-z", ...range], {
    cwd
  });
  const statusByPath = /* @__PURE__ */ new Map();
  const nsFields = splitZ(nameStatusOut);
  for (let i = 0; i < nsFields.length; ) {
    const code = nsFields[i++];
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = nsFields[i++];
      const newPath = nsFields[i++];
      statusByPath.set(newPath, { status: STATUS_MAP[letter] ?? "edit", oldPath });
    } else {
      const path = nsFields[i++];
      statusByPath.set(path, { status: STATUS_MAP[letter] ?? "edit" });
    }
  }
  const changes = [];
  const nsNumstat = splitZ(numstatOut);
  for (let i = 0; i < nsNumstat.length; ) {
    const head3 = nsNumstat[i++];
    const parts = head3.split("	");
    const adds = parts[0];
    const dels = parts[1];
    let path = parts[2] ?? "";
    let oldPath;
    if (path === "") {
      oldPath = nsNumstat[i++];
      path = nsNumstat[i++];
    }
    const meta = statusByPath.get(path);
    const binary = adds === "-" || dels === "-";
    changes.push({
      path,
      oldPath: oldPath ?? meta?.oldPath,
      status: meta?.status ?? "edit",
      adds: binary ? 0 : Number.parseInt(adds, 10) || 0,
      dels: binary ? 0 : Number.parseInt(dels, 10) || 0,
      binary
    });
  }
  if (isWorktree(head)) changes.push(...await listUntracked(cwd));
  return changes;
}
async function listUntracked(cwd) {
  const out = await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd,
    allowFailure: true
  });
  const paths = splitZ(out);
  const changes = [];
  for (const path of paths) {
    const numstat = await run(
      "git",
      ["diff", "--no-index", "--numstat", "--", "/dev/null", path],
      { cwd, allowFailure: true, okExitCodes: [1] }
    );
    const [adds, dels] = (numstat.split("\n")[0] ?? "").split("	");
    const binary = adds === "-" || dels === "-";
    changes.push({
      path,
      status: "add",
      adds: binary ? 0 : Number.parseInt(adds ?? "", 10) || 0,
      dels: 0,
      binary
    });
  }
  return changes;
}
async function fileDiff(cwd, base, head, path, context2 = 3) {
  if (isWorktree(head)) {
    const tracked = await run(
      "git",
      ["diff", "-M", `--unified=${context2}`, base, "--", path],
      { cwd, allowFailure: true }
    );
    if (tracked) return tracked;
    return run(
      "git",
      ["diff", "--no-index", `--unified=${context2}`, "--", "/dev/null", path],
      { cwd, allowFailure: true, okExitCodes: [1] }
    );
  }
  return run(
    "git",
    ["diff", "-M", `--unified=${context2}`, base, head, "--", path],
    { cwd, allowFailure: true }
  );
}
async function showFile(cwd, sha, path) {
  if (isWorktree(sha)) {
    try {
      return await readFile(join(cwd, path), "utf8");
    } catch {
      return "";
    }
  }
  return run("git", ["show", `${sha}:${path}`], { cwd, allowFailure: true });
}
function parseGrepOutput(sha, out) {
  if (!out) return [];
  const prefix = sha ? `${sha}:` : "";
  const matches = [];
  for (const raw of out.split("\n")) {
    if (!raw) continue;
    const line = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    const first = line.indexOf(":");
    if (first < 0) continue;
    const second = line.indexOf(":", first + 1);
    if (second < 0) continue;
    const lineNumber = Number.parseInt(line.slice(first + 1, second), 10);
    if (!Number.isFinite(lineNumber)) continue;
    matches.push({
      path: line.slice(0, first),
      line: lineNumber,
      text: line.slice(second + 1).trim()
    });
  }
  return matches;
}
async function grepAtRev(cwd, sha, pattern, opts) {
  const args = ["grep", "-I", "-n", opts.regex ? "-E" : "-F", "-e", pattern];
  if (!isWorktree(sha)) args.push(sha);
  if (opts.pathspec && opts.pathspec.length > 0) args.push("--", ...opts.pathspec);
  const out = await run("git", args, { cwd, allowFailure: true });
  const matches = parseGrepOutput(isWorktree(sha) ? "" : sha, out);
  return { matches: matches.slice(0, opts.max), truncated: matches.length > opts.max };
}
async function listTree(cwd, rev) {
  const out = await run("git", ["ls-tree", "-r", "--name-only", "-z", rev], {
    cwd,
    allowFailure: true
  });
  return splitZ(out);
}
async function commitMessages(cwd, base, head, max = 30) {
  const out = await run(
    "git",
    ["log", `--max-count=${max}`, "--format=%B%x00", `${base}..${head}`],
    { cwd, allowFailure: true }
  );
  return splitZ(out).map((message) => message.trim()).filter((message) => message.length > 0);
}

// src/core/rules.ts
import { readFile as readFile2 } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join as join2 } from "node:path";

// src/core/glob.ts
var SPECIAL = /[.+^$()|\\]/g;
function segmentToRegex(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    if (char === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close > i) {
        const body = glob.slice(i + 1, close).replace(/^!/, "^");
        out += `[${body}]`;
        i = close;
        continue;
      }
      out += "\\[";
      continue;
    }
    if (char === "{") {
      const close = glob.indexOf("}", i + 1);
      if (close > i) {
        const options = glob.slice(i + 1, close).split(",");
        out += `(?:${options.map(segmentToRegex).join("|")})`;
        i = close;
        continue;
      }
      out += "\\{";
      continue;
    }
    out += char.replace(SPECIAL, "\\$&");
  }
  return out;
}
function globToRegExp(glob) {
  let pattern = glob.trim();
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  if (pattern.endsWith("/")) pattern += "**";
  const anchored = pattern.includes("/") ? pattern : `**/${pattern}`;
  return new RegExp(`^${segmentToRegex(anchored)}$`);
}
var cache = /* @__PURE__ */ new Map();
function matchesGlob(path, glob) {
  let regex = cache.get(glob);
  if (!regex) {
    regex = globToRegExp(glob);
    cache.set(glob, regex);
  }
  return regex.test(path.replace(/^\//, ""));
}
function matchesAny(path, globs) {
  return globs.some((glob) => matchesGlob(path, glob));
}

// src/core/rules.ts
var SEVERITIES = ["critical", "high", "medium", "low"];
var PROJECT_RULE_PATH = ".pr-review/rules.json";
var BUILTIN_RULES = [
  {
    path: "**/migrations/**",
    rule: "Check reversibility, locking on large tables, and behaviour against rows written by the previous version."
  },
  {
    path: "**/*.{test,spec}.{ts,tsx,js,jsx}",
    rule: "Check that assertions were strengthened, not removed or loosened, and that new behaviour is covered."
  },
  {
    path: "**/{Dockerfile,*.tf,*.tfvars,*.yaml,*.yml}",
    rule: "Check for credentials, over-broad permissions, and image or module sources that are not pinned."
  }
];
function globalRulePath() {
  if (platform() === "win32" && process.env.APPDATA) {
    return join2(process.env.APPDATA, "pr-review", "rules.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return join2(xdg || join2(homedir(), ".config"), "pr-review", "rules.json");
}
function parseRuleFile(text, source) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${source} must contain a JSON object.`);
  }
  const file = raw;
  const out = {};
  if (file.rules !== void 0) {
    if (!Array.isArray(file.rules)) throw new Error(`${source}: "rules" must be an array.`);
    out.rules = file.rules.map((entry, i) => {
      const e = entry;
      const where = `${source}: rules[${i}]`;
      if (typeof e?.path !== "string" || !e.path) throw new Error(`${where}.path must be a non-empty string.`);
      if (e.rule !== void 0 && typeof e.rule !== "string") throw new Error(`${where}.rule must be a string.`);
      if (e.minSeverity !== void 0 && !SEVERITIES.includes(e.minSeverity)) {
        throw new Error(`${where}.minSeverity must be one of ${SEVERITIES.join(", ")}.`);
      }
      if (e.rule === void 0 && e.minSeverity === void 0) {
        throw new Error(`${where} needs "rule", "minSeverity", or both.`);
      }
      return {
        path: e.path,
        ...typeof e.rule === "string" ? { rule: e.rule } : {},
        ...e.mergeBuiltin === true ? { mergeBuiltin: true } : {},
        ...e.minSeverity !== void 0 ? { minSeverity: e.minSeverity } : {}
      };
    });
  }
  for (const key of ["exclude", "alwaysHuman"]) {
    const value = file[key];
    if (value === void 0) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(`${source}: "${key}" must be an array of glob strings.`);
    }
    out[key] = value;
  }
  if (file.riskPaths !== void 0) {
    if (!Array.isArray(file.riskPaths)) throw new Error(`${source}: "riskPaths" must be an array.`);
    out.riskPaths = file.riskPaths.map((entry, i) => {
      const e = entry;
      const where = `${source}: riskPaths[${i}]`;
      if (typeof e?.path !== "string" || !e.path) throw new Error(`${where}.path must be a non-empty string.`);
      if (typeof e.weight !== "number" || !Number.isFinite(e.weight) || e.weight < 1 || e.weight > 10) {
        throw new Error(`${where}.weight must be a number from 1 to 10.`);
      }
      if (e.label !== void 0 && (typeof e.label !== "string" || !e.label)) {
        throw new Error(`${where}.label must be a non-empty string.`);
      }
      return { path: e.path, weight: e.weight, ...typeof e.label === "string" ? { label: e.label } : {} };
    });
  }
  if (file.maxLowFindings !== void 0) {
    const n = file.maxLowFindings;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      throw new Error(`${source}: "maxLowFindings" must be a non-negative integer.`);
    }
    out.maxLowFindings = n;
  }
  return out;
}
async function loadRuleFile(path) {
  if (!existsSync(path)) return void 0;
  return parseRuleFile(await readFile2(path, "utf8"), path);
}
async function loadRules(repoRoot2, explicitPath, opts = {}) {
  const layers = [];
  if (explicitPath) {
    const file = await loadRuleFile(explicitPath);
    if (!file) throw new Error(`Rule file not found: ${explicitPath}`);
    layers.push({ path: explicitPath, file });
  }
  if (opts.rev) {
    const text = await showFile(repoRoot2, opts.rev, PROJECT_RULE_PATH);
    const label = `${PROJECT_RULE_PATH}@${opts.rev.slice(0, 10)}`;
    layers.push({ path: label, file: text ? parseRuleFile(text, label) : void 0 });
  } else {
    const projectPath = join2(repoRoot2, PROJECT_RULE_PATH);
    layers.push({ path: projectPath, file: await loadRuleFile(projectPath) });
  }
  const userPath = globalRulePath();
  layers.push({ path: userPath, file: await loadRuleFile(userPath) });
  const entries = [];
  const exclude = [];
  const alwaysHuman = [];
  const riskPaths = [];
  const sources = [];
  let maxLowFindings;
  for (const layer of layers) {
    if (!layer.file) continue;
    sources.push(layer.path);
    entries.push(...layer.file.rules ?? []);
    exclude.push(...layer.file.exclude ?? []);
    alwaysHuman.push(...layer.file.alwaysHuman ?? []);
    riskPaths.push(...layer.file.riskPaths ?? []);
    if (maxLowFindings === void 0 && layer.file.maxLowFindings !== void 0) {
      maxLowFindings = layer.file.maxLowFindings;
    }
  }
  return {
    entries,
    exclude,
    sources,
    alwaysHuman,
    riskPaths,
    ...maxLowFindings !== void 0 ? { maxLowFindings } : {}
  };
}
function rulesForPath(path, resolved) {
  const userRule = resolved.entries.find((entry) => matchesGlob(path, entry.path));
  const builtin = BUILTIN_RULES.find((entry) => matchesGlob(path, entry.path));
  if (!userRule) return builtin?.rule ? [builtin.rule] : [];
  const own = userRule.rule ? [userRule.rule] : [];
  if ((userRule.mergeBuiltin || !userRule.rule) && builtin?.rule) return [...own, builtin.rule];
  return own;
}
function minSeverityForPath(path, resolved) {
  return resolved.entries.find((entry) => matchesGlob(path, entry.path))?.minSeverity;
}
function isExcludedByRules(path, resolved) {
  return matchesAny(path, resolved.exclude);
}
function riskPathsFor(path, resolved) {
  const byKey = /* @__PURE__ */ new Map();
  for (const entry of resolved.riskPaths) {
    if (!matchesGlob(path, entry.path)) continue;
    const key = entry.label ?? entry.path;
    const known = byKey.get(key);
    if (!known || entry.weight > known.weight) byKey.set(key, entry);
  }
  return [...byKey.values()];
}

// src/core/triage.ts
function estimateDiffTokens(change) {
  if (change.binary) return 0;
  const lines = change.adds + change.dels;
  return Math.ceil(lines * 55 * 1.6 / 4) + 40;
}
var SECRET_PATTERNS = [
  /(^|\/)\.ssh\//,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)\.(netrc|npmrc|pypirc|dockercfg|pgpass)$/,
  /(^|\/)_netrc$/,
  /\.(pem|pfx|p12|keystore|jks)$/i
];
var LOCK_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)packages\.lock\.json$/,
  /\.lock$/
];
var GENERATED_PATTERNS = [
  /(^|\/)(dist|build|out|coverage|node_modules|vendor|__snapshots__)\//,
  /\.(generated|gen)\.[^/]+$/,
  /(^|\/)[^/]*\.pb\.[^/]+$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.snap$/,
  /(^|\/)[^/]*\.designer\.cs$/i,
  /\.g\.[^/]+$/i,
  /(^|\/)migrations?\/.*\.(designer\.cs|resx)$/i
];
var TEST_PATTERNS = [
  /(^|\/)(__tests__|__test__|tests?|spec)\//i,
  /\.(test|spec)\.[jt]sx?$/,
  /(^|\/)[^/]*_test\.(go|py|rs|zig)$/,
  /(^|\/)[^/]*Tests?\.(cs|java|kt|swift)$/,
  /(^|\/)[^/]*\.Tests?\//i,
  /(^|\/)testdata\//,
  /(^|\/)fixtures?\//
];
var DOC_EXTENSIONS = /* @__PURE__ */ new Set(["md", "mdx", "txt", "rst", "adoc"]);
var CONFIG_EXTENSIONS = /* @__PURE__ */ new Set([
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "xml",
  "csproj",
  "props",
  "targets",
  "tf",
  "tfvars"
]);
var RISK_SIGNALS = [
  { pattern: /auth|login|token|secret|credential|password|crypt|cert|permission|role|acl/i, weight: 5, label: "security" },
  { pattern: /migration|schema|entity|dto|contract|\bapi\b|controller|endpoint|proto/i, weight: 4, label: "contract" },
  { pattern: /concurren|thread|lock|queue|worker|scheduler|retry|timeout/i, weight: 3, label: "concurrency" },
  { pattern: /cache|session|state|store|repository|persist/i, weight: 2, label: "state" }
];
function riskSignals(path) {
  return RISK_SIGNALS.filter((signal) => signal.pattern.test(path)).map((signal) => signal.label);
}
function extensionOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}
function classify(change) {
  const path = change.path;
  if (SECRET_PATTERNS.some((p) => p.test(path))) return "secret";
  if (change.binary) return "binary";
  if (LOCK_PATTERNS.some((p) => p.test(path))) return "lock";
  if (GENERATED_PATTERNS.some((p) => p.test(path))) return "generated";
  if (TEST_PATTERNS.some((p) => p.test(path))) return "test";
  const ext = extensionOf(path);
  if (DOC_EXTENSIONS.has(ext)) return "docs";
  if (CONFIG_EXTENSIONS.has(ext)) return "config";
  if (ext) return "source";
  return "unknown";
}
var BASE_RISK = {
  source: 6,
  config: 4,
  test: 2,
  docs: 1,
  generated: 0,
  lock: 0,
  binary: 0,
  secret: 0,
  unknown: 3
};
function riskScore(change, category, rules) {
  let score = BASE_RISK[category];
  for (const signal of RISK_SIGNALS) {
    if (signal.pattern.test(change.path)) score += signal.weight;
  }
  if (rules) {
    for (const entry of riskPathsFor(change.path, rules)) score += entry.weight;
  }
  const churn = change.adds + change.dels;
  score += Math.min(6, Math.log2(churn + 1));
  if (change.status === "delete") score += 1;
  if (category === "test" || category === "docs") score = Math.min(score, 6);
  return Math.round(score * 10) / 10;
}
var DEFAULT_TRIAGE = { maxFileTokens: 6e4 };
function triage(changes, trackingIds, opts = DEFAULT_TRIAGE) {
  return changes.map((change) => {
    const category = classify(change);
    const tokens = estimateDiffTokens(change);
    let decision = "review";
    let reason = "in-scope";
    if (category === "secret") {
      decision = "skip";
      reason = "secret-path";
    } else if (category === "binary") {
      decision = "skip";
      reason = "binary";
    } else if (opts.rules && isExcludedByRules(change.path, opts.rules)) {
      decision = "skip";
      reason = "excluded-by-rule";
    } else if (change.status === "delete") {
      decision = "stat-only";
      reason = "deleted";
    } else if (category === "lock") {
      decision = "stat-only";
      reason = "lock-file";
    } else if (category === "generated") {
      decision = "stat-only";
      reason = "generated";
    } else if (tokens > opts.maxFileTokens) {
      decision = "stat-only";
      reason = "diff-too-large";
    }
    const rules = decision === "review" && opts.rules ? rulesForPath(change.path, opts.rules) : [];
    const minSeverity = decision === "review" && opts.rules ? minSeverityForPath(change.path, opts.rules) : void 0;
    const signals = [
      ...riskSignals(change.path),
      ...opts.rules ? riskPathsFor(change.path, opts.rules).map((entry) => entry.label ?? "project") : []
    ].filter((label, index, all) => all.indexOf(label) === index);
    return {
      path: change.path,
      oldPath: change.oldPath,
      status: change.status,
      adds: change.adds,
      dels: change.dels,
      binary: change.binary,
      category,
      decision,
      reason,
      risk: riskScore(change, category, opts.rules),
      tokens,
      changeTrackingId: trackingIds.get(change.path),
      ...rules.length > 0 ? { rules } : {},
      ...minSeverity ? { minSeverity } : {},
      ...signals.length > 0 ? { signals } : {}
    };
  });
}

// src/core/batch.ts
var DEFAULT_BATCH = {
  maxFiles: 10,
  maxTokens: 25e3,
  planFileLines: 50,
  planGroupLines: 100
};
function batchOptionsFor(depth) {
  switch (depth) {
    case "quick":
      return { maxFiles: 15, maxTokens: 4e4, planFileLines: 200, planGroupLines: 400 };
    case "deep":
      return { maxFiles: 6, maxTokens: 15e3, planFileLines: 1, planGroupLines: 1 };
    default:
      return { ...DEFAULT_BATCH };
  }
}
var MIN_AFFINITY = 4;
function dirOf(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
function stemOf(path) {
  let base = path.slice(path.lastIndexOf("/") + 1);
  base = base.replace(/\.(test|spec)\b/i, "");
  const dot = base.indexOf(".");
  if (dot > 0) base = base.slice(0, dot);
  return base.replace(/(Tests?|Spec)$/i, "").toLowerCase();
}
function commonDir(paths) {
  if (paths.length === 0) return "";
  const split = paths.map((p) => dirOf(p).split("/"));
  const first = split[0];
  let i = 0;
  for (; i < first.length; i++) {
    if (!split.every((parts) => parts[i] === first[i])) break;
  }
  return first.slice(0, i).join("/");
}
function affinity(a, b, rel) {
  let score = 0;
  if (stemOf(a.path) === stemOf(b.path)) score += 6;
  const da = dirOf(rel(a.path));
  const db = dirOf(rel(b.path));
  if (da === db) score += 4;
  else if (da.startsWith(`${db}/`) || db.startsWith(`${da}/`)) score += 2;
  else {
    const shared = commonDir([rel(a.path), rel(b.path)]).split("/").filter(Boolean).length;
    score += Math.min(2, shared);
  }
  if (a.category === b.category) score += 1;
  return score;
}
function buildBatches(files, opts = DEFAULT_BATCH) {
  const pool = files.filter((f) => f.decision === "review").slice().sort((a, b) => b.risk - a.risk || a.path.localeCompare(b.path));
  const remaining = new Set(pool.map((f) => f.path));
  const byPath = new Map(pool.map((f) => [f.path, f]));
  const batches = [];
  const globalPrefix = commonDir(pool.map((f) => f.path));
  const rel = (path) => globalPrefix && path.startsWith(`${globalPrefix}/`) ? path.slice(globalPrefix.length + 1) : path;
  while (remaining.size > 0) {
    const seed = pool.find((f) => remaining.has(f.path));
    if (!seed) break;
    remaining.delete(seed.path);
    const members = [seed];
    let tokens = seed.tokens;
    while (members.length < opts.maxFiles) {
      let best;
      for (const path of remaining) {
        const candidate = byPath.get(path);
        if (tokens + candidate.tokens > opts.maxTokens) continue;
        const related = Math.max(...members.map((m) => affinity(m, candidate, rel)));
        if (related < MIN_AFFINITY) continue;
        const score = related + candidate.risk / 100;
        if (!best || score > best.score) best = { file: candidate, score };
      }
      if (!best) break;
      members.push(best.file);
      tokens += best.file.tokens;
      remaining.delete(best.file.path);
    }
    const maxFileLines = Math.max(...members.map((m) => m.adds + m.dels));
    const totalLines = members.reduce((sum, m) => sum + m.adds + m.dels, 0);
    batches.push({
      id: 0,
      label: commonDir(members.map((m) => m.path)) || members[0].path,
      files: members.map((m) => m.path),
      estTokens: tokens,
      risk: Math.max(...members.map((m) => m.risk)),
      needsPlan: maxFileLines >= opts.planFileLines || members.length >= 2 && totalLines >= opts.planGroupLines,
      payload: ""
    });
  }
  batches.sort((a, b) => b.risk - a.risk || a.label.localeCompare(b.label));
  const merged = mergeSiblings(batches, opts, rel);
  merged.forEach((batch, index) => {
    batch.id = index + 1;
    batch.payload = `payload/b${String(batch.id).padStart(2, "0")}.md`;
    if (globalPrefix && batch.label.startsWith(globalPrefix)) {
      batch.label = batch.label.slice(globalPrefix.length).replace(/^\//, "") || "(root)";
    }
    if (batch.files.length === 1) {
      const only = batch.files[0];
      batch.label = `${batch.label}/${only.slice(only.lastIndexOf("/") + 1)}`.replace(/^\//, "");
    }
  });
  return merged;
}
function mergeSiblings(batches, opts, rel) {
  const result = batches.slice();
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i];
        const b = result[j];
        if (a.files.length + b.files.length > opts.maxFiles) continue;
        if (a.estTokens + b.estTokens > opts.maxTokens) continue;
        const da = dirOf(rel(a.files[0]));
        const db = dirOf(rel(b.files[0]));
        const nested = da === db || da.startsWith(`${db}/`) || db.startsWith(`${da}/`);
        if (!nested) continue;
        const files = [...a.files, ...b.files];
        result[i] = {
          ...a,
          label: commonDir(files) || a.label,
          files,
          estTokens: a.estTokens + b.estTokens,
          risk: Math.max(a.risk, b.risk),
          needsPlan: a.needsPlan || b.needsPlan
        };
        result.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return result;
}

// src/core/guidance.ts
var SCOPED_NAMES = ["AGENTS.md", "CLAUDE.md", "REVIEW.md"];
var COPILOT_FILE = /^(?:(.*)\/)?\.github\/copilot-instructions\.md$/;
var INSTRUCTIONS_FILE = /^(?:(.*)\/)?\.github\/instructions\/[^/]+\.instructions\.md$/;
function instructionFiles(tree) {
  return tree.filter((path) => INSTRUCTIONS_FILE.test(path));
}
function parseApplyTo(content) {
  const front = /^---\r?\n([^]*?)\r?\n---/.exec(content);
  if (!front) return void 0;
  const line = /^applyTo:\s*(.+)$/m.exec(front[1]);
  if (!line) return void 0;
  const value = line[1].trim().replace(/^["']|["']$/g, "");
  const globs = [];
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
  return cleaned.length > 0 ? cleaned : void 0;
}
function relativeTo(scope, path) {
  return scope ? path.slice(scope.length + 1) : path;
}
function underScope(scope, path) {
  return scope === "" || path.startsWith(`${scope}/`);
}
function dirOf2(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
function baseName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}
function ancestors(path) {
  const dirs = [""];
  const parts = dirOf2(path).split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
  return dirs;
}
function selectGuidance(tree, changedPaths, instructionContents = /* @__PURE__ */ new Map()) {
  const present = new Set(tree);
  const selected = /* @__PURE__ */ new Map();
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
      const ref = { path, kind: "project", scope, applyTo };
      if (changedPaths.some((changed) => appliesTo(ref, changed))) selected.set(path, ref);
    }
  }
  const dirs = /* @__PURE__ */ new Set();
  for (const path of changedPaths) for (const dir of ancestors(path)) dirs.add(dir);
  for (const dir of dirs) {
    for (const name of SCOPED_NAMES) {
      const candidate = dir ? `${dir}/${name}` : name;
      if (!present.has(candidate)) continue;
      selected.set(candidate, {
        path: candidate,
        kind: name === "REVIEW.md" ? "review" : "project",
        scope: dir
      });
    }
  }
  return [...selected.values()].sort(
    (a, b) => a.scope.split("/").length - b.scope.split("/").length || a.path.localeCompare(b.path)
  );
}
function appliesTo(ref, path) {
  if (!underScope(ref.scope, path)) return false;
  return ref.applyTo ? matchesAny(relativeTo(ref.scope, path), ref.applyTo) : true;
}
function guidanceForPath(path, refs) {
  return refs.filter((ref) => appliesTo(ref, path));
}
function isReviewConfiguration(path) {
  if (path === ".pr-review/rules.json") return true;
  if (COPILOT_FILE.test(path) || INSTRUCTIONS_FILE.test(path)) return true;
  return SCOPED_NAMES.includes(baseName(path));
}
var GUIDANCE_FILE_CAP = 12e3;
function renderGuidance(refs, contents) {
  const parts = [
    "# Repository guidance",
    "",
    "Read from the base revision. A violation of a stated rule is a finding at whatever severity",
    "the consequence warrants; guidance about style or tone is not a reason to report anything.",
    ""
  ];
  for (const ref of refs) {
    const text = (contents.get(ref.path) ?? "").trim();
    if (!text) continue;
    const capped = text.length > GUIDANCE_FILE_CAP ? `${text.slice(0, GUIDANCE_FILE_CAP)}

[truncated at ${GUIDANCE_FILE_CAP} characters]` : text;
    const governs = ref.scope ? `${ref.scope}/` : "the whole repository";
    parts.push(
      `## ${ref.path} (${ref.kind}, governs ${governs}${ref.applyTo ? `, applyTo ${ref.applyTo.join(", ")}` : ""})`
    );
    parts.push("");
    parts.push(capped);
    parts.push("");
  }
  return parts.join("\n");
}

// src/core/locate.ts
function normalize(line) {
  return line.replace(/\s+/g, " ").trim();
}
function locate(content, evidence) {
  const needle = evidence.split("\n").map(normalize).filter((l) => l.length > 0);
  if (needle.length === 0) return void 0;
  const lines = content.split("\n");
  const normalized = lines.map(normalize);
  const matches = [];
  for (let i = 0; i + needle.length <= normalized.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (normalized[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push({ startLine: i + 1, endLine: i + needle.length });
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    return "ambiguous";
  }
  if (needle.length === 1) {
    const hits = [];
    for (let i = 0; i < normalized.length; i++) {
      if (normalized[i].includes(needle[0])) hits.push({ startLine: i + 1, endLine: i + 1 });
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return "ambiguous";
  }
  return void 0;
}
async function resolveEvidence(repoRoot2, sourceSHA, declaredPath, evidence, otherPaths) {
  const own = await showFile(repoRoot2, sourceSHA, declaredPath);
  const hit = own ? locate(own, evidence) : void 0;
  if (hit && hit !== "ambiguous") return { location: hit, outcome: "resolved" };
  if (hit === "ambiguous") return { outcome: "ambiguous" };
  const relocations = [];
  const ambiguousIn = [];
  for (const path of otherPaths) {
    if (path === declaredPath) continue;
    const content = await showFile(repoRoot2, sourceSHA, path);
    if (!content) continue;
    const found = locate(content, evidence);
    if (found === "ambiguous") ambiguousIn.push(path);
    else if (found) relocations.push({ path, location: found });
  }
  if (relocations.length === 1 && ambiguousIn.length === 0) {
    return {
      location: relocations[0].location,
      relocatedTo: relocations[0].path,
      outcome: "relocated"
    };
  }
  if (relocations.length + ambiguousIn.length > 1) {
    return {
      outcome: "ambiguous-elsewhere",
      candidates: [...relocations.map((r) => r.path), ...ambiguousIn]
    };
  }
  return { outcome: "not-found" };
}

// src/core/priorFindings.ts
var MARKER = /prr finding `([0-9a-f]{6,40})`/;
var SEVERITY_WORDS = [
  [/\*\*Critical\*\*/, "critical"],
  [/\*\*High\*\*/, "high"],
  [/\*\*Medium\*\*/, "medium"],
  [/\*\*Low\*\*/, "low"]
];
function findingMarker(finding) {
  return `_prr finding \`${finding.id}\`_`;
}
function fenceFor(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}
function readEvidenceBlock(body) {
  const lines = body.split("\n");
  const heading = lines.findIndex((line) => line.trim() === "**Evidence**");
  if (heading < 0) return void 0;
  const open = lines[heading + 1]?.trim() ?? "";
  if (!/^`{3,}$/.test(open)) return void 0;
  const close = lines.findIndex((line, i) => i > heading + 1 && line.trim() === open);
  if (close < 0) return void 0;
  return lines.slice(heading + 2, close).join("\n");
}
function parseFindingMarker(body) {
  const match = MARKER.exec(body);
  if (!match) return void 0;
  const firstLine = body.split("\n")[0] ?? "";
  const severity = SEVERITY_WORDS.find(([pattern]) => pattern.test(firstLine))?.[1];
  const evidence = readEvidenceBlock(body);
  return {
    id: match[1],
    ...severity ? { severity } : {},
    ...evidence !== void 0 ? { evidence } : {}
  };
}
function stripMarkers(body) {
  return body.replace(/<!--[^]*?-->/g, "").replace(/_?prr finding `[0-9a-f]+`_?/g, "").trim();
}
async function collectPriorFindings(threads, readFile6) {
  const out = [];
  const cache2 = /* @__PURE__ */ new Map();
  for (const thread of threads) {
    if (thread.isDeleted || thread.comments.length === 0) continue;
    const marker = parseFindingMarker(thread.comments[0].body);
    if (!marker) continue;
    let evidenceStillPresent = null;
    if (thread.path && marker.evidence) {
      if (!cache2.has(thread.path)) cache2.set(thread.path, await readFile6(thread.path));
      const content = cache2.get(thread.path);
      evidenceStillPresent = content ? locate(content, marker.evidence) !== void 0 : false;
    }
    out.push({
      threadId: thread.id,
      findingId: marker.id,
      ...thread.path ? { path: thread.path } : {},
      ...thread.line !== void 0 ? { line: thread.line } : {},
      status: thread.status,
      ...marker.severity ? { severity: marker.severity } : {},
      ...marker.evidence ? { evidence: marker.evidence } : {},
      evidenceStillPresent,
      replies: thread.comments.slice(1).filter((comment) => comment.type !== "system").map((comment) => ({ author: comment.author, body: stripMarkers(comment.body) }))
    });
  }
  return out;
}
function isOpenThreadStatus(status2) {
  return status2 === "active" || status2 === "pending" || status2 === "unknown";
}

// src/core/payload.ts
var INLINE_REVIEW_GUIDANCE_CAP = 3e3;
function annotateDiff(diff) {
  const out = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = match ? Number.parseInt(match[1], 10) : 0;
      inHunk = true;
      out.push(`      ${line}`);
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("+")) {
      out.push(`${String(newLine).padStart(5, " ")}+${line.slice(1)}`);
      newLine++;
    } else if (line.startsWith("-")) {
      out.push(`    -|${line.slice(1)}`);
    } else if (line.startsWith("\\")) {
      out.push(`     |${line}`);
    } else {
      out.push(`${String(newLine).padStart(5, " ")} ${line.slice(1)}`);
      newLine++;
    }
  }
  return out.join("\n");
}
function excerpt(body, limit) {
  const flat = stripMarkers(body).replace(/\s+/g, " ");
  return flat.length > limit ? `${flat.slice(0, limit)}\u2026` : flat;
}
function threadSummary(threads, path, prior) {
  const relevant = threads.filter((t) => t.path === path && !t.isDeleted && t.comments.length > 0);
  if (relevant.length === 0) return "";
  const priorById = new Map(prior.map((p) => [p.threadId, p]));
  const lines = [];
  for (const t of relevant) {
    const first = t.comments[0];
    const who = t.isBot ? `${first.author} (bot)` : first.author;
    const mine = priorById.get(t.id);
    const tag = mine ? ` [prr finding ${mine.findingId}; evidence ${mine.evidenceStillPresent === null ? "unknown" : mine.evidenceStillPresent ? "still present" : "no longer present"}]` : "";
    lines.push(`- thread ${t.id} [${t.status}]${tag} line ${t.line ?? "?"} \u2014 ${who}: ${excerpt(first.body, 220)}`);
    const replies = t.comments.slice(1).filter((c) => c.type !== "system");
    const shown = replies.slice(-3);
    if (replies.length > shown.length) lines.push(`    \u21B3 (${replies.length - shown.length} earlier repl(ies) omitted)`);
    for (const reply of shown) lines.push(`    \u21B3 ${reply.author}: ${excerpt(reply.body, 160)}`);
  }
  return `
Existing threads on this file (do not repeat these findings; read the replies):
${lines.join("\n")}
`;
}
function guidanceSection(batch, ctx) {
  if (!ctx.guidance || ctx.guidance.refs.length === 0) return [];
  const applicable = /* @__PURE__ */ new Map();
  for (const path of batch.files) {
    for (const ref of guidanceForPath(path, ctx.guidance.refs)) applicable.set(ref.path, ref);
  }
  if (applicable.size === 0) return [];
  const out = ["## Repository guidance for these files", ""];
  const project = [...applicable.values()].filter((ref) => ref.kind === "project");
  if (project.length > 0) {
    out.push(
      `Project guidance (base revision, full text in guidance.md): ${project.map((r) => r.path).join(", ")}. A change that violates a rule stated there is a finding.`,
      ""
    );
  }
  for (const ref of [...applicable.values()].filter((r) => r.kind === "review")) {
    const text = (ctx.guidance.contents.get(ref.path) ?? "").trim();
    if (!text) continue;
    out.push(`Review instructions from ${ref.path}:`, "");
    out.push(
      text.length > INLINE_REVIEW_GUIDANCE_CAP ? `${text.slice(0, INLINE_REVIEW_GUIDANCE_CAP)}
\u2026[truncated; full text in guidance.md]` : text
    );
    out.push("");
  }
  return out;
}
async function renderPayload(batch, ctx) {
  const parts = [];
  parts.push(`# Review batch ${batch.id} \u2014 ${batch.label}`);
  parts.push("");
  parts.push(
    `Files: ${batch.files.length} \xB7 estimated tokens: ${batch.estTokens} \xB7 risk: ${batch.risk} \xB7 plan first: ${batch.needsPlan ? "yes" : "no"}`
  );
  parts.push(`Source revision: ${ctx.sourceSHA}`);
  parts.push(`Base revision: ${ctx.baseSHA}`);
  if (ctx.depth) parts.push(`Review depth: ${ctx.depth}`);
  parts.push("");
  parts.push(
    "Line numbers on the left are real line numbers in the source revision. Report them as-is; lines marked `-|` were removed and cannot be commented on."
  );
  parts.push("");
  if (ctx.intent) {
    parts.push("## Stated intent", "");
    parts.push(
      "Check each change against this: does it do what was asked, completely, without doing something else?",
      ""
    );
    parts.push(ctx.intent, "");
  }
  parts.push(...guidanceSection(batch, ctx));
  for (const path of batch.files) {
    const meta = ctx.files.get(path);
    const raw = await fileDiff(ctx.repoRoot, ctx.baseSHA, ctx.sourceSHA, path);
    parts.push(
      `<file path="${path}" status="${meta?.status ?? "edit"}" category="${meta?.category ?? "unknown"}" adds="${meta?.adds ?? 0}" dels="${meta?.dels ?? 0}" risk="${meta?.risk ?? 0}">`
    );
    if (meta?.rules && meta.rules.length > 0) {
      parts.push("");
      parts.push("Project rules for this path:");
      parts.push(...meta.rules.map((rule) => `- ${rule}`));
    }
    if (meta?.minSeverity) {
      parts.push("");
      parts.push(
        `Reporting threshold for this path: ${meta.minSeverity} and above. Lower findings are suppressed at finalize; record them only if they might be more severe than they look.`
      );
    }
    const threadNote = threadSummary(ctx.threads, path, ctx.priorFindings ?? []);
    if (threadNote) parts.push(threadNote.trimEnd());
    parts.push("```diff");
    parts.push(annotateDiff(raw));
    parts.push("```");
    parts.push("</file>");
    parts.push("");
  }
  return parts.join("\n");
}

// src/core/generated.ts
import { createHash } from "node:crypto";
function normalizeGeneratedContent(content) {
  return content.replace(/^#if NET\d+_\d+\s*$/gm, "#if NET_TARGET").replace(/\r\n/g, "\n").trim();
}
function contentHash(content) {
  return createHash("sha256").update(normalizeGeneratedContent(content)).digest("hex");
}
function collapseGeneratedDuplicates(files, contents) {
  const groups = /* @__PURE__ */ new Map();
  for (const file of files) {
    if (file.category !== "generated" || file.status === "delete") continue;
    const content = contents.get(file.path);
    if (!content) continue;
    const hash = contentHash(content);
    const group = groups.get(hash) ?? [];
    group.push(file.path);
    groups.set(hash, group);
  }
  const representativeByPath = /* @__PURE__ */ new Map();
  for (const paths of groups.values()) {
    if (paths.length < 2) continue;
    paths.sort((a, b) => a.localeCompare(b));
    const representative = paths[0];
    for (const path of paths) representativeByPath.set(path, representative);
  }
  return files.map((file) => {
    const representative = representativeByPath.get(file.path);
    if (!representative) return file;
    if (file.path === representative) {
      return {
        ...file,
        decision: "review",
        reason: "generated-representative",
        // Generated contracts are reviewed after handwritten source, but no
        // longer disappear entirely from semantic coverage.
        risk: Math.max(1, file.risk)
      };
    }
    return {
      ...file,
      decision: "stat-only",
      reason: `duplicate-of:${representative}`
    };
  });
}

// src/core/store.ts
import { mkdir, readFile as readFile3, writeFile, appendFile, readdir } from "node:fs/promises";
import { existsSync as existsSync2 } from "node:fs";
import { homedir as homedir2, platform as platform2 } from "node:os";
import { join as join3 } from "node:path";
function cacheRoot() {
  const override = process.env.PR_REVIEW_HOME;
  if (override) return override;
  if (platform2() === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) return join3(local, "pr-review");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return join3(xdg || join3(homedir2(), ".cache"), "pr-review");
}
function runDirFor(meta) {
  const revision = meta.sourceSHA === "WORKTREE" ? meta.targetSHA : meta.sourceSHA;
  const subject = meta.scope === "ado-pr" ? `${meta.org}-${meta.repo}-pr${meta.prId}` : `${meta.repo}-${meta.scope}`;
  const slug = `${subject}-${revision.slice(0, 12)}`.replace(/[^\w.-]/g, "_");
  return join3(cacheRoot(), slug);
}
async function findLatestRun(cwd) {
  const root = cacheRoot();
  if (!existsSync2(root)) throw new Error("No prepared run found. Run `prr prepare <pr>` first.");
  const here = (await run("git", ["rev-parse", "--show-toplevel"], {
    cwd: cwd ?? process.cwd(),
    allowFailure: true
  })).trim();
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = join3(root, entry.name, "run.json");
    if (!existsSync2(metaPath)) continue;
    const meta = JSON.parse(await readFile3(metaPath, "utf8"));
    candidates.push({
      dir: join3(root, entry.name),
      at: Date.parse(meta.createdAt) || 0,
      repoRoot: meta.repoRoot ?? ""
    });
  }
  if (candidates.length === 0) {
    throw new Error("No prepared run found. Run `prr prepare <pr>` first.");
  }
  if (!here) {
    throw new Error(
      "Cannot infer a review run outside a git repository. Pass --dir <run-directory> explicitly."
    );
  }
  const local = candidates.filter((c) => c.repoRoot === here);
  if (local.length === 0) {
    throw new Error(
      `No prepared run matches the current repository (${here}). Run \`prr prepare\` here, or pass --dir <run-directory> explicitly.`
    );
  }
  local.sort((a, b) => b.at - a.at);
  return local[0].dir;
}
async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}
`, "utf8");
}
async function readJson(path, fallback) {
  if (!existsSync2(path)) return fallback;
  return JSON.parse(await readFile3(path, "utf8"));
}
async function readJsonl(path) {
  if (!existsSync2(path)) return [];
  const text = await readFile3(path, "utf8");
  return text.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}
var RunStore = class _RunStore {
  dir;
  constructor(dir) {
    this.dir = dir;
  }
  static async create(meta) {
    await mkdir(join3(meta.runDir, "payload"), { recursive: true });
    const store = new _RunStore(meta.runDir);
    await writeJson(store.path("run.json"), meta);
    return store;
  }
  static async open(dir) {
    const resolved = dir ?? await findLatestRun();
    if (!existsSync2(join3(resolved, "run.json"))) {
      throw new Error(`Not a prepared run directory: ${resolved}`);
    }
    return new _RunStore(resolved);
  }
  path(...parts) {
    return join3(this.dir, ...parts);
  }
  meta() {
    return readJson(this.path("run.json"), void 0);
  }
  writePullRequest(value) {
    return writeJson(this.path("pr.json"), value);
  }
  writeThreads(threads) {
    return writeJson(this.path("threads.json"), threads);
  }
  writePolicies(value) {
    return writeJson(this.path("policies.json"), value);
  }
  writeBuilds(value) {
    return writeJson(this.path("builds.json"), value);
  }
  /** Writes a markdown document such as intent.md or guidance.md. */
  writeText(relative, content) {
    return writeFile(this.path(relative), content, "utf8");
  }
  writePriorFindings(value) {
    return writeJson(this.path("prior-findings.json"), value);
  }
  readPriorFindings() {
    return readJson(this.path("prior-findings.json"), []);
  }
  writeResult(value) {
    return writeJson(this.path("result.json"), value);
  }
  readResult() {
    return readJson(this.path("result.json"), void 0);
  }
  readThreads() {
    return readJson(this.path("threads.json"), []);
  }
  writeFiles(files) {
    return writeJson(this.path("files.json"), files);
  }
  readFiles() {
    return readJson(this.path("files.json"), []);
  }
  writeBatches(batches) {
    return writeJson(this.path("batches.json"), batches);
  }
  readBatches() {
    return readJson(this.path("batches.json"), []);
  }
  writePayload(relative, content) {
    return writeFile(this.path(relative), content, "utf8");
  }
  readVerdicts() {
    return readJsonl(this.path("verdicts.jsonl"));
  }
  async appendValidation(record) {
    await appendFile(this.path("validations.jsonl"), `${JSON.stringify(record)}
`, "utf8");
  }
  readValidations() {
    return readJsonl(this.path("validations.jsonl"));
  }
  async appendVerdicts(verdicts) {
    if (verdicts.length === 0) return;
    const lines = verdicts.map((v) => JSON.stringify(v)).join("\n");
    await appendFile(this.path("verdicts.jsonl"), `${lines}
`, "utf8");
  }
  readFindings() {
    return readJsonl(this.path("findings.jsonl"));
  }
  async appendFindings(findings) {
    if (findings.length === 0) return;
    const lines = findings.map((f) => JSON.stringify(f)).join("\n");
    await appendFile(this.path("findings.jsonl"), `${lines}
`, "utf8");
  }
  async replaceFindings(findings) {
    const lines = findings.map((f) => JSON.stringify(f)).join("\n");
    await writeFile(this.path("findings.jsonl"), findings.length ? `${lines}
` : "", "utf8");
  }
  /** Number of verdicts already recorded for this revision. */
  async carriedProgress() {
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
  async resetProgress() {
    await writeFile(this.path("verdicts.jsonl"), "", "utf8");
    await writeFile(this.path("findings.jsonl"), "", "utf8");
  }
};

// src/core/intent.ts
var DESCRIPTION_CAP = 4e3;
var WORK_ITEM_FIELD_CAP = 1500;
var COMMIT_CAP = 400;
var PAYLOAD_INTENT_CAP = 2500;
var ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'"
};
function htmlToText(html) {
  return html.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\s*li[^>]*>/gi, "\n- ").replace(/<\/\s*(p|div|h[1-6]|tr|ul|ol)\s*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function demoteHeadings(text) {
  let fence;
  return text.split("\n").map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker.startsWith(fence)) fence = void 0;
      return line;
    }
    return fence ? line : line.replace(/^(#{1,4})(\s)/, "###$1$2");
  }).join("\n");
}
function cap(text, limit) {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)} \u2026[truncated]` : trimmed;
}
function renderIntent(intent) {
  const parts = ["# Change intent", "", `**Title:** ${intent.title}`, ""];
  if (intent.description !== void 0) {
    parts.push("## Description", "");
    parts.push(
      intent.description.trim() ? demoteHeadings(cap(intent.description, DESCRIPTION_CAP)) : "_(empty)_"
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
function intentExcerpt(rendered) {
  const body = rendered.replace(/^# Change intent\s*/, "").trim();
  if (body.length <= PAYLOAD_INTENT_CAP) return body;
  return `${body.slice(0, PAYLOAD_INTENT_CAP)}

\u2026[excerpt; the full text is in intent.md]`;
}

// src/core/riskTier.ts
var LARGE_CHURN = 1e3;
var SMALL_CHURN = 300;
var LOW_RISK_CATEGORIES = /* @__PURE__ */ new Set(["docs", "test", "generated", "lock"]);
var MIGRATION = /(^|\/)migrations?\//i;
function computeRiskTier(files, alwaysHuman = []) {
  const high = [];
  const humans = [];
  const security = files.filter((f) => f.decision !== "skip" && f.signals?.includes("security"));
  if (security.length > 0) {
    high.push(`security-sensitive path: ${listPaths(security)}`);
  }
  const migrations = files.filter((f) => MIGRATION.test(f.path) && f.category !== "generated");
  if (migrations.length > 0) {
    high.push(`schema migration: ${listPaths(migrations)}`);
  }
  const secrets = files.filter((f) => f.reason === "secret-path");
  if (secrets.length > 0) {
    high.push(`credential-like file changed: ${listPaths(secrets)}`);
  }
  const churn = files.filter((f) => f.decision === "review").reduce((sum, f) => sum + f.adds + f.dels, 0);
  if (churn > LARGE_CHURN) {
    high.push(`${churn} reviewable lines changed (> ${LARGE_CHURN})`);
  }
  if (alwaysHuman.length > 0) {
    const pinned = files.filter((f) => matchesAny(f.path, alwaysHuman));
    if (pinned.length > 0) humans.push(`always-human path: ${listPaths(pinned)}`);
  }
  if (high.length > 0) {
    return { tier: "high", approvers: 2, reasons: [...high, ...humans] };
  }
  const behavioural = files.filter((f) => !LOW_RISK_CATEGORIES.has(f.category));
  if (behavioural.length === 0 && churn <= SMALL_CHURN && humans.length === 0) {
    return {
      tier: "low",
      approvers: 0,
      reasons: [`only ${describeCategories(files)} changed, ${churn} lines`]
    };
  }
  const reasons = [...humans];
  if (behavioural.length > 0) {
    reasons.push(`${behavioural.length} behavioural file(s), ${churn} reviewable lines`);
  }
  return { tier: "standard", approvers: 1, reasons };
}
function listPaths(files) {
  const shown = files.slice(0, 3).map((f) => f.path);
  return files.length > 3 ? `${shown.join(", ")} (+${files.length - 3} more)` : shown.join(", ");
}
function describeCategories(files) {
  const categories = [...new Set(files.map((f) => f.category))].sort();
  return categories.length > 0 ? categories.join("/") : "no";
}

// src/version.ts
var TOOL_VERSION = "0.4.0";

// src/commands/prepare.ts
var DEPTHS = ["quick", "standard", "deep"];
var MAX_WORK_ITEMS = 10;
async function resolveTarget(target, cwd) {
  const fromUrl = parsePrUrl(target);
  if (fromUrl?.prId) return fromUrl;
  const prId = Number.parseInt(target, 10);
  if (!Number.isFinite(prId)) {
    throw new Error(`Cannot interpret "${target}" as an Azure DevOps pull request URL or id.`);
  }
  const origin = await remoteUrl(cwd);
  const fromRemote = origin ? parseRemoteUrl(origin) : void 0;
  if (!fromRemote) {
    throw new Error(
      `A bare pull request id needs an Azure DevOps "origin" remote to inherit from; origin is "${origin || "unset"}". Pass the full pull request URL instead.`
    );
  }
  return { ...fromRemote, prId };
}
function fieldText(item, name) {
  const value = item.fields?.[name];
  return typeof value === "string" && value.trim() ? value : void 0;
}
async function loadWorkItems(client, prId) {
  try {
    const ids = (await client.listPullRequestWorkItemIds(prId)).slice(0, MAX_WORK_ITEMS);
    const items = await client.getWorkItems(ids);
    return {
      items: items.map((item) => ({
        id: item.id,
        type: fieldText(item, "System.WorkItemType"),
        state: fieldText(item, "System.State"),
        title: fieldText(item, "System.Title"),
        description: fieldText(item, "System.Description") ?? fieldText(item, "Microsoft.VSTS.TCM.ReproSteps"),
        acceptanceCriteria: fieldText(item, "Microsoft.VSTS.Common.AcceptanceCriteria")
      }))
    };
  } catch (err) {
    return { error: err.message.split("\n")[0].slice(0, 200) };
  }
}
async function optionalEvidence(load) {
  try {
    return { available: true, items: await load() };
  } catch (err) {
    return {
      available: false,
      items: [],
      error: err.message.slice(0, 300)
    };
  }
}
async function prepareAdoScope(args, root) {
  const target = await resolveTarget(args.target, root);
  const client = new AdoClient(target);
  const [pr, iterations] = await Promise.all([
    client.getPullRequest(target.prId),
    client.listIterations(target.prId)
  ]);
  if (iterations.length === 0) {
    throw new Error(`Pull request ${target.prId} reports no iterations.`);
  }
  const iteration = args.iteration !== void 0 ? iterations.find((it) => it.id === args.iteration) : iterations[iterations.length - 1];
  if (!iteration) {
    throw new Error(
      `Iteration ${args.iteration} not found; available: ${iterations.map((i) => i.id).join(", ")}.`
    );
  }
  const sourceSHA = iteration.sourceRefCommit.commitId;
  const targetSHA = iteration.targetRefCommit.commitId;
  const baseSHA = iteration.commonRefCommit.commitId;
  const projectId = pr.repository?.project?.id;
  const unavailablePolicies = {
    available: false,
    items: [],
    error: projectId ? void 0 : "Pull request metadata did not include a project id."
  };
  const [threads, changeEntries, builds, policies, workItems] = await Promise.all([
    client.listThreads(target.prId),
    client.listIterationChanges(target.prId, iteration.id, args.since),
    optionalEvidence(() => client.listPullRequestStatuses(target.prId)),
    projectId ? optionalEvidence(() => client.listPolicyEvaluations(target.prId, projectId)) : Promise.resolve(unavailablePolicies),
    loadWorkItems(client, target.prId)
  ]);
  const cred = await getCredential();
  await fetchCommits(root, remoteUrlFor(target), [sourceSHA, baseSHA], cred.header);
  const trackingIds = /* @__PURE__ */ new Map();
  const iterationPaths = /* @__PURE__ */ new Set();
  for (const entry of changeEntries) {
    const path = (entry.item.path ?? "").replace(/^\//, "");
    if (!path || entry.item.isFolder) continue;
    iterationPaths.add(path);
    if (entry.changeTrackingId !== void 0) trackingIds.set(path, entry.changeTrackingId);
  }
  return {
    meta: {
      toolVersion: TOOL_VERSION,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      scope: "ado-pr",
      org: target.org,
      project: target.project,
      ...projectId ? { projectId } : {},
      repo: target.repo,
      repoId: pr.repository?.id ?? "",
      prId: target.prId,
      title: pr.title,
      author: pr.createdBy?.displayName ?? "unknown",
      isDraft: pr.isDraft === true,
      status: pr.status,
      sourceBranch: pr.sourceRefName.replace(/^refs\/heads\//, ""),
      targetBranch: pr.targetRefName.replace(/^refs\/heads\//, ""),
      iterationId: iteration.id,
      ...args.since !== void 0 ? { compareTo: args.since } : {},
      sourceSHA,
      targetSHA,
      baseSHA,
      repoRoot: root,
      webUrl: webUrlFor(target, target.prId)
    },
    threads,
    trackingIds,
    iterationPaths,
    pullRequest: {
      title: pr.title,
      description: pr.description ?? "",
      author: pr.createdBy?.displayName ?? "unknown",
      status: pr.status,
      isDraft: pr.isDraft,
      labels: (pr.labels ?? []).map((l) => l.name),
      iterations: iterations.map((it) => ({
        id: it.id,
        createdDate: it.createdDate,
        description: it.description,
        sourceSHA: it.sourceRefCommit.commitId
      })),
      workItems: workItems.items ?? [],
      ...workItems.error ? { workItemsError: workItems.error } : {}
    },
    policies,
    builds,
    intent: {
      title: pr.title,
      description: pr.description ?? "",
      ...workItems.items ? { workItems: workItems.items } : {},
      ...workItems.error ? { workItemsError: workItems.error } : {}
    },
    credentialSource: cred.source
  };
}
async function prepareLocalScope(args, root) {
  const repoName = root.slice(root.lastIndexOf("/") + 1);
  const branch = await currentBranch(root) || "HEAD";
  if (args.workingTree) {
    const headSHA = await revParse(root, "HEAD");
    return {
      meta: {
        toolVersion: TOOL_VERSION,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        scope: "working-tree",
        repo: repoName,
        title: `Working tree of ${branch}`,
        sourceBranch: branch,
        targetBranch: branch,
        sourceSHA: WORKTREE,
        targetSHA: headSHA,
        baseSHA: headSHA,
        repoRoot: root
      },
      threads: [],
      trackingIds: /* @__PURE__ */ new Map(),
      credentialSource: "none"
    };
  }
  const baseRef = args.branch;
  const base = await mergeBase(root, baseRef, "HEAD");
  const sourceSHA = await revParse(root, "HEAD");
  const commits = await commitMessages(root, base, sourceSHA);
  return {
    intent: { title: commits[0]?.split("\n")[0] ?? `${branch} vs ${baseRef}`, commits },
    meta: {
      toolVersion: TOOL_VERSION,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      scope: "branch",
      repo: repoName,
      title: `${branch} vs ${baseRef}`,
      sourceBranch: branch,
      targetBranch: baseRef,
      sourceSHA,
      targetSHA: await revParse(root, baseRef),
      baseSHA: base,
      repoRoot: root
    },
    threads: [],
    trackingIds: /* @__PURE__ */ new Map(),
    credentialSource: "none"
  };
}
async function prepare(args) {
  const cwd = args.repo ?? process.cwd();
  const root = await repoRoot(cwd);
  const isLocal = args.branch !== void 0 || args.workingTree === true;
  if (!isLocal && !args.target) {
    throw new Error(
      "`prr prepare` needs a pull request URL or id, or --branch <base>, or --working-tree."
    );
  }
  const depth = args.depth ?? "standard";
  if (!DEPTHS.includes(depth)) {
    throw new Error(`--depth must be one of ${DEPTHS.join(", ")}.`);
  }
  const scope = isLocal ? await prepareLocalScope(args, root) : await prepareAdoScope(args, root);
  const rules = await loadRules(root, args.rule, { rev: scope.meta.baseSHA });
  let changes = await listChanges(root, scope.meta.baseSHA, scope.meta.sourceSHA);
  if (args.since !== void 0 && scope.iterationPaths) {
    changes = changes.filter((c) => scope.iterationPaths.has(c.path));
  }
  let files = triage(changes, scope.trackingIds, { maxFileTokens: 6e4, rules });
  const generated = files.filter((file) => file.category === "generated");
  if (generated.length > 1) {
    const contentPairs = await Promise.all(
      generated.map(async (file) => [
        file.path,
        await showFile(root, scope.meta.sourceSHA, file.path)
      ])
    );
    files = collapseGeneratedDuplicates(files, new Map(contentPairs));
  }
  const preset = batchOptionsFor(depth);
  const batches = buildBatches(files, {
    ...preset,
    ...args.maxFiles !== void 0 ? { maxFiles: args.maxFiles } : {},
    ...args.maxTokens !== void 0 ? { maxTokens: args.maxTokens } : {}
  });
  const reviewPaths = files.filter((f) => f.decision === "review").map((f) => f.path);
  const baseTree = await listTree(root, scope.meta.baseSHA);
  const guidanceContents = /* @__PURE__ */ new Map();
  for (const path of instructionFiles(baseTree)) {
    guidanceContents.set(path, await showFile(root, scope.meta.baseSHA, path));
  }
  const guidanceRefs = selectGuidance(baseTree, reviewPaths, guidanceContents);
  for (const ref of guidanceRefs) {
    if (!guidanceContents.has(ref.path)) {
      guidanceContents.set(ref.path, await showFile(root, scope.meta.baseSHA, ref.path));
    }
  }
  const configChanges = files.filter((f) => isReviewConfiguration(f.path)).map((f) => f.path);
  const priorFindings = await collectPriorFindings(
    scope.threads,
    (path) => showFile(root, scope.meta.sourceSHA, path)
  );
  const riskTier = computeRiskTier(files, rules.alwaysHuman);
  const runDir = runDirFor(scope.meta);
  const meta = {
    ...scope.meta,
    runDir,
    depth,
    riskTier,
    ...rules.sources.length > 0 ? { ruleSources: rules.sources } : {},
    ...rules.maxLowFindings !== void 0 ? { limits: { maxLowFindings: rules.maxLowFindings } } : {},
    ...guidanceRefs.length > 0 ? { guidanceFiles: guidanceRefs.map((ref) => ref.path) } : {}
  };
  const store = await RunStore.create(meta);
  const carried = await store.carriedProgress();
  if (args.reset) await store.resetProgress();
  if (scope.pullRequest) await store.writePullRequest(scope.pullRequest);
  if (scope.policies) await store.writePolicies(scope.policies);
  if (scope.builds) await store.writeBuilds(scope.builds);
  await store.writeThreads(scope.threads);
  await store.writeFiles(files);
  await store.writeBatches(batches);
  await store.writePriorFindings(priorFindings);
  const intentDoc = scope.intent ? renderIntent(scope.intent) : void 0;
  if (intentDoc) await store.writeText("intent.md", intentDoc);
  if (guidanceRefs.length > 0) {
    await store.writeText("guidance.md", renderGuidance(guidanceRefs, guidanceContents));
  }
  const fileMap = new Map(files.map((f) => [f.path, f]));
  for (const batch of batches) {
    const content = await renderPayload(batch, {
      repoRoot: root,
      baseSHA: meta.baseSHA,
      sourceSHA: meta.sourceSHA,
      files: fileMap,
      threads: scope.threads,
      depth,
      ...intentDoc ? { intent: intentExcerpt(intentDoc) } : {},
      guidance: { refs: guidanceRefs, contents: guidanceContents },
      priorFindings
    });
    await store.writePayload(batch.payload, content);
  }
  return formatSummary({
    meta,
    files,
    batches,
    threadCount: scope.threads.length,
    credSource: scope.credentialSource,
    carried: args.reset ? 0 : carried,
    ruleSources: rules.sources,
    policies: scope.policies,
    builds: scope.builds,
    intent: scope.intent,
    guidance: guidanceRefs,
    configChanges,
    priorFindings,
    riskTier
  });
}
function evidenceSummary(evidence) {
  if (!evidence) return "not applicable";
  if (!evidence.available) return `unavailable (${evidence.error ?? "request failed"})`;
  if (evidence.items.length === 0) return "none reported";
  const counts = /* @__PURE__ */ new Map();
  for (const item of evidence.items) {
    const state = (item.status ?? item.state ?? "unknown").toLowerCase();
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts].map(([state, count]) => `${state} x${count}`).join(", ");
}
function formatSummary(input) {
  const { meta, files, batches, threadCount, credSource, carried, ruleSources, policies, builds } = input;
  const counts = { review: 0, "stat-only": 0, skip: 0 };
  for (const f of files) counts[f.decision]++;
  const lines = [];
  if (meta.scope === "ado-pr") {
    lines.push(`PR ${meta.prId} \xB7 ${meta.title}`);
    lines.push(
      `${meta.sourceBranch} -> ${meta.targetBranch} \xB7 ${meta.status}${meta.isDraft ? " (draft)" : ""}`
    );
    lines.push(
      `iteration ${meta.iterationId}${meta.compareTo !== void 0 ? ` (since ${meta.compareTo})` : ""} \xB7 source ${meta.sourceSHA.slice(0, 10)} \xB7 base ${meta.baseSHA.slice(0, 10)} \xB7 auth ${credSource}`
    );
  } else {
    lines.push(`${meta.scope} \xB7 ${meta.title}`);
    lines.push(
      `source ${meta.sourceSHA.slice(0, 10)} \xB7 base ${meta.baseSHA.slice(0, 10)} \xB7 ${meta.repoRoot}`
    );
  }
  lines.push(
    `files ${files.length}: review ${counts.review}, stat-only ${counts["stat-only"]}, skipped ${counts.skip}` + (meta.scope === "ado-pr" ? ` \xB7 existing threads ${threadCount}` : "")
  );
  const notReviewed = files.filter((f) => f.decision !== "review");
  if (notReviewed.length > 0) {
    const grouped = /* @__PURE__ */ new Map();
    for (const f of notReviewed) grouped.set(f.reason, (grouped.get(f.reason) ?? 0) + 1);
    lines.push(
      `  not reviewed: ${[...grouped].map(([reason, n]) => `${reason} x${n}`).join(", ")} (listed in files.json, must be reported in the summary)`
    );
  }
  if (ruleSources.length > 0) {
    lines.push(`  rules: ${ruleSources.join(", ")}`);
  }
  lines.push(`  depth: ${meta.depth ?? "standard"}`);
  lines.push(
    `  risk tier: ${input.riskTier.tier} (${input.riskTier.approvers} human approver(s) suggested)` + (input.riskTier.reasons.length > 0 ? ` \u2014 ${input.riskTier.reasons.join("; ")}` : "")
  );
  if (input.intent) {
    const items = input.intent.workItems;
    const parts = [
      input.intent.description !== void 0 ? input.intent.description.trim() ? "description" : "empty description" : void 0,
      items ? `${items.length} work item(s)` : void 0,
      input.intent.workItemsError ? "work items unavailable" : void 0,
      input.intent.commits ? `${input.intent.commits.length} commit message(s)` : void 0
    ].filter(Boolean);
    lines.push(`  intent: ${parts.join(", ") || "title only"} (intent.md)`);
  }
  if (input.guidance.length > 0) {
    lines.push(`  guidance: ${input.guidance.map((ref) => ref.path).join(", ")} (guidance.md, base revision)`);
  }
  if (input.configChanges.length > 0) {
    lines.push(
      `  WARNING: this change edits review configuration (${input.configChanges.join(", ")}); the base revision copy was applied. Review the edit itself as a finding candidate.`
    );
  }
  if (input.priorFindings.length > 0) {
    const open = input.priorFindings.filter((p) => isOpenThreadStatus(p.status));
    const gone = open.filter((p) => p.evidenceStillPresent === false).length;
    const replied = open.filter((p) => p.replies.length > 0).length;
    lines.push(
      `  prior prr findings: ${input.priorFindings.length} posted, ${open.length} open \xB7 ${gone} with evidence gone (fix candidates) \xB7 ${replied} with replies (prior-findings.json)`
    );
  }
  if (meta.scope === "ado-pr") {
    lines.push(`  policies: ${evidenceSummary(policies)}`);
    lines.push(`  PR statuses/builds: ${evidenceSummary(builds)}`);
  }
  lines.push("");
  lines.push(`batches ${batches.length} (highest risk first):`);
  for (const batch of batches) {
    lines.push(
      `  b${String(batch.id).padStart(2, "0")} risk ${batch.risk} \xB7 ${batch.files.length} files \xB7 ~${batch.estTokens} tok${batch.needsPlan ? " \xB7 plan" : ""} \xB7 ${batch.label}`
    );
  }
  lines.push("");
  lines.push(`run dir: ${meta.runDir}`);
  if (carried > 0) {
    lines.push(
      `carried over: ${carried} verdict(s) from an earlier pass over this revision (re-run with --reset to start clean)`
    );
  }
  lines.push(`next: read ${meta.runDir}/payload/b01.md`);
  return lines.join("\n");
}

// src/commands/note.ts
import { readFile as readFile4 } from "node:fs/promises";
import { createHash as createHash2 } from "node:crypto";

// src/core/findingVerification.ts
var VERIFICATION_METHODS = [
  "runtime",
  "test-run",
  "declaration"
];
var DEPENDENCY_CLAIM_PATTERNS = [
  /\b(does|do|did)\s+not\s+exist\b/i,
  /\b(is|are|was|were)\s+not\s+(a\s+)?(real|valid|public|available)\b/i,
  /\bno\s+such\s+(method|function|property|member|api|export)\b/i,
  /\b(is|are)\s+not\s+(a\s+)?(method|function|property|member|export)\b/i,
  /\bnot\s+(a\s+)?(method|function|property|member|export)\s+on\b/i,
  /\bundefined\s+(method|function|property|member|export)\b/i,
  /\balways\s+throws?\b/i,
  /\bnever\s+(exists|resolves|returns|fires|runs)\b/i,
  /\bis\s+(a\s+)?typo\s+for\b/i,
  /\bTypeError\b/,
  /\bis\s+not\s+a\s+function\b/i
];
function assertsDependencyApi(problem, fix) {
  const text = `${problem}
${fix}`;
  return DEPENDENCY_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}
function isValidFindingVerification(verification) {
  return Boolean(
    verification && VERIFICATION_METHODS.includes(verification.method) && verification.detail.trim()
  );
}

// src/commands/note.ts
var SEVERITIES2 = ["critical", "high", "medium", "low"];
var VERDICTS = ["clean", "findings", "cross-batch"];
var CHALLENGE_OUTCOMES = ["confirmed", "refuted", "uncertain"];
function fail(message) {
  throw new Error(message);
}
function fingerprint(path, evidence, problem) {
  const normalized = `${path}|${evidence.replace(/\s+/g, " ").trim()}|${problem.replace(/\s+/g, " ").trim().slice(0, 120)}`;
  return createHash2("sha1").update(normalized).digest("hex").slice(0, 12);
}
function validateVerification(raw, where) {
  if (raw === void 0) return void 0;
  const method = raw.method;
  if (!VERIFICATION_METHODS.includes(method)) {
    fail(`${where}: "verification.method" must be one of ${VERIFICATION_METHODS.join(", ")}.`);
  }
  const detail = (raw.detail ?? "").trim();
  if (!detail) {
    fail(
      `${where}: "verification.detail" is required \u2014 record the command you ran or the declaration you consulted.`
    );
  }
  return { method, detail };
}
function validateFinding(raw, index, knownPaths) {
  const where = `findings[${index}]`;
  const path = (raw.path ?? "").replace(/^\//, "");
  if (!path) fail(`${where}: "path" is required.`);
  if (!knownPaths.has(path)) {
    fail(
      `${where}: "${path}" is not a changed file in this pull request. Use a path exactly as it appears in files.json.`
    );
  }
  const severity = raw.severity;
  if (!SEVERITIES2.includes(severity)) {
    fail(`${where}: "severity" must be one of ${SEVERITIES2.join(", ")}.`);
  }
  for (const field of ["problem", "evidence", "fix"]) {
    if (!raw[field] || !String(raw[field]).trim()) {
      fail(`${where}: "${field}" is required and must be non-empty.`);
    }
  }
  const verification = validateVerification(raw.verification, where);
  if (assertsDependencyApi(raw.problem, raw.fix) && verification === void 0) {
    fail(
      `${where}: this finding asserts something about a dependency's API surface, which verbatim evidence cannot prove. Verify it at runtime (e.g. \`node -e "console.log(typeof x.y)"\`) or by running the project's tests, then add "verification": { "method": "runtime" | "test-run" | "declaration", "detail": "..." }. If you cannot verify it here, move the item to Open Questions instead.`
    );
  }
  return {
    id: fingerprint(path, raw.evidence, raw.problem),
    path,
    line: typeof raw.line === "number" ? raw.line : void 0,
    endLine: typeof raw.endLine === "number" ? raw.endLine : void 0,
    severity,
    category: raw.category?.trim() || "bug",
    problem: raw.problem.trim(),
    evidence: raw.evidence,
    fix: raw.fix.trim(),
    fixedCode: raw.fixedCode,
    ...raw.preExisting === true ? { preExisting: true } : {},
    ...typeof raw.rationale === "string" && raw.rationale.trim() ? { rationale: raw.rationale.trim() } : {},
    status: "candidate",
    ...verification ? { verification } : {},
    batch: raw.batch,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function noteBatch(args) {
  if (!args.allClean) {
    throw new Error("Batch recording currently requires --all-clean.");
  }
  const store = await RunStore.open(args.dir);
  const batches = await store.readBatches();
  const batch = batches.find((candidate) => candidate.id === args.batch);
  if (!batch) {
    throw new Error(
      `Batch ${args.batch} not found; available: ${batches.map((b) => b.id).join(", ") || "none"}.`
    );
  }
  for (const [path, verdict] of args.exceptions) {
    if (!batch.files.includes(path)) {
      throw new Error(`--except path "${path}" is not in batch ${args.batch}.`);
    }
    if (!VERDICTS.includes(verdict)) {
      throw new Error(`--except verdict must be one of ${VERDICTS.join(", ")}.`);
    }
  }
  const existing = await store.readVerdicts();
  const latest = new Map(existing.map((entry) => [entry.path, entry.verdict]));
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const additions = [];
  let unchanged = 0;
  for (const path of batch.files) {
    const requested = args.exceptions.get(path) ?? "clean";
    const current = latest.get(path);
    if (current !== void 0) {
      if (current !== requested) {
        throw new Error(
          `Refusing to change ${path} from "${current}" to "${requested}". Record the correction explicitly with \`prr note --file\`.`
        );
      }
      unchanged++;
      continue;
    }
    additions.push({
      path,
      batch: batch.id,
      verdict: requested,
      at: now
    });
  }
  await store.appendVerdicts(additions);
  const meta = await store.meta();
  return [
    `${meta.scope === "ado-pr" ? `PR ${meta.prId}` : meta.scope} \xB7 ${meta.sourceSHA.slice(0, 10)}`,
    `batch ${batch.id}: recorded ${additions.length} verdict(s), ${unchanged} already identical`,
    `  clean ${additions.filter((v) => v.verdict === "clean").length}, findings ${additions.filter((v) => v.verdict === "findings").length}, cross-batch ${additions.filter((v) => v.verdict === "cross-batch").length}`
  ].join("\n");
}
async function note(args) {
  const store = await RunStore.open(args.dir);
  const raw = await readFile4(args.file, "utf8");
  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${args.file} is not valid JSON: ${err.message}`);
  }
  const files = await store.readFiles();
  const knownPaths = new Set(files.map((f) => f.path));
  const reviewable = new Set(files.filter((f) => f.decision === "review").map((f) => f.path));
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const verdicts = [];
  for (const [index, entry] of (input.verdicts ?? []).entries()) {
    const path = (entry.path ?? "").replace(/^\//, "");
    if (!reviewable.has(path)) {
      fail(
        `verdicts[${index}]: "${path}" is not a file this run reviews. Reviewable paths are listed in files.json with decision "review".`
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
      at: now
    });
  }
  const incoming = (input.findings ?? []).map(
    (f, i) => validateFinding({ ...f, batch: f.batch ?? input.batch }, i, knownPaths)
  );
  const existing = await store.readFindings();
  const seen = new Set(existing.map((f) => f.id));
  const fresh = incoming.filter((f) => !seen.has(f.id));
  await store.appendVerdicts(verdicts);
  await store.appendFindings(fresh);
  const corrected = await applyCorrections(store, input);
  const challenged = await applyChallenges(store, input, await store.readFindings());
  const retractIds = input.retract ?? [];
  let retracted = 0;
  if (retractIds.length > 0) {
    const all = await store.readFindings();
    const byId = new Map(all.map((f) => [f.id, f]));
    for (const id of retractIds) {
      if (!byId.has(id)) {
        fail(`retract: "${id}" is not a recorded finding id.`);
      }
    }
    const updated = all.map(
      (f) => retractIds.includes(f.id) ? { ...f, status: "retracted" } : f
    );
    await store.replaceFindings(updated);
    retracted = retractIds.length;
  }
  const duplicates = incoming.length - fresh.length;
  const bySeverity2 = /* @__PURE__ */ new Map();
  for (const f of fresh) bySeverity2.set(f.severity, (bySeverity2.get(f.severity) ?? 0) + 1);
  const lines = [
    `recorded ${verdicts.length} verdict(s), ${fresh.length} finding(s)` + (duplicates > 0 ? ` (${duplicates} already recorded, ignored)` : "") + (retracted > 0 ? `, ${retracted} finding(s) retracted` : "") + (corrected.duplicates > 0 ? `, ${corrected.duplicates} marked duplicate` : "") + (corrected.reclassified > 0 ? `, ${corrected.reclassified} reclassified` : "") + (challenged.total > 0 ? `, ${challenged.total} challenge(s): ${challenged.confirmed} confirmed, ${challenged.refuted} refuted (retracted), ${challenged.uncertain} uncertain` : "")
  ];
  if (fresh.length > 0) {
    lines.push(`  severities: ${[...bySeverity2].map(([s, n]) => `${s} x${n}`).join(", ")}`);
  }
  const done = new Set((await store.readVerdicts()).map((v) => v.path));
  const covered = [...reviewable].filter((path) => done.has(path)).length;
  lines.push(`coverage: ${covered}/${reviewable.size} reviewable files have a verdict`);
  return lines.join("\n");
}
async function applyChallenges(store, input, all) {
  const entries = input.challenges ?? [];
  const tally = { total: 0, confirmed: 0, refuted: 0, uncertain: 0 };
  if (entries.length === 0) return tally;
  const byId = new Map(all.map((f) => [f.id, f]));
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const [index, entry] of entries.entries()) {
    const where = `challenges[${index}]`;
    const finding = byId.get(entry?.id);
    if (!finding) fail(`${where}: "${entry?.id}" is not a recorded finding id.`);
    if (!CHALLENGE_OUTCOMES.includes(entry.outcome)) {
      fail(`${where}: "outcome" must be one of ${CHALLENGE_OUTCOMES.join(", ")}.`);
    }
    const detail = (entry.detail ?? "").trim();
    if (!detail) fail(`${where}: "detail" is required \u2014 say what was checked.`);
    if (finding.status === "retracted" || finding.status === "duplicate") {
      fail(`${where}: finding ${finding.id} is ${finding.status}, which is terminal.`);
    }
    const challenge = { outcome: entry.outcome, detail, by: entry.by?.trim() || "unspecified", at: now };
    byId.set(
      finding.id,
      entry.outcome === "refuted" ? { ...finding, challenge, status: "retracted", retractReason: detail } : { ...finding, challenge }
    );
    tally.total++;
    tally[entry.outcome]++;
  }
  await store.replaceFindings(all.map((f) => byId.get(f.id)));
  return tally;
}
async function applyCorrections(store, input) {
  const duplicates = input.duplicates ?? [];
  const reclassify = input.reclassify ?? [];
  if (duplicates.length === 0 && reclassify.length === 0) return { duplicates: 0, reclassified: 0 };
  const all = await store.readFindings();
  const byId = new Map(all.map((f) => [f.id, f]));
  const editable = (id, where) => {
    const finding = byId.get(id);
    if (!finding) fail(`${where}: "${id}" is not a recorded finding id.`);
    if (finding.status === "retracted" || finding.status === "duplicate") {
      fail(`${where}: finding ${id} is ${finding.status}, which is terminal.`);
    }
    return finding;
  };
  for (const [index, entry] of duplicates.entries()) {
    const where = `duplicates[${index}]`;
    const finding = editable(entry?.id, where);
    if (!Number.isInteger(entry.thread) || entry.thread <= 0) {
      fail(`${where}: "thread" must be the id of the existing thread that covers it.`);
    }
    byId.set(finding.id, { ...finding, status: "duplicate", dupOfThread: entry.thread });
  }
  for (const [index, entry] of reclassify.entries()) {
    const where = `reclassify[${index}]`;
    const finding = editable(entry?.id, where);
    if (!SEVERITIES2.includes(entry.severity)) {
      fail(`${where}: "severity" must be one of ${SEVERITIES2.join(", ")}.`);
    }
    byId.set(finding.id, { ...byId.get(finding.id), severity: entry.severity });
  }
  await store.replaceFindings(all.map((f) => byId.get(f.id)));
  return { duplicates: duplicates.length, reclassified: reclassify.length };
}

// src/core/sarif.ts
var SARIF_LEVEL = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note"
};
var SEVERITY_SCORE = {
  critical: "9.5",
  high: "8.0",
  medium: "5.0",
  low: "2.0"
};
function renderSarif(findings, meta) {
  const publishable = findings.filter((f) => f.status === "verified" && f.line !== void 0);
  const ruleIds = [...new Set(publishable.map((f) => f.category))].sort();
  const rules = ruleIds.map((id) => ({
    id,
    name: id,
    shortDescription: { text: `${id} finding reported by pr-review` },
    defaultConfiguration: { level: "warning" }
  }));
  const results = publishable.map((finding) => ({
    ruleId: finding.category,
    // A defect the change did not introduce is context, not a gate on this change.
    level: finding.preExisting ? "note" : SARIF_LEVEL[finding.severity],
    message: { text: `${finding.problem}

Fix: ${finding.fix}` },
    properties: {
      severity: finding.severity,
      "security-severity": SEVERITY_SCORE[finding.severity],
      fingerprint: finding.id,
      ...finding.verification ? { verification: finding.verification } : {},
      ...finding.preExisting ? { preExisting: true } : {},
      ...finding.challenge ? { challenge: finding.challenge.outcome } : {}
    },
    partialFingerprints: { prReviewFindingId: finding.id },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: finding.path },
          region: {
            startLine: finding.line,
            endLine: finding.endLine ?? finding.line,
            snippet: { text: finding.evidence }
          }
        }
      }
    ]
  }));
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "pr-review",
            version: meta.toolVersion,
            informationUri: "https://github.com/",
            rules
          }
        },
        versionControlProvenance: [
          {
            repositoryUri: meta.webUrl ?? meta.repoRoot,
            revisionId: meta.sourceSHA,
            branch: meta.sourceBranch
          }
        ],
        results
      }
    ]
  };
  return JSON.stringify(sarif, null, 2);
}
function renderJson(findings, meta) {
  return JSON.stringify(
    {
      scope: meta.scope,
      repo: meta.repo,
      prId: meta.prId,
      sourceSHA: meta.sourceSHA,
      baseSHA: meta.baseSHA,
      findings
    },
    null,
    2
  );
}

// src/commands/finalize.ts
var SEVERITY_LABEL = {
  critical: "\u{1F534} **Critical**",
  high: "\u{1F7E0} **High**",
  medium: "\u{1F7E1} **Medium**",
  low: "\u{1F535} **Low**"
};
var SEVERITY_NAME = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low"
};
var SEVERITY_ORDER = ["critical", "high", "medium", "low"];
var PRE_EXISTING_LABEL = "\u{1F7E3} **Pre-existing**";
function challengeRequired(depth, finding) {
  if (finding.preExisting) return false;
  if (depth === "quick") return false;
  if (depth === "deep") return true;
  return finding.severity !== "low";
}
function applySuppression(findings, files, meta) {
  const minByPath = new Map(files.map((f) => [f.path, f.minSeverity]));
  const depth = meta.depth ?? "standard";
  const out = findings.map((finding) => {
    if (finding.status !== "verified") return finding;
    const min = minByPath.get(finding.path);
    if (min && SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(min)) {
      return { ...finding, status: "suppressed", suppressedReason: `below the ${min} threshold for this path` };
    }
    if (depth === "quick" && finding.severity === "low") {
      return { ...finding, status: "suppressed", suppressedReason: "quick reviews report Medium and above" };
    }
    return finding;
  });
  const cap2 = meta.limits?.maxLowFindings;
  if (cap2 !== void 0) {
    const lows = out.map((finding, index) => ({ finding, index })).filter(({ finding }) => finding.status === "verified" && finding.severity === "low" && !finding.preExisting).sort(
      (a, b) => (a.finding.batch ?? 0) - (b.finding.batch ?? 0) || a.finding.createdAt.localeCompare(b.finding.createdAt)
    );
    for (const { finding, index } of lows.slice(cap2)) {
      out[index] = { ...finding, status: "suppressed", suppressedReason: `over the cap of ${cap2} Low findings` };
    }
  }
  return out;
}
function shingles(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const out = /* @__PURE__ */ new Set();
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}
function similarity(a, b) {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return shared / Math.min(sa.size, sb.size);
}
function findDuplicateCandidates(finding, threads) {
  const text = `${finding.problem} ${finding.fix}`;
  const out = [];
  for (const thread of threads) {
    if (thread.isDeleted || thread.isBot || thread.path !== finding.path) continue;
    const body = thread.comments.map((c) => c.body).join(" ");
    let score = similarity(text, body);
    if (finding.line && thread.line && Math.abs(finding.line - thread.line) <= 10) score += 0.25;
    if (score >= 0.3) out.push({ thread, score: Math.round(score * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}
async function finalize(args) {
  const store = await RunStore.open(args.dir);
  const meta = await store.meta();
  const files = await store.readFiles();
  const threads = await store.readThreads();
  const findings = await store.readFindings();
  const verdicts = await store.readVerdicts();
  const validations = await store.readValidations();
  const reviewable = files.filter((f) => f.decision === "review");
  const reviewablePaths = reviewable.map((f) => f.path);
  const verified = [];
  const notes = [];
  for (const finding of findings) {
    if (finding.status === "duplicate" || finding.status === "retracted") {
      verified.push(finding);
      continue;
    }
    const updated = { ...finding };
    delete updated.suppressedReason;
    if (assertsDependencyApi(finding.problem, finding.fix) && !isValidFindingVerification(finding.verification)) {
      updated.status = "unverified";
      notes.push(
        `  ${finding.id} (${finding.path}): dependency API claim lacks runtime, test-run, or declaration verification; move it to Open Questions or add verification`
      );
      verified.push(updated);
      continue;
    }
    const result2 = await resolveEvidence(
      meta.repoRoot,
      meta.sourceSHA,
      finding.path,
      finding.evidence,
      reviewablePaths
    );
    switch (result2.outcome) {
      case "resolved":
        updated.status = "verified";
        updated.line = result2.location.startLine;
        updated.endLine = result2.location.endLine;
        break;
      case "relocated":
        updated.status = "verified";
        updated.path = result2.relocatedTo;
        updated.line = result2.location.startLine;
        updated.endLine = result2.location.endLine;
        notes.push(
          `  ${finding.id}: evidence lives in ${result2.relocatedTo}, finding re-filed there`
        );
        break;
      case "ambiguous":
        updated.status = "unlocated";
        notes.push(
          `  ${finding.id} (${finding.path}): evidence matches several places in the file; quote a longer unique span`
        );
        break;
      case "ambiguous-elsewhere":
        updated.status = "unlocated";
        notes.push(
          `  ${finding.id} (${finding.path}): evidence is absent here but present in ${result2.candidates.length} other changed files (${result2.candidates.slice(0, 2).join(", ")}); name the right file or quote a longer span`
        );
        break;
      default:
        updated.status = "unverified";
        notes.push(
          `  ${finding.id} (${finding.path}): evidence not found at ${meta.sourceSHA.slice(0, 10)}; move to Open Questions or quote the code exactly`
        );
    }
    if (updated.status === "verified" && updated.challenge?.outcome === "uncertain") {
      updated.status = "unconfirmed";
      notes.push(
        `  ${finding.id} (${finding.path}): the independent challenge was uncertain; report it under Open Questions, not Findings`
      );
    }
    verified.push(updated);
  }
  const depth = meta.depth ?? "standard";
  const settled = applySuppression(verified, files, meta);
  verified.splice(0, verified.length, ...settled);
  await store.replaceFindings(verified);
  const lastVerdict = /* @__PURE__ */ new Map();
  for (const v of verdicts) lastVerdict.set(v.path, v.verdict);
  const reviewableSet = new Set(reviewablePaths);
  const covered = reviewablePaths.filter((path) => lastVerdict.has(path)).length;
  const missing = reviewablePaths.filter((p) => !lastVerdict.has(p));
  const crossBatch = [...lastVerdict].filter(([path, verdict]) => reviewableSet.has(path) && verdict === "cross-batch").map(([path]) => path);
  const publishable = verified.filter((f) => f.status === "verified");
  const blocked = verified.filter(
    (f) => f.status === "candidate" || f.status === "unverified" || f.status === "unlocated"
  );
  const unconfirmed = verified.filter((f) => f.status === "unconfirmed");
  const suppressed = verified.filter((f) => f.status === "suppressed");
  const unchallenged = publishable.filter(
    (f) => challengeRequired(depth, f) && f.challenge === void 0
  );
  if (args.render) {
    if (args.format === "sarif") return { output: renderSarif(verified, meta), ok: true };
    if (args.format === "json") return { output: renderJson(verified, meta), ok: true };
    return { output: renderFindings(verified, threads), ok: true };
  }
  const lines = [];
  lines.push(
    meta.scope === "ado-pr" ? `PR ${meta.prId} \xB7 iteration ${meta.iterationId} \xB7 ${meta.sourceSHA.slice(0, 10)}` : `${meta.scope} \xB7 ${meta.title} \xB7 ${meta.sourceSHA.slice(0, 10)}`
  );
  const preExisting = publishable.filter((f) => f.preExisting).length;
  lines.push(
    `findings: ${publishable.length} verified` + (preExisting > 0 ? ` (${preExisting} pre-existing)` : "") + `, ${blocked.length} not publishable, ${unconfirmed.length} unconfirmed, ${suppressed.length} suppressed, ${verified.filter((f) => f.status === "duplicate").length} marked duplicate, ${verified.filter((f) => f.status === "retracted").length} retracted`
  );
  if (suppressed.length > 0) {
    const reasons = /* @__PURE__ */ new Map();
    for (const f of suppressed) {
      const reason = f.suppressedReason ?? "suppressed";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    lines.push(
      `suppressed: ${[...reasons].map(([reason, n]) => `${n} ${reason}`).join("; ")} (count them in the Summary; do not report them as findings)`
    );
  }
  lines.push(`coverage: ${covered}/${reviewablePaths.length} reviewable files`);
  if (validations.length > 0) {
    const passed = validations.filter((record) => record.exitCode === 0).length;
    const failed = validations.length - passed;
    lines.push(`validations: ${validations.length} recorded \xB7 ${passed} passed \xB7 ${failed} failed`);
    for (const record of validations.filter((item) => item.exitCode !== 0).slice(0, 5)) {
      lines.push(`  exit ${record.exitCode}: ${record.command.join(" ")}`);
    }
  }
  if (notes.length > 0) {
    lines.push("verification notes:");
    lines.push(...notes.slice(0, 15));
  }
  const dupHints = [];
  for (const finding of publishable) {
    for (const candidate of findDuplicateCandidates(finding, threads)) {
      dupHints.push(
        `  ${finding.id} (${finding.path}:${finding.line}) ~ thread ${candidate.thread.id} [${candidate.thread.status}] score ${candidate.score}`
      );
    }
  }
  if (dupHints.length > 0) {
    lines.push("possible duplicates of existing threads (decide, then re-note as duplicate):");
    lines.push(...dupHints.slice(0, 10));
  }
  let ok = true;
  if (missing.length > 0) {
    ok = false;
    lines.push(`BLOCKED: ${missing.length} reviewable file(s) have no verdict:`);
    lines.push(...missing.slice(0, 20).map((p) => `  ${p}`));
    if (missing.length > 20) lines.push(`  ... and ${missing.length - 20} more`);
  }
  if (crossBatch.length > 0) {
    ok = false;
    lines.push(`BLOCKED: ${crossBatch.length} file(s) still marked cross-batch:`);
    lines.push(...crossBatch.slice(0, 10).map((p) => `  ${p}`));
  }
  if (unchallenged.length > 0) {
    ok = false;
    lines.push(
      `BLOCKED: ${unchallenged.length} finding(s) need an independent challenge at depth ${depth} (record {"challenges": [{"id", "outcome", "detail", "by"}]} with prr note --file):`
    );
    lines.push(
      ...unchallenged.slice(0, 10).map((f) => `  ${f.id} ${f.severity} ${f.path}:${f.line ?? "?"}`)
    );
  }
  const result = buildResult(meta, verified, ok, covered, reviewablePaths.length);
  await store.writeResult(result);
  lines.push(
    `result: ${result.suggestedVerdict} \xB7 blocking ${result.blocking}` + (meta.riskTier ? ` \xB7 risk tier ${meta.riskTier.tier}` : "") + " (result.json)"
  );
  lines.push(
    ok ? "OK: coverage complete. Render the report, then ask before posting." : "Resolve the blockers above before producing a verdict."
  );
  return { output: lines.join("\n"), ok };
}
function buildResult(meta, findings, ok, covered, total) {
  const verified = findings.filter((f) => f.status === "verified");
  const current = verified.filter((f) => !f.preExisting);
  const count = (severity) => current.filter((f) => f.severity === severity).length;
  const blocking = current.filter((f) => f.severity !== "low").length;
  const unconfirmed = findings.filter((f) => f.status === "unconfirmed");
  const doubtfulBlocking = unconfirmed.filter((f) => !f.preExisting && f.severity !== "low").length;
  return {
    tool: "prr",
    version: TOOL_VERSION,
    scope: meta.scope,
    ...meta.prId !== void 0 ? { prId: meta.prId } : {},
    ...meta.iterationId !== void 0 ? { iterationId: meta.iterationId } : {},
    sourceSHA: meta.sourceSHA,
    depth: meta.depth ?? "standard",
    ok,
    coverage: { covered, total },
    counts: {
      critical: count("critical"),
      high: count("high"),
      medium: count("medium"),
      low: count("low"),
      preExisting: verified.length - current.length,
      suppressed: findings.filter((f) => f.status === "suppressed").length,
      unconfirmed: unconfirmed.length,
      notPublishable: findings.filter(
        (f) => f.status === "candidate" || f.status === "unverified" || f.status === "unlocated"
      ).length,
      duplicate: findings.filter((f) => f.status === "duplicate").length,
      retracted: findings.filter((f) => f.status === "retracted").length
    },
    blocking,
    suggestedVerdict: !ok ? "incomplete" : blocking > 0 ? "request-changes" : doubtfulBlocking > 0 ? "needs-clarification" : "approve",
    ...meta.riskTier ? { riskTier: meta.riskTier } : {}
  };
}
function renderBlock(f) {
  const lines = [];
  const label = f.preExisting ? `${PRE_EXISTING_LABEL} (${SEVERITY_NAME[f.severity]})` : SEVERITY_LABEL[f.severity];
  lines.push(`${label} \u2014 \`${f.path}\` (line ${f.line ?? "?"})`);
  lines.push(`Problem: ${f.problem}`);
  lines.push("Evidence:");
  lines.push("```");
  lines.push(f.evidence.trimEnd());
  lines.push("```");
  lines.push(`Fix: ${f.fix}`);
  if (f.rationale) lines.push(`Why flagged: ${f.rationale}`);
  if (f.verification) {
    lines.push(`Verification (${f.verification.method}): ${f.verification.detail}`);
  }
  if (f.challenge) lines.push(`Challenge (${f.challenge.outcome}): ${f.challenge.detail}`);
  if (f.fixedCode) {
    lines.push("Fixed code:");
    lines.push("```");
    lines.push(f.fixedCode.trimEnd());
    lines.push("```");
  }
  return lines.join("\n");
}
function bySeverity(a, b) {
  return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.path.localeCompare(b.path);
}
function renderFindings(findings, threads) {
  const verified = findings.filter((f) => f.status === "verified");
  const current = verified.filter((f) => !f.preExisting).sort(bySeverity);
  const preExisting = verified.filter((f) => f.preExisting).sort(bySeverity);
  const unconfirmed = findings.filter((f) => f.status === "unconfirmed").sort(bySeverity);
  const suppressed = findings.filter((f) => f.status === "suppressed").length;
  const sections = [];
  if (current.length === 0) {
    sections.push(
      "No verified findings introduced by this change. State this explicitly and describe any validation gaps."
    );
  } else {
    sections.push(current.map(renderBlock).join("\n\n"));
  }
  if (preExisting.length > 0) {
    sections.push(
      "#### Pre-existing issues (not introduced by this change; never block the verdict)\n\n" + preExisting.map(renderBlock).join("\n\n")
    );
  }
  if (unconfirmed.length > 0) {
    sections.push(
      "#### For Open Questions (independent challenge was uncertain)\n\n" + unconfirmed.map((f) => `- \`${f.path}\` line ${f.line ?? "?"} (${f.severity}): ${f.problem} \u2014 challenge: ${f.challenge?.detail ?? ""}`).join("\n")
    );
  }
  const notes = [];
  if (suppressed > 0) {
    notes.push(`_${suppressed} verified finding(s) were suppressed by path thresholds or caps and are not listed._`);
  }
  const covered = threads.filter((t) => !t.isBot && !t.isDeleted && t.path).length;
  if (covered > 0) {
    notes.push(`_${covered} existing inline thread(s) were reconciled; duplicates are omitted above._`);
  }
  return `${sections.join("\n\n")}
${notes.length > 0 ? `
${notes.join("\n")}` : ""}`;
}

// src/commands/post.ts
import { readFile as readFile5, writeFile as writeFile2 } from "node:fs/promises";
import { existsSync as existsSync3 } from "node:fs";
import { createHash as createHash3 } from "node:crypto";
var SEVERITY_LABEL2 = {
  critical: "\u{1F534} **Critical**",
  high: "\u{1F7E0} **High**",
  medium: "\u{1F7E1} **Medium**",
  low: "\u{1F535} **Low**"
};
var SEVERITY_RANK = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};
function commentBody(finding) {
  const label = finding.preExisting ? `\u{1F7E3} **Pre-existing** (${SEVERITY_LABEL2[finding.severity]}) \u2014 not introduced by this pull request` : SEVERITY_LABEL2[finding.severity];
  const evidence = finding.evidence.trimEnd();
  const evidenceFence = fenceFor(evidence);
  const parts = [
    `${label} \u2014 ${finding.problem}`,
    "",
    "**Evidence**",
    evidenceFence,
    evidence,
    evidenceFence,
    `**Fix** ${finding.fix}`
  ];
  if (finding.fixedCode) {
    const code = finding.fixedCode.trimEnd();
    const fence = fenceFor(code);
    parts.push("", "**Suggested code**", fence, code, fence);
  }
  const why = [];
  if (finding.rationale) why.push(finding.rationale);
  if (finding.challenge?.outcome === "confirmed") {
    why.push(`Independently challenged and confirmed: ${finding.challenge.detail}`);
  }
  if (finding.verification) {
    why.push(`Verified by ${finding.verification.method}: ${finding.verification.detail}`);
  }
  if (why.length > 0) parts.push("", `**Why this was flagged** ${why.join(" ")}`);
  parts.push("", findingMarker(finding));
  return parts.join("\n");
}
function resultFooter(result) {
  const c = result.counts;
  return `_prr result: ${result.suggestedVerdict} \xB7 critical ${c.critical} \xB7 high ${c.high} \xB7 medium ${c.medium} \xB7 low ${c.low} \xB7 pre-existing ${c.preExisting} \xB7 suppressed ${c.suppressed}` + (result.iterationId !== void 0 ? ` \xB7 iteration ${result.iterationId}` : "") + ` \xB7 ${result.sourceSHA.slice(0, 10)}_`;
}
var SUMMARY_KEY = "__summary__";
async function post(args) {
  const modes = [
    args.retract && args.retract.length > 0,
    args.updateSummary,
    args.resolve && args.resolve.length > 0
  ].filter(Boolean).length;
  if (modes > 1) {
    throw new Error(
      "--retract, --update-summary and --resolve are separate write actions; run them separately."
    );
  }
  const store = await RunStore.open(args.dir);
  const meta = await store.meta();
  const org = meta.org;
  const project = meta.project;
  const prId = meta.prId;
  if (meta.scope !== "ado-pr" || !org || !project || prId === void 0) {
    throw new Error(
      `This run has scope "${meta.scope}", which has no pull request to comment on. Use \`prr finalize --render\` to produce the report instead.`
    );
  }
  const findings = await store.readFindings();
  const files = await store.readFiles();
  const threshold = SEVERITY_RANK[args.minSeverity ?? "high"];
  const ledgerPath = store.path("posted.json");
  const ledger = existsSync3(ledgerPath) ? JSON.parse(await readFile5(ledgerPath, "utf8")) : {};
  const saveLedger = () => writeFile2(ledgerPath, `${JSON.stringify(ledger, null, 2)}
`, "utf8");
  if (args.retract && args.retract.length > 0) {
    return retractFindings({
      args,
      client: new AdoClient({ org, project, repo: meta.repo }),
      findings,
      ledger,
      prId,
      saveLedger
    });
  }
  if (args.resolve && args.resolve.length > 0) {
    return resolveThreads({
      args,
      client: new AdoClient({ org, project, repo: meta.repo }),
      store,
      ledger,
      prId,
      saveLedger
    });
  }
  if (args.updateSummary) {
    return updateSummary({
      args,
      client: new AdoClient({ org, project, repo: meta.repo }),
      store,
      ledger,
      prId,
      saveLedger
    });
  }
  const locatable = findings.filter(
    (f) => f.status === "verified" && typeof f.line === "number"
  );
  const terminalExcluded = findings.filter(
    (f) => f.status === "duplicate" || f.status === "retracted"
  ).length;
  const notPublishable = findings.filter(
    (f) => f.status !== "verified" && f.status !== "duplicate" && f.status !== "retracted"
  ).length + findings.filter((f) => f.status === "verified" && typeof f.line !== "number").length;
  const preExistingWithheld = args.includePreExisting ? 0 : locatable.filter((f) => f.preExisting).length;
  const inScope = locatable.filter((f) => args.includePreExisting || !f.preExisting);
  const eligible = inScope.filter((f) => SEVERITY_RANK[f.severity] <= threshold);
  const belowThreshold = inScope.length - eligible.length;
  const priorById = new Map((await store.readPriorFindings()).map((p) => [p.findingId, p.threadId]));
  for (const f of eligible) {
    if (ledger[f.id] === void 0 && priorById.has(f.id)) ledger[f.id] = priorById.get(f.id);
  }
  const pending = eligible.filter((f) => ledger[f.id] === void 0);
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  if (args.dryRun) {
    const lines2 = [
      `dry run: ${pending.length} thread(s) would be posted to PR ${prId} (${eligible.length - pending.length} already posted, ${belowThreshold} below --min-severity, ${preExistingWithheld} pre-existing withheld, ${notPublishable} not publishable, ${terminalExcluded} duplicate/retracted)`
    ];
    for (const f of pending) {
      lines2.push(`  ${f.severity} ${f.path}:${f.line} [${f.id}]`);
    }
    if (args.summaryFile) lines2.push("  + 1 summary comment");
    return lines2.join("\n");
  }
  const client = new AdoClient({ org, project, repo: meta.repo });
  const posted = [];
  const failed = [];
  for (const finding of pending) {
    try {
      const body = await buildThread(meta, finding, fileByPath.get(finding.path));
      const thread = await client.createThread(prId, body);
      ledger[finding.id] = thread.id;
      posted.push(`  ${finding.severity} ${finding.path}:${finding.line} -> thread ${thread.id}`);
    } catch (err) {
      failed.push(`  ${finding.path}:${finding.line} \u2014 ${err.message.slice(0, 160)}`);
    }
    await saveLedger();
  }
  let summaryLine = "";
  if (args.summaryFile) {
    const content = await summaryContent(args.summaryFile, store);
    if (ledger[SUMMARY_KEY] !== void 0) {
      summaryLine = `summary comment already posted as thread ${ledger[SUMMARY_KEY]} (use --update-summary to append a correction)`;
    } else {
      const thread = await client.createThread(prId, {
        comments: [{ content, commentType: 1 }],
        status: 1
      });
      ledger[SUMMARY_KEY] = thread.id;
      ledger[`summary:${summaryHash(content)}`] = thread.id;
      await saveLedger();
      summaryLine = `summary comment posted as thread ${thread.id}`;
    }
  }
  const lines = [`posted ${posted.length} thread(s) to PR ${prId}`];
  lines.push(...posted);
  if (summaryLine) lines.push(summaryLine);
  if (failed.length > 0) {
    lines.push(`failed ${failed.length}:`);
    lines.push(...failed);
  }
  if (belowThreshold > 0) {
    lines.push(
      `${belowThreshold} finding(s) are below --min-severity ${args.minSeverity ?? "high"} (already excluded for no other reason; rerun with a lower threshold to include them).`
    );
  }
  if (preExistingWithheld > 0) {
    lines.push(
      `${preExistingWithheld} pre-existing finding(s) were withheld (rerun with --include-pre-existing to post them).`
    );
  }
  if (notPublishable > 0) {
    lines.push(
      `${notPublishable} finding(s) were not publishable (unverified, unlocated, unconfirmed or suppressed).`
    );
  }
  if (terminalExcluded > 0) {
    lines.push(`${terminalExcluded} finding(s) were terminally excluded (duplicate or retracted).`);
  }
  return lines.join("\n");
}
async function buildThread(meta, finding, file) {
  const line = finding.line;
  const endLine = finding.endLine ?? line;
  const content = await showFile(meta.repoRoot, meta.sourceSHA, finding.path);
  const lines = content.split("\n");
  const endOffset = Math.max(1, (lines[endLine - 1] ?? "").length + 1);
  const thread = {
    comments: [{ content: commentBody(finding), commentType: 1 }],
    status: 1,
    threadContext: {
      filePath: `/${finding.path}`,
      rightFileStart: { line, offset: 1 },
      rightFileEnd: { line: endLine, offset: endOffset }
    }
  };
  if (file?.changeTrackingId !== void 0 && meta.iterationId !== void 0) {
    thread.pullRequestThreadContext = {
      changeTrackingId: file.changeTrackingId,
      iterationContext: {
        firstComparingIteration: meta.iterationId,
        secondComparingIteration: meta.iterationId
      }
    };
  }
  return thread;
}
async function retractFindings(ctx) {
  const { args, client, findings, ledger, prId, saveLedger } = ctx;
  const byId = new Map(findings.map((f) => [f.id, f]));
  const planned = [];
  const skipped = [];
  for (const id of args.retract ?? []) {
    const finding = byId.get(id);
    if (!finding) {
      throw new Error(`--retract: "${id}" is not a recorded finding id.`);
    }
    if (finding.status !== "retracted") {
      throw new Error(
        `--retract: finding ${id} has status "${finding.status}". Mark it retracted first with \`prr note --file\` and {"retract": ["${id}"]}, then re-run this command.`
      );
    }
    const threadId = ledger[id];
    if (threadId === void 0) {
      skipped.push(`  ${id} (${finding.path}) \u2014 never posted, nothing to correct`);
      continue;
    }
    if (ledger[`retracted:${id}`] !== void 0) {
      skipped.push(`  ${id} (${finding.path}) \u2014 thread ${threadId} already corrected and closed`);
      continue;
    }
    planned.push({ finding, threadId });
  }
  if (args.dryRun) {
    const lines2 = [
      `dry run: ${planned.length} posted thread(s) would be corrected and closed on PR ${prId}`
    ];
    for (const { finding, threadId } of planned) {
      lines2.push(`  ${finding.severity} ${finding.path}:${finding.line} -> thread ${threadId}`);
    }
    lines2.push(...skipped);
    return lines2.join("\n");
  }
  const done = [];
  const failed = [];
  for (const { finding, threadId } of planned) {
    try {
      await client.replyToThread(prId, threadId, retractionComment(finding));
      await client.setThreadStatus(prId, threadId, "closed");
      ledger[`retracted:${finding.id}`] = threadId;
      await saveLedger();
      done.push(`  ${finding.path}:${finding.line} -> thread ${threadId} corrected and closed`);
    } catch (err) {
      failed.push(`  ${finding.id} \u2014 ${err.message.slice(0, 160)}`);
    }
  }
  const lines = [`retracted ${done.length} posted finding(s) on PR ${prId}`];
  lines.push(...done, ...skipped);
  if (failed.length > 0) {
    lines.push(`failed ${failed.length}:`);
    lines.push(...failed);
  }
  if (done.length > 0) {
    lines.push(
      "The summary comment may now be stale. Re-render it and run `prr post --update-summary`."
    );
  }
  return lines.join("\n");
}
function retractionComment(finding) {
  return [
    "\u26A0\uFE0F **Correction \u2014 this finding is incorrect, please disregard**",
    "",
    "The claim above did not hold up on closer verification and has been retracted by the",
    "reviewer. No change is needed for this comment.",
    "",
    "Apologies for the noise."
  ].join("\n");
}
async function updateSummary(ctx) {
  const { args, client, ledger, prId, saveLedger } = ctx;
  if (!args.summaryFile) {
    throw new Error("--update-summary requires --summary <path.md> with the corrected text.");
  }
  const content = await summaryContent(args.summaryFile, ctx.store);
  const contentHash2 = summaryHash(content);
  const updateKey = `summary:${contentHash2}`;
  const threadId = ledger[SUMMARY_KEY];
  if (threadId === void 0) {
    if (args.dryRun) {
      return `dry run: no summary thread recorded yet; the text would be posted as a new summary on PR ${prId}`;
    }
    const thread = await client.createThread(prId, {
      comments: [{ content, commentType: 1 }],
      status: 1
    });
    ledger[SUMMARY_KEY] = thread.id;
    ledger[updateKey] = thread.id;
    await saveLedger();
    return `no existing summary thread; summary posted as thread ${thread.id}`;
  }
  if (ledger[updateKey] !== void 0) {
    return `summary correction already posted to thread ${threadId} (content ${contentHash2})`;
  }
  if (args.dryRun) {
    return `dry run: a correction would be appended to summary thread ${threadId} on PR ${prId} (content ${contentHash2})`;
  }
  await client.replyToThread(prId, threadId, content);
  ledger[updateKey] = threadId;
  await saveLedger();
  return `summary correction appended to thread ${threadId} (content ${contentHash2})`;
}
function summaryHash(content) {
  return createHash3("sha256").update(content).digest("hex").slice(0, 16);
}
async function summaryContent(path, store) {
  const text = (await readFile5(path, "utf8")).trimEnd();
  const result = await store.readResult();
  return result ? `${text}

${resultFooter(result)}
` : `${text}
`;
}
async function resolveThreads(ctx) {
  const { args, client, store, ledger, prId, saveLedger } = ctx;
  const resolution = args.resolution ?? "fixed";
  if (resolution !== "fixed" && resolution !== "withdrawn") {
    throw new Error("--resolution must be fixed or withdrawn.");
  }
  const custom = args.messageFile ? (await readFile5(args.messageFile, "utf8")).trim() : void 0;
  const prior = new Map((await store.readPriorFindings()).map((p) => [p.threadId, p]));
  const meta = await store.meta();
  const planned = [];
  const skipped = [];
  for (const threadId of args.resolve ?? []) {
    const entry = prior.get(threadId);
    if (!entry) {
      throw new Error(
        `--resolve: thread ${threadId} is not a prr finding thread on this pull request (see prior-findings.json). Human threads are never resolved by this tool.`
      );
    }
    if (ledger[`resolved:${threadId}`] !== void 0) {
      skipped.push(`  thread ${threadId} \u2014 already resolved by this run`);
      continue;
    }
    if (!isOpenThreadStatus(entry.status)) {
      skipped.push(`  thread ${threadId} \u2014 already ${entry.status}`);
      continue;
    }
    planned.push({ threadId, findingId: entry.findingId, ...entry.path ? { path: entry.path } : {} });
  }
  if (args.dryRun) {
    const lines2 = [`dry run: ${planned.length} thread(s) would be resolved as ${resolution} on PR ${prId}`];
    for (const p of planned) lines2.push(`  thread ${p.threadId} (${p.path ?? "?"}, finding ${p.findingId})`);
    lines2.push(...skipped);
    return lines2.join("\n");
  }
  const done = [];
  const failed = [];
  for (const p of planned) {
    try {
      const text = custom ?? resolutionComment(resolution, meta);
      await client.replyToThread(prId, p.threadId, text);
      await client.setThreadStatus(prId, p.threadId, resolution === "fixed" ? "fixed" : "closed");
      ledger[`resolved:${p.threadId}`] = p.threadId;
      await saveLedger();
      done.push(`  thread ${p.threadId} -> ${resolution === "fixed" ? "fixed" : "closed"}`);
    } catch (err) {
      failed.push(`  thread ${p.threadId} \u2014 ${err.message.slice(0, 160)}`);
    }
  }
  const lines = [`resolved ${done.length} prr thread(s) on PR ${prId} as ${resolution}`];
  lines.push(...done, ...skipped);
  if (failed.length > 0) {
    lines.push(`failed ${failed.length}:`);
    lines.push(...failed);
  }
  return lines.join("\n");
}
function resolutionComment(resolution, meta) {
  const where = meta.iterationId !== void 0 ? `iteration ${meta.iterationId} (${meta.sourceSHA.slice(0, 10)})` : meta.sourceSHA.slice(0, 10);
  return resolution === "fixed" ? `\u2705 **Resolved** \u2014 re-reviewed at ${where}; the issue described above is addressed. Reopen this thread if it is not.` : `\u26A0\uFE0F **Withdrawn** \u2014 re-reviewed at ${where}; this finding does not hold and needs no change. Apologies for the noise.`;
}

// src/commands/recordExec.ts
import { spawn } from "node:child_process";
var MAX_CAPTURE_CHARS = 16e3;
var SECRET_ENV_KEYS = [
  "AZURE_DEVOPS_EXT_PAT",
  "AZURE_DEVOPS_PAT",
  "SYSTEM_ACCESSTOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN"
];
function redact(text) {
  let result = text;
  for (const key of SECRET_ENV_KEYS) {
    const secret = process.env[key];
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]").replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, "$1[REDACTED]@").replace(
    /^([^\n=]*(?:TOKEN|PASSWORD|SECRET|API_KEY)[^\n=]*)=.*$/gim,
    "$1=[REDACTED]"
  );
}
function truncate(text) {
  if (text.length <= MAX_CAPTURE_CHARS) return text;
  const omitted = text.length - MAX_CAPTURE_CHARS;
  return `[... ${omitted} character(s) omitted ...]
${text.slice(-MAX_CAPTURE_CHARS)}`;
}
function commandLabel(command) {
  return command.map((part) => /[\s"']/.test(part) ? JSON.stringify(part) : part).join(" ");
}
async function recordExec(args) {
  if (args.command.length === 0) {
    throw new Error("`prr exec --record` requires a command after `--`.");
  }
  const store = await RunStore.open(args.dir);
  const meta = await store.meta();
  const [executable, ...commandArgs] = args.command;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const timeoutMs = Math.max(1, args.timeoutSeconds ?? 300) * 1e3;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const exitCode = await new Promise((resolve) => {
    const child = spawn(executable, commandArgs, {
      cwd: meta.repoRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      stderr += `${err.message}
`;
      resolve(127);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(timedOut ? 124 : code ?? 1);
    });
  });
  const record = {
    command: args.command.map(redact),
    cwd: meta.repoRoot,
    sourceSHA: meta.sourceSHA,
    startedAt,
    durationMs: Date.now() - started,
    exitCode,
    timedOut,
    stdout: truncate(redact(stdout.trimEnd())),
    stderr: truncate(redact(stderr.trimEnd()))
  };
  await store.appendValidation(record);
  return {
    output: [
      `${meta.scope === "ado-pr" ? `PR ${meta.prId}` : meta.scope} \xB7 ${meta.sourceSHA.slice(0, 10)}`,
      `validation: ${commandLabel(record.command)}`,
      `exit ${exitCode} \xB7 ${record.durationMs} ms${timedOut ? " \xB7 timed out" : ""}`,
      `recorded: ${store.path("validations.jsonl")}`
    ].join("\n"),
    exitCode
  };
}

// src/cli.ts
var DEFAULT_CONTEXT_LINES = 120;
var MAX_CONTEXT_LINES = 500;
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
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
function num(value) {
  if (typeof value !== "string") return void 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function str(value) {
  return typeof value === "string" ? value : void 0;
}
function parseVerdictExceptions(value) {
  const result = /* @__PURE__ */ new Map();
  if (!value) return result;
  for (const entry of value.split(",")) {
    const separator = entry.lastIndexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid --except entry "${entry}"; expected <path>=findings|cross-batch.`);
    }
    const path = entry.slice(0, separator).replace(/^\//, "");
    const verdict = entry.slice(separator + 1);
    if (verdict !== "findings" && verdict !== "cross-batch") {
      throw new Error(`Invalid --except verdict "${verdict}" for ${path}.`);
    }
    if (result.has(path)) throw new Error(`Duplicate --except path: ${path}.`);
    result.set(path, verdict);
  }
  return result;
}
var USAGE = `prr ${TOOL_VERSION} \u2014 deterministic toolkit for Azure DevOps pull request review

Usage:
  prr prepare <pr-url|pr-id> [--repo <path>] [--iteration <n>] [--since <n>]
                             [--depth quick|standard|deep] [--max-files <n>]
                             [--max-tokens <n>] [--rule <path>] [--reset]
  prr prepare --branch <base-ref> [...]
  prr prepare --working-tree [...]
      Pin the revisions, triage every changed file, build risk-ordered batches
      and write one review payload per batch. Run this once per review.
      --branch reviews the current branch against its merge base with <base-ref>;
      --working-tree reviews uncommitted and untracked work against HEAD.
      Also writes intent.md (title, description, linked work items or commit
      messages), guidance.md (AGENTS.md / CLAUDE.md / REVIEW.md from the base
      revision), prior-findings.json (threads posted by earlier prr runs) and a
      suggested risk tier. Rules and guidance are always read from the base
      revision, never from the change under review.

  prr note --file <path.json> [--dir <run>]
      Record file verdicts, candidate findings, independent challenges
      ({"challenges": [...]}), duplicates ({"duplicates": [...]}), severity
      corrections ({"reclassify": [...]}) and retractions from a JSON file.

  prr note --batch <n> --all-clean [--except <path>=findings|cross-batch,...]
           [--dir <run>]
      Mark every file in a reviewed batch clean, with explicit exceptions.
      Refuses to overwrite an existing different verdict.

  prr finalize [--render] [--format md|sarif|json|result] [--dir <run>]
      Verify every finding's evidence against the source revision, resolve its
      line, apply path thresholds and caps, require independent challenges for
      blocking findings, check coverage, and write result.json. --render prints
      the findings; --format result prints result.json.

  prr context --path <p> [--start <n>] [--end <n>] [--dir <run>]
      Read a window of a file at the source revision. Defaults to 120 lines
      from --start; an explicit --end widens it up to 500.

  prr grep <pattern> [--path <pathspec>] [--regex] [--files-only] [--max <n>]
           [--dir <run>]
      Search the source revision for a symbol or literal. Use this instead of
      shell grep: the repository may have no checkout, only the fetched commits.

  prr rules check <path> [--repo <path>] [--rule <path>] [--rev <ref>]
      Show which review rules apply to a path, and from which layer. Reads the
      working tree by default; --rev reads the project rule file at a revision.

  prr post [--min-severity critical|high|medium|low] [--summary <path.md>]
           [--include-pre-existing] [--dry-run] [--dir <run>]
      Publish verified findings as inline threads. Requires explicit user
      approval. Idempotent: a finding already posted, by this run or an earlier
      one, is never posted again. Pre-existing findings are withheld by default.

  prr post --retract <id>[,<id>...] [--dry-run] [--dir <run>]
      Append a correction to each posted finding's thread and close it. The
      finding must already be marked retracted via "prr note --file".

  prr post --update-summary --summary <path.md> [--dry-run] [--dir <run>]
      Append a corrected summary to the existing summary thread, so stale
      counts do not stand after a retraction or a later review round.

  prr post --resolve <thread-id>[,<id>...] [--resolution fixed|withdrawn]
           [--message <path.md>] [--dry-run] [--dir <run>]
      Reply to and resolve threads posted by earlier prr runs (listed in
      prior-findings.json). Never touches a human reviewer's thread.

  prr exec --record [--timeout <seconds>] [--dir <run>] -- <command> [args...]
      Run one explicit command without a shell and append its redacted, capped
      result to validations.jsonl. Returns the command's exit code.

  prr status [--dir <run>]
      Print the current state of the run.
`;
async function context(flags) {
  const store = await RunStore.open(str(flags.dir));
  const meta = await store.meta();
  const path = str(flags.path);
  if (!path) throw new Error("`prr context` requires --path.");
  const content = await showFile(meta.repoRoot, meta.sourceSHA, path);
  if (!content) throw new Error(`${path} does not exist at ${meta.sourceSHA.slice(0, 10)}.`);
  const lines = content.split("\n");
  const start = Math.max(1, num(flags.start) ?? 1);
  const requestedEnd = num(flags.end) ?? start + DEFAULT_CONTEXT_LINES - 1;
  const end = Math.min(lines.length, requestedEnd, start + MAX_CONTEXT_LINES - 1);
  const slice = lines.slice(start - 1, end).map((line, i) => `${String(start + i).padStart(5, " ")} ${line}`);
  const suffix = end < lines.length ? `
... ${lines.length - end} more line(s)` : "";
  return `${path} @ ${meta.sourceSHA.slice(0, 10)} lines ${start}-${end} of ${lines.length}
${slice.join("\n")}${suffix}`;
}
async function grep(positional, flags) {
  const store = await RunStore.open(str(flags.dir));
  const meta = await store.meta();
  const pattern = positional[0] ?? str(flags.pattern);
  if (!pattern) throw new Error("`prr grep` requires a pattern.");
  const pathspec = str(flags.path);
  const max = num(flags.max) ?? 100;
  const { matches, truncated } = await grepAtRev(meta.repoRoot, meta.sourceSHA, pattern, {
    regex: flags.regex === true,
    ...pathspec ? { pathspec: [pathspec] } : {},
    max
  });
  if (matches.length === 0) {
    return `no match for ${JSON.stringify(pattern)} at ${meta.sourceSHA.slice(0, 10)}`;
  }
  if (flags["files-only"] === true) {
    const files = [...new Set(matches.map((m) => m.path))];
    return `${files.length} file(s) match ${JSON.stringify(pattern)}
${files.join("\n")}`;
  }
  const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text.slice(0, 200)}`);
  const header = `${matches.length} match(es) for ${JSON.stringify(pattern)} at ${meta.sourceSHA.slice(0, 10)}`;
  return truncated ? `${header} (capped at ${max}; narrow with --path or --files-only)
${lines.join("\n")}` : `${header}
${lines.join("\n")}`;
}
async function rulesCheck(positional, flags) {
  if (positional[0] !== "check" || !positional[1]) {
    throw new Error("Usage: prr rules check <path>");
  }
  const path = positional[1].replace(/^\//, "");
  const root = await repoRoot(str(flags.repo) ?? process.cwd());
  const rev = str(flags.rev);
  const resolved = await loadRules(root, str(flags.rule), rev ? { rev } : {});
  const lines = [`${path} @ ${root}`];
  lines.push(
    resolved.sources.length > 0 ? `rule files: ${resolved.sources.join(", ")}` : "rule files: none (built-in rules only)"
  );
  if (isExcludedByRules(path, resolved)) {
    lines.push("excluded: yes \u2014 this path is skipped before review");
    return lines.join("\n");
  }
  const applicable = rulesForPath(path, resolved);
  const minSeverity = minSeverityForPath(path, resolved);
  if (minSeverity) lines.push(`reporting threshold: ${minSeverity} and above`);
  const risk = riskPathsFor(path, resolved);
  if (risk.length > 0) {
    lines.push(
      `risk signals: ${risk.map((entry) => `${entry.label ?? "project"} +${entry.weight} (${entry.path})`).join(", ")}`
    );
  }
  if (applicable.length === 0) {
    lines.push("rules: none \u2014 reviewed against reference/standards.md only");
  } else {
    lines.push("rules:");
    lines.push(...applicable.map((rule) => `  - ${rule}`));
  }
  return lines.join("\n");
}
async function status(flags) {
  const store = await RunStore.open(str(flags.dir));
  const meta = await store.meta();
  const files = await store.readFiles();
  const batches = await store.readBatches();
  const verdicts = await store.readVerdicts();
  const findings = await store.readFindings();
  const reviewable = files.filter((f) => f.decision === "review");
  const reviewablePaths = new Set(reviewable.map((f) => f.path));
  const done = new Set(verdicts.map((v) => v.path));
  const covered = [...reviewablePaths].filter((path) => done.has(path)).length;
  const pending = batches.filter((b) => !b.files.every((f) => done.has(f)));
  const lines = [
    meta.scope === "ado-pr" ? `PR ${meta.prId} \xB7 ${meta.title}` : `${meta.scope} \xB7 ${meta.title}`,
    `source ${meta.sourceSHA.slice(0, 10)} \xB7 run ${meta.runDir}`,
    `coverage ${covered}/${reviewable.length} \xB7 findings ${findings.length}`
  ];
  if (pending.length > 0) {
    lines.push(`pending batches: ${pending.map((b) => `b${String(b.id).padStart(2, "0")}`).join(", ")}`);
    lines.push(`next: read ${meta.runDir}/${pending[0].payload}`);
  } else {
    lines.push("all batches reviewed \xB7 next: prr finalize");
  }
  return lines.join("\n");
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case "prepare": {
      const target = positional[0] ?? str(flags.pr);
      const branch = str(flags.branch);
      const workingTree = flags["working-tree"] === true;
      console.log(
        await prepare({
          ...target ? { target } : {},
          ...branch ? { branch } : {},
          workingTree,
          repo: str(flags.repo),
          iteration: num(flags.iteration),
          since: num(flags.since),
          maxFiles: num(flags["max-files"]),
          maxTokens: num(flags["max-tokens"]),
          rule: str(flags.rule),
          reset: flags.reset === true,
          ...str(flags.depth) ? { depth: str(flags.depth) } : {}
        })
      );
      return 0;
    }
    case "note": {
      const batch = num(flags.batch);
      if (batch !== void 0 || flags["all-clean"] === true) {
        if (batch === void 0 || flags["all-clean"] !== true) {
          throw new Error("Batch recording requires both --batch <n> and --all-clean.");
        }
        console.log(
          await noteBatch({
            batch,
            allClean: true,
            exceptions: parseVerdictExceptions(str(flags.except)),
            dir: str(flags.dir)
          })
        );
        return 0;
      }
      const file = str(flags.file) ?? positional[0];
      if (!file) throw new Error("`prr note` requires --file <path.json>.");
      console.log(await note({ file, dir: str(flags.dir) }));
      return 0;
    }
    case "finalize": {
      const format = str(flags.format);
      if (format === "result") {
        const store = await RunStore.open(str(flags.dir));
        const saved = await store.readResult();
        if (!saved) throw new Error("No result.json yet. Run `prr finalize` first.");
        console.log(JSON.stringify(saved, null, 2));
        return saved.ok ? 0 : 1;
      }
      const result = await finalize({
        dir: str(flags.dir),
        render: flags.render === true || format !== void 0,
        ...format ? { format } : {}
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
    case "exec": {
      if (flags.record !== true) {
        throw new Error("`prr exec` requires --record; validation commands are never implicit.");
      }
      const result = await recordExec({
        command: positional,
        dir: str(flags.dir),
        timeoutSeconds: num(flags.timeout)
      });
      console.log(result.output);
      return result.exitCode;
    }
    case "post": {
      const severity = str(flags["min-severity"]);
      const retractFlag = flags.retract;
      const retract = typeof retractFlag === "string" ? retractFlag.split(",").map((id) => id.trim()).filter(Boolean) : void 0;
      const resolveFlag = flags.resolve;
      const resolve = typeof resolveFlag === "string" ? resolveFlag.split(",").map((id) => {
        const n = Number.parseInt(id.trim(), 10);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid --resolve thread id "${id}".`);
        return n;
      }) : void 0;
      const resolution = str(flags.resolution);
      console.log(
        await post({
          dir: str(flags.dir),
          minSeverity: severity,
          dryRun: flags["dry-run"] === true,
          summaryFile: str(flags.summary),
          ...retract && retract.length > 0 ? { retract } : {},
          updateSummary: flags["update-summary"] === true,
          includePreExisting: flags["include-pre-existing"] === true,
          ...resolve && resolve.length > 0 ? { resolve } : {},
          ...resolution ? { resolution } : {},
          ...str(flags.message) ? { messageFile: str(flags.message) } : {}
        })
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
main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(`prr: ${err.message}`);
  process.exitCode = 1;
});
