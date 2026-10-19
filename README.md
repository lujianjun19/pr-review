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
| Pin and triage | `prr prepare` | Iteration SHAs come from the Azure DevOps API, not from branch names. Every changed file gets a decision and a reason; PR policies/statuses are captured when available. |
| Context | (part of `prepare`) | `intent.md` (title, description, linked work items; commit messages for a branch), `guidance.md` (`AGENTS.md`, `CLAUDE.md`, `REVIEW.md`, Copilot instruction files governing the changed paths) and a suggested risk tier (0/1/2 human approvers). Rules and guidance are read from the **base** revision, so a change cannot rewrite its own review. |
| Re-review | (part of `prepare`) | Threads posted by earlier runs are recognized (`prior-findings.json`) with their replies and whether their quoted evidence still exists. |
| Batch | (part of `prepare`) | Risk-ordered batches; an implementation and its tests land together; duplicate multi-target generated outputs collapse to one representative; hard file and token caps. |
| Read | `payload/bNN.md` | Every diff line is labelled with its real line number in the source revision. |
| Look further | `prr context`, `prr grep` | Reads and searches the reviewed revision, which works even when the repository has no checkout. Both are capped. |
| Challenge | `prr note` (`challenges`) | Blocking findings must survive an independent attempt to refute them; refuted ones are retracted, uncertain ones become Open Questions. |
| Verify | `prr finalize` | A finding whose evidence is not in the source revision is rejected. Lines are resolved from the evidence. Path thresholds and caps are applied. Coverage and challenges are enforced. `result.json` holds counts and a suggested verdict. |
| Publish | `prr post` | Idempotent by fingerprint — also across iterations — and anchored with `changeTrackingId` so comments survive a new push. Pre-existing defects are withheld unless asked for. `--resolve` closes earlier prr threads only. |

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
node bin/prr.mjs prepare 123 --depth deep   # quick | standard (default) | deep
node bin/prr.mjs prepare --branch main
node bin/prr.mjs prepare --working-tree
node bin/prr.mjs grep createOrder --files-only
node bin/prr.mjs context --path src/api/pagination.ts --start 40
node bin/prr.mjs rules check src/api/pagination.ts
node bin/prr.mjs note --file findings.json
node bin/prr.mjs note --batch 2 --all-clean --except src/app.ts=findings
node bin/prr.mjs exec --record --timeout 300 -- npm test
node bin/prr.mjs finalize
node bin/prr.mjs finalize --format sarif > findings.sarif
node bin/prr.mjs finalize --format result   # result.json: counts and suggested verdict
node bin/prr.mjs post --dry-run
node bin/prr.mjs post --resolve 1234 --resolution fixed --dry-run
node bin/prr.mjs post --retract <finding-id> --dry-run
node bin/prr.mjs post --update-summary --summary corrected.md --dry-run
```

Run state lives in `~/.cache/pr-review/<key>/`, never inside the repository. Commands after
`prepare` require a run belonging to the current repository; use `--dir` explicitly outside it.
Optional Azure DevOps evidence is stored in `policies.json` and `builds.json`; recorded validation
commands are stored in `validations.jsonl`.

## Project rules

Per-path constraints on top of `reference/standards.md`, resolved from `--rule <path>`, then
`<repo>/.pr-review/rules.json`, then `~/.config/pr-review/rules.json`, then built-ins. The first
matching glob wins; `mergeBuiltin` keeps the built-in as well.

```json
{
  "rules": [
    { "path": "src/api/**", "rule": "Every endpoint validates its input at the boundary." },
    { "path": "**/migrations/**", "rule": "Every migration needs a down script.", "mergeBuiltin": true }
  ],
  "exclude": ["**/__fixtures__/**"]
}
```

Optional keys: `minSeverity` on a rule suppresses lower findings on matching paths (a rule may set
only a threshold); `maxLowFindings` caps how many Low findings one review publishes; `alwaysHuman`
lists paths that always lift the risk tier to at least one human approver; `riskPaths` raises the
review priority of areas the project considers critical. The toolkit is business-agnostic: built-in
risk signals cover technical categories only (security, contracts, concurrency, state), and any
business-specific priority is declared by the reviewed project in its own rules file. Entries sharing
a label count once; globs are case-sensitive.

```json
{
  "rules": [{ "path": "scripts/**", "minSeverity": "high" }],
  "maxLowFindings": 5,
  "alwaysHuman": ["infra/**", "**/auth/**"],
  "riskPaths": [
    { "path": "src/core/**", "weight": 3, "label": "core-logic" }
  ]
}
```

During a review the project file is read from the base revision; a change to it takes effect once
merged, and `prepare` warns when the change under review edits it. Check what applies to a file with
`prr rules check <path>` (`--rev <ref>` to read a revision).

## Review depth

| Depth | Batches | Plan first | Challenge required for | Low findings |
|---|---|---|---|---|
| `quick` | large | very large changes only | nothing | suppressed |
| `standard` | default | ≥ 50 changed lines | Critical, High, Medium | reported |
| `deep` | small | always | every finding | reported |

## Findings, challenges and pre-existing defects

A finding may carry `rationale` (why it was flagged) and `preExisting: true` (the change did not
introduce it). Independent challenges, duplicates and severity corrections are recorded by id:

```json
{
  "challenges": [{ "id": "<id>", "outcome": "confirmed", "detail": "what was checked", "by": "subagent" }],
  "duplicates": [{ "id": "<id>", "thread": 1234 }],
  "reclassify": [{ "id": "<id>", "severity": "medium" }]
}
```

Pre-existing findings are reported in their own section, never affect the verdict, and are posted
only with `--include-pre-existing`. Every posted comment ends with a `prr finding <id>` line, which is
how a later run recognizes its own threads; a posted summary ends with a generated `prr result:` line.

## Corrections and retractions

Evidence verification proves that quoted code exists; it cannot prove that a reviewer's claim about
it is correct. When a finding is wrong:

1. Mark it terminal in local state with `prr note --file retract.json`, where the JSON is
   `{ "retract": ["finding-id"] }`.
2. With explicit approval, run `prr post --retract <finding-id>` to append a correction and close the
   posted thread.
3. Re-render the summary and run `prr post --update-summary --summary corrected.md` so its counts and
   verdict no longer remain stale.

Claims about a dependency API require a finding-level `verification` object whose method is
`runtime`, `test-run`, or `declaration`. `prr note` rejects dependency-surface claims without it.

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
organization names, real repository or pull request URLs, production source, names of real people,
local absolute paths, credentials, or customer data.

Before every commit, run `npm run check:public`. With `git config core.hooksPath .githooks`, the
pre-commit hook scans the staged content automatically. Private names to block live in
`~/.config/pr-review/private-terms.txt`, never in the repository (see `CONTRIBUTING.md`).
