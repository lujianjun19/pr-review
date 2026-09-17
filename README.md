# pr-review

[简体中文](README.zh-CN.md)

An agent skill for reviewing Azure DevOps pull requests, branches and uncommitted work, backed by
`prr` — a deterministic toolkit that does the mechanical work so the model only does the judging.

The model never counts diff lines, never tracks which files it has read, and never hand-builds a REST
payload. Those are settled in code, once.

## Scopes

| Command | Compares |
|---|---|
| `prr prepare <pr-url\|id>` | The pull request's latest iteration against its merge base, from the Azure DevOps API |
| `prr prepare --branch <ref>` | The current branch against its merge base with `<ref>` |
| `prr prepare --working-tree` | Uncommitted and untracked work against HEAD |

Only the pull request scope can post comments; the others end at the report.

## What the toolkit does

| Step | Command | Guarantee |
|---|---|---|
| Pin and triage | `prr prepare` | Iteration SHAs come from the Azure DevOps API, not from branch names. Every changed file gets a decision and a reason. |
| Batch | (part of `prepare`) | Risk-ordered batches; an implementation and its tests land together; hard file and token caps. |
| Read | `payload/bNN.md` | Every diff line is labelled with its real line number in the source revision. |
| Look further | `prr context`, `prr grep` | Reads and searches the reviewed revision, which works even when the repository has no checkout. Both are capped. |
| Verify | `prr finalize` | A finding whose evidence is not in the source revision is rejected. Lines are resolved from the evidence. Coverage is enforced. |
| Publish | `prr post` | Idempotent by fingerprint, anchored with `changeTrackingId` so comments survive a new push. |

## Requirements

- Node 18 or later, and git.
- A credential: `AZURE_DEVOPS_EXT_PAT` in the environment, otherwise `az login`.
- Run from inside a clone of the repository under review. Only the two pinned commits are fetched;
  your working tree is never touched.

## Install

Copy or symlink this directory into any skills location:

| Scope | Path |
|---|---|
| Project | `.github/skills/pr-review/` (also `.claude/skills/`, `.agents/skills/`) |
| Personal | `~/.copilot/skills/pr-review/` (also `~/.agents/skills/`, `~/.pi/agent/skills/`) |

```bash
ln -s "$PWD" ~/.copilot/skills/pr-review
```

`bin/prr.mjs` is committed and dependency-free, so there is no install step for users.

### VS Code: avoid approving every command

```jsonc
"chat.tools.terminal.enableAutoApprove": true,
"chat.tools.terminal.autoApprove": {
  "/\\bprr\\.mjs\\b/": true
}
```

## Usage

```bash
node bin/prr.mjs prepare https://dev.azure.com/org/project/_git/repo/pullrequest/123
node bin/prr.mjs prepare 123 --since 4      # only what changed since iteration 4
node bin/prr.mjs prepare --branch main
node bin/prr.mjs prepare --working-tree
node bin/prr.mjs grep createOrder --files-only
node bin/prr.mjs context --path src/pay/charge.ts --start 40
node bin/prr.mjs rules check src/pay/charge.ts
node bin/prr.mjs note --file findings.json
node bin/prr.mjs finalize
node bin/prr.mjs finalize --format sarif > findings.sarif
node bin/prr.mjs post --dry-run
```

Run state lives in `~/.cache/pr-review/<key>/`, never inside the repository. Commands after
`prepare` prefer the run belonging to the repository you are standing in.

## Project rules

Per-path constraints on top of `reference/standards.md`, resolved from `--rule <path>`, then
`<repo>/.pr-review/rules.json`, then `~/.config/pr-review/rules.json`, then built-ins. The first
matching glob wins; `mergeBuiltin` keeps the built-in as well.

```json
{
  "rules": [
    { "path": "src/payments/**", "rule": "Money is handled in minor units; no float arithmetic." },
    { "path": "**/migrations/**", "rule": "Every migration needs a down script.", "mergeBuiltin": true }
  ],
  "exclude": ["**/__fixtures__/**"]
}
```

Check what applies to a file with `prr rules check <path>`.

## Development

```bash
npm install
npm test          # unit tests plus the evaluation harness
npm run typecheck
npm run build     # regenerates bin/prr.mjs — commit the result
```

`bin/prr.mjs` is a build artifact that must stay in sync with `src/`.

### What the evaluation harness measures

`src/eval/harness.test.ts` builds a real git repository with a known change set and runs the
deterministic layer over it end to end: selection decisions, batch coverage and caps, implementation
and test co-location, line-number annotation against the actual revision, and evidence verification
(true evidence resolves, fabricated evidence is rejected, misfiled evidence is re-filed). The
working-tree scope is covered too, including untracked files.

It does **not** measure how many real defects a review finds. That depends on the model, and a
fixture cannot stand in for it.

## Design

`docs/improvement-plan.md` records why each piece is code rather than prose, and what was
deliberately left to the model.

## Repository guidance

- `AGENTS.md` — instructions for coding agents and public-safe repository hygiene
- `CONTRIBUTING.md` — development, testing, and contribution workflow
- `reference/standards.md` — semantic review standards used by the skill

This repository is intended to be distributable. Keep examples synthetic: do not commit private
organization names, real repository or pull request URLs, production source, local absolute paths,
credentials, or customer data.
