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
    const cred = await getCredential();
    const url = `${this.base()}${path}${path.includes("?") ? "&" : "?"}api-version=${API_VERSION}`;
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
  /** Creates a comment thread. The body is sent as JSON, so emoji survive intact. */
  createThread(prId, body) {
    return this.request(`/pullRequests/${prId}/threads`, {
      method: "POST",
      body: JSON.stringify(body)
    });
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
async function loadRuleFile(path) {
  if (!existsSync(path)) return void 0;
  try {
    return JSON.parse(await readFile2(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}
async function loadRules(repoRoot2, explicitPath) {
  const layers = [];
  if (explicitPath) {
    const file = await loadRuleFile(explicitPath);
    if (!file) throw new Error(`Rule file not found: ${explicitPath}`);
    layers.push({ path: explicitPath, file });
  }
  const projectPath = join2(repoRoot2, ".pr-review", "rules.json");
  layers.push({ path: projectPath, file: await loadRuleFile(projectPath) });
  const userPath = globalRulePath();
  layers.push({ path: userPath, file: await loadRuleFile(userPath) });
  const entries = [];
  const exclude = [];
  const sources = [];
  for (const layer of layers) {
    if (!layer.file) continue;
    sources.push(layer.path);
    entries.push(...layer.file.rules ?? []);
    exclude.push(...layer.file.exclude ?? []);
  }
  return { entries, exclude, sources };
}
function rulesForPath(path, resolved) {
  const userRule = resolved.entries.find((entry) => matchesGlob(path, entry.path));
  const builtin = BUILTIN_RULES.find((entry) => matchesGlob(path, entry.path));
  if (!userRule) return builtin ? [builtin.rule] : [];
  if (userRule.mergeBuiltin && builtin) return [userRule.rule, builtin.rule];
  return [userRule.rule];
}
function isExcludedByRules(path, resolved) {
  return matchesAny(path, resolved.exclude);
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
  { pattern: /payment|billing|invoice|price|currency|tax|emission|fuel|calculat|solver/i, weight: 3, label: "domain-math" },
  { pattern: /concurren|thread|lock|queue|worker|scheduler|retry|timeout/i, weight: 3, label: "concurrency" },
  { pattern: /cache|session|state|store|repository|persist/i, weight: 2, label: "state" }
];
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
function riskScore(change, category) {
  let score = BASE_RISK[category];
  for (const signal of RISK_SIGNALS) {
    if (signal.pattern.test(change.path)) score += signal.weight;
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
      risk: riskScore(change, category),
      tokens,
      changeTrackingId: trackingIds.get(change.path),
      ...rules.length > 0 ? { rules } : {}
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

// src/core/payload.ts
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
function threadSummary(threads, path) {
  const relevant = threads.filter((t) => t.path === path && !t.isDeleted && t.comments.length > 0);
  if (relevant.length === 0) return "";
  const lines = relevant.map((t) => {
    const first = t.comments[0];
    const body = first.body.replace(/\s+/g, " ").slice(0, 220);
    const who = t.isBot ? `${first.author} (bot)` : first.author;
    return `- thread ${t.id} [${t.status}] line ${t.line ?? "?"} \u2014 ${who}: ${body}`;
  });
  return `
Existing threads on this file (do not repeat these findings):
${lines.join("\n")}
`;
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
  parts.push("");
  parts.push(
    "Line numbers on the left are real line numbers in the source revision. Report them as-is; lines marked `-|` were removed and cannot be commented on."
  );
  parts.push("");
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
    const threadNote = threadSummary(ctx.threads, path);
    if (threadNote) parts.push(threadNote.trimEnd());
    parts.push("```diff");
    parts.push(annotateDiff(raw));
    parts.push("```");
    parts.push("</file>");
    parts.push("");
  }
  return parts.join("\n");
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
  const local = here ? candidates.filter((c) => c.repoRoot === here) : [];
  const pool = local.length > 0 ? local : candidates;
  pool.sort((a, b) => b.at - a.at);
  return pool[0].dir;
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

// src/version.ts
var TOOL_VERSION = "0.1.0";

// src/commands/prepare.ts
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
  const [threads, changeEntries] = await Promise.all([
    client.listThreads(target.prId),
    client.listIterationChanges(target.prId, iteration.id, args.since)
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
      }))
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
  return {
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
  const scope = isLocal ? await prepareLocalScope(args, root) : await prepareAdoScope(args, root);
  const rules = await loadRules(root, args.rule);
  let changes = await listChanges(root, scope.meta.baseSHA, scope.meta.sourceSHA);
  if (args.since !== void 0 && scope.iterationPaths) {
    changes = changes.filter((c) => scope.iterationPaths.has(c.path));
  }
  const files = triage(changes, scope.trackingIds, { maxFileTokens: 6e4, rules });
  const batches = buildBatches(files, {
    maxFiles: args.maxFiles ?? 10,
    maxTokens: args.maxTokens ?? 25e3,
    planFileLines: 50,
    planGroupLines: 100
  });
  const runDir = runDirFor(scope.meta);
  const meta = {
    ...scope.meta,
    runDir,
    ...rules.sources.length > 0 ? { ruleSources: rules.sources } : {}
  };
  const store = await RunStore.create(meta);
  const carried = await store.carriedProgress();
  if (args.reset) await store.resetProgress();
  if (scope.pullRequest) await store.writePullRequest(scope.pullRequest);
  await store.writeThreads(scope.threads);
  await store.writeFiles(files);
  await store.writeBatches(batches);
  const fileMap = new Map(files.map((f) => [f.path, f]));
  for (const batch of batches) {
    const content = await renderPayload(batch, {
      repoRoot: root,
      baseSHA: meta.baseSHA,
      sourceSHA: meta.sourceSHA,
      files: fileMap,
      threads: scope.threads
    });
    await store.writePayload(batch.payload, content);
  }
  return formatSummary(
    meta,
    files,
    batches,
    scope.threads.length,
    scope.credentialSource,
    args.reset ? 0 : carried,
    rules.sources
  );
}
function formatSummary(meta, files, batches, threadCount, credSource, carried, ruleSources) {
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
import { createHash } from "node:crypto";
var SEVERITIES = ["critical", "high", "medium", "low"];
var VERDICTS = ["clean", "findings", "cross-batch"];
function fail(message) {
  throw new Error(message);
}
function fingerprint(path, evidence, problem) {
  const normalized = `${path}|${evidence.replace(/\s+/g, " ").trim()}|${problem.replace(/\s+/g, " ").trim().slice(0, 120)}`;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
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
  if (!SEVERITIES.includes(severity)) {
    fail(`${where}: "severity" must be one of ${SEVERITIES.join(", ")}.`);
  }
  for (const field of ["problem", "evidence", "fix"]) {
    if (!raw[field] || !String(raw[field]).trim()) {
      fail(`${where}: "${field}" is required and must be non-empty.`);
    }
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
    status: "candidate",
    batch: raw.batch,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
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
  const retractIds = input.retract ?? [];
  let retracted = 0;
  if (retractIds.length > 0) {
    const all = [...existing, ...fresh];
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
  const bySeverity = /* @__PURE__ */ new Map();
  for (const f of fresh) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
  const lines = [
    `recorded ${verdicts.length} verdict(s), ${fresh.length} finding(s)` + (duplicates > 0 ? ` (${duplicates} already recorded, ignored)` : "") + (retracted > 0 ? `, ${retracted} finding(s) retracted` : "")
  ];
  if (fresh.length > 0) {
    lines.push(`  severities: ${[...bySeverity].map(([s, n]) => `${s} x${n}`).join(", ")}`);
  }
  const done = new Set((await store.readVerdicts()).map((v) => v.path));
  lines.push(`coverage: ${done.size}/${reviewable.size} reviewable files have a verdict`);
  return lines.join("\n");
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
    level: SARIF_LEVEL[finding.severity],
    message: { text: `${finding.problem}

Fix: ${finding.fix}` },
    properties: {
      severity: finding.severity,
      "security-severity": SEVERITY_SCORE[finding.severity],
      fingerprint: finding.id
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
var SEVERITY_ORDER = ["critical", "high", "medium", "low"];
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
  const reviewable = files.filter((f) => f.decision === "review");
  const reviewablePaths = reviewable.map((f) => f.path);
  const verified = [];
  const notes = [];
  for (const finding of findings) {
    if (finding.status === "duplicate" || finding.status === "retracted") {
      verified.push(finding);
      continue;
    }
    const result = await resolveEvidence(
      meta.repoRoot,
      meta.sourceSHA,
      finding.path,
      finding.evidence,
      reviewablePaths
    );
    const updated = { ...finding };
    switch (result.outcome) {
      case "resolved":
        updated.status = "verified";
        updated.line = result.location.startLine;
        updated.endLine = result.location.endLine;
        break;
      case "relocated":
        updated.status = "verified";
        updated.path = result.relocatedTo;
        updated.line = result.location.startLine;
        updated.endLine = result.location.endLine;
        notes.push(
          `  ${finding.id}: evidence lives in ${result.relocatedTo}, finding re-filed there`
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
          `  ${finding.id} (${finding.path}): evidence is absent here but present in ${result.candidates.length} other changed files (${result.candidates.slice(0, 2).join(", ")}); name the right file or quote a longer span`
        );
        break;
      default:
        updated.status = "unverified";
        notes.push(
          `  ${finding.id} (${finding.path}): evidence not found at ${meta.sourceSHA.slice(0, 10)}; move to Open Questions or quote the code exactly`
        );
    }
    verified.push(updated);
  }
  await store.replaceFindings(verified);
  const lastVerdict = /* @__PURE__ */ new Map();
  for (const v of verdicts) lastVerdict.set(v.path, v.verdict);
  const missing = reviewablePaths.filter((p) => !lastVerdict.has(p));
  const crossBatch = [...lastVerdict].filter(([, v]) => v === "cross-batch").map(([p]) => p);
  const publishable = verified.filter((f) => f.status === "verified");
  const blocked = verified.filter(
    (f) => f.status !== "verified" && f.status !== "duplicate" && f.status !== "retracted"
  );
  if (args.render) {
    if (args.format === "sarif") return { output: renderSarif(verified, meta), ok: true };
    if (args.format === "json") return { output: renderJson(verified, meta), ok: true };
    return { output: renderFindings(publishable, threads), ok: true };
  }
  const lines = [];
  lines.push(
    meta.scope === "ado-pr" ? `PR ${meta.prId} \xB7 iteration ${meta.iterationId} \xB7 ${meta.sourceSHA.slice(0, 10)}` : `${meta.scope} \xB7 ${meta.title} \xB7 ${meta.sourceSHA.slice(0, 10)}`
  );
  lines.push(
    `findings: ${publishable.length} verified, ${blocked.length} not publishable, ${verified.filter((f) => f.status === "duplicate").length} marked duplicate, ${verified.filter((f) => f.status === "retracted").length} retracted`
  );
  lines.push(`coverage: ${lastVerdict.size}/${reviewablePaths.length} reviewable files`);
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
  lines.push(
    ok ? "OK: coverage complete. Render the report, then ask before posting." : "Resolve the blockers above before producing a verdict."
  );
  return { output: lines.join("\n"), ok };
}
function renderFindings(findings, threads) {
  if (findings.length === 0) {
    return "No verified findings. State this explicitly and describe any validation gaps.";
  }
  const ordered = findings.slice().sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.path.localeCompare(b.path)
  );
  const blocks = ordered.map((f) => {
    const lines = [];
    lines.push(`${SEVERITY_LABEL[f.severity]} \u2014 \`${f.path}\` (line ${f.line ?? "?"})`);
    lines.push(`Problem: ${f.problem}`);
    lines.push("Evidence:");
    lines.push("```");
    lines.push(f.evidence.trimEnd());
    lines.push("```");
    lines.push(`Fix: ${f.fix}`);
    if (f.fixedCode) {
      lines.push("Fixed code:");
      lines.push("```");
      lines.push(f.fixedCode.trimEnd());
      lines.push("```");
    }
    return lines.join("\n");
  });
  const covered = threads.filter((t) => !t.isBot && !t.isDeleted && t.path).length;
  const footer = covered > 0 ? `
_${covered} existing inline thread(s) were reconciled; duplicates are omitted above._` : "";
  return `${blocks.join("\n\n")}
${footer}`;
}

// src/commands/post.ts
import { readFile as readFile5, writeFile as writeFile2 } from "node:fs/promises";
import { existsSync as existsSync3 } from "node:fs";
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
  const parts = [
    `${SEVERITY_LABEL2[finding.severity]} \u2014 ${finding.problem}`,
    "",
    "**Evidence**",
    "```",
    finding.evidence.trimEnd(),
    "```",
    `**Fix** ${finding.fix}`
  ];
  if (finding.fixedCode) {
    parts.push("", "**Suggested code**", "```", finding.fixedCode.trimEnd(), "```");
  }
  return parts.join("\n");
}
async function post(args) {
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
  const locatable = findings.filter(
    (f) => f.status === "verified" && typeof f.line === "number"
  );
  const notPublishable = findings.length - locatable.length;
  const eligible = locatable.filter((f) => SEVERITY_RANK[f.severity] <= threshold);
  const belowThreshold = locatable.length - eligible.length;
  const pending = eligible.filter((f) => ledger[f.id] === void 0);
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  if (args.dryRun) {
    const lines2 = [
      `dry run: ${pending.length} thread(s) would be posted to PR ${prId} (${eligible.length - pending.length} already posted, ${belowThreshold} below --min-severity, ${notPublishable} not publishable)`
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
    await writeFile2(ledgerPath, `${JSON.stringify(ledger, null, 2)}
`, "utf8");
  }
  let summaryLine = "";
  if (args.summaryFile) {
    const content = await readFile5(args.summaryFile, "utf8");
    const key = "__summary__";
    if (ledger[key] !== void 0) {
      summaryLine = `summary comment already posted as thread ${ledger[key]}`;
    } else {
      const thread = await client.createThread(prId, {
        comments: [{ content, commentType: 1 }],
        status: 1
      });
      ledger[key] = thread.id;
      await writeFile2(ledgerPath, `${JSON.stringify(ledger, null, 2)}
`, "utf8");
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
  if (notPublishable > 0) {
    lines.push(`${notPublishable} finding(s) were not publishable (unverified or unlocated).`);
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

// src/cli.ts
var DEFAULT_CONTEXT_LINES = 120;
var MAX_CONTEXT_LINES = 500;
function parseArgs(argv) {
  const positional = [];
  const flags = {};
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
function num(value) {
  if (typeof value !== "string") return void 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function str(value) {
  return typeof value === "string" ? value : void 0;
}
var USAGE = `prr ${TOOL_VERSION} \u2014 deterministic toolkit for Azure DevOps pull request review

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
  const resolved = await loadRules(root, str(flags.rule));
  const lines = [`${path} @ ${root}`];
  lines.push(
    resolved.sources.length > 0 ? `rule files: ${resolved.sources.join(", ")}` : "rule files: none (built-in rules only)"
  );
  if (isExcludedByRules(path, resolved)) {
    lines.push("excluded: yes \u2014 this path is skipped before review");
    return lines.join("\n");
  }
  const applicable = rulesForPath(path, resolved);
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
  const done = new Set(verdicts.map((v) => v.path));
  const pending = batches.filter((b) => !b.files.every((f) => done.has(f)));
  const lines = [
    meta.scope === "ado-pr" ? `PR ${meta.prId} \xB7 ${meta.title}` : `${meta.scope} \xB7 ${meta.title}`,
    `source ${meta.sourceSHA.slice(0, 10)} \xB7 run ${meta.runDir}`,
    `coverage ${done.size}/${reviewable.length} \xB7 findings ${findings.length}`
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
          reset: flags.reset === true
        })
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
      const format = str(flags.format);
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
    case "post": {
      const severity = str(flags["min-severity"]);
      console.log(
        await post({
          dir: str(flags.dir),
          minSeverity: severity,
          dryRun: flags["dry-run"] === true,
          summaryFile: str(flags.summary)
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
