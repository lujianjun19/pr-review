# Repository Agent Guide

## Purpose

This repository contains a portable Agent Skill and its deterministic Azure DevOps PR review toolkit.
Preserve the separation between:

- `SKILL.md`: instructions consumed by an Agent host
- `src/`: typed implementation and tests
- `bin/prr.mjs`: committed, dependency-free distribution artifact
- `reference/`: review standards and supporting guidance
- `docs/`: architecture and implementation history

The toolkit performs mechanical work. It must not make semantic review decisions or call a model.
The host Agent supplies semantic judgement.

## Business-agnostic

The skill reviews any codebase. Code, defaults, built-in rules, risk signals, review standards and
documentation must not encode a specific business, product or industry:

- no business vocabulary in heuristics (risk signals, triage, batching, rules, severity)
- no business rules in `reference/standards.md` or `SKILL.md`; only engineering dimensions that
  apply to any codebase
- examples and fixtures use neutral technical scenarios (pagination, caching, parsing, APIs)
- business-specific priorities and rules belong to the reviewed repository's
  `.pr-review/rules.json` (`rules`, `riskPaths`, `minSeverity`, `alwaysHuman`), never to this
  repository

When a real review suggests a business-specific improvement, generalize it into a configurable,
domain-neutral mechanism, or leave it to the project's rules file.

## Scope and privacy

Keep this repository public-safe and repository-agnostic. Do not add:

- private organization, project, repository, customer, or pull request names
- internal URLs or real PR numbers, work item numbers, tenant or subscription ids
- names of real people (authors, reviewers, colleagues) or personal account names
- product or domain vocabulary that identifies an employer or customer
- local absolute paths from a developer machine
- access tokens, credentials, certificate paths, or environment-specific secrets
- copied production source from a private repository, or text taken from a real review
  (pull request titles, descriptions, comments, findings)

Use neutral fixtures such as `contoso`, `Operations Platform`, `portal-api`, and synthetic temporary
git repositories in tests.

### Mandatory check before every commit

Run the public-safety scan and fix every problem before committing — including commits made by an
agent on the user's request:

```bash
npm run check:public          # working tree: tracked and untracked files
npm run precommit:check       # exactly what will be committed (staged content)
```

`scripts/check-public-safety.mjs` checks built-in patterns (tokens, private keys, connection
secrets, personal paths, real email addresses, non-synthetic Azure DevOps organizations, GUIDs) and
the private terms in `~/.config/pr-review/private-terms.txt` (or `$PR_REVIEW_PRIVATE_TERMS`).
That file holds organization, project, customer and person names and **must never be committed or
quoted in this repository**; when a review session reveals a new private name, add it there.

The `.githooks/pre-commit` hook runs the staged check automatically once enabled with
`git config core.hooksPath .githooks`. Never bypass it with `--no-verify`. A line that must keep a
matching synthetic value (a test fixture) may carry a `public-safety: allow` comment; never use the
marker for real data. Also check that `git config user.email` is the address intended for public
history.

## Source of truth

- TypeScript source in `src/` is authoritative.
- `bin/prr.mjs` is generated from `src/cli.ts`; rebuild it after source changes.
- `SKILL.md` is the runtime workflow contract. Keep its commands aligned with the CLI help output.
- `README.md` and `README.zh-CN.md` describe the public installation and usage contract.
- `reference/standards.md` contains review judgement guidance; do not duplicate it unnecessarily in
  the skill instructions.

## Implementation rules

- Use TypeScript with explicit interfaces for public boundaries and runtime validation for JSON input.
- Keep runtime dependencies at zero. Use Node built-ins and the committed bundle.
- Keep deterministic code pure where practical: triage, glob matching, batching, line resolution,
  evidence verification, and SARIF rendering should be easy to test without a network.
- Keep Azure DevOps REST details inside `src/ado/`.
- Keep host/model integration out of the toolkit. Do not add pi SDK, Copilot SDK, or another model
  runtime unless the project scope is explicitly changed.
- Preserve read-only defaults. Posting, resolving, voting, pushing, and editing require explicit
  user approval.
- Use English comments in source code. User-facing documentation may be English or Chinese.
- Do not use shell interpolation for JSON or comments. Prefer file-based JSON and native `fetch`.
- Handle `git diff --no-index` exit code 1 as “files differ”, not as a command failure.
- Treat `retracted` findings as terminal. Verification must not resurrect a retracted finding.
- Treat `duplicate` as terminal too. `suppressed` and `unconfirmed` are recomputed by every finalize.
- Read review configuration (rules, guidance files) from the base revision in every review scope,
  never from the change under review.
- Write paths that close or resolve threads must only touch threads prr itself posted (recognized by
  the `prr finding <id>` footer) or recorded in the run's ledger.
- Do not rely on HTML in Azure DevOps comments; collapsible sections and hidden comments are not
  documented for pull requests.

## Validation

Run from the repository root:

```bash
npm test
npm run typecheck
npm run build
```

After building, verify that the generated bundle is reproducible:

```bash
npx esbuild src/cli.ts --bundle --platform=node --target=node18 --format=esm \
  --outfile=/tmp/prr-check.mjs --banner:js='#!/usr/bin/env node'
diff -q bin/prr.mjs /tmp/prr-check.mjs
```

When changing review scope, rules, git handling, URL parsing, evidence verification, posting, or
state management, add or update a focused test. When changing public workflow, update both READMEs
and `SKILL.md`.

## Change checklist

1. Read the relevant source, tests, and documentation before editing.
2. Make the smallest coherent change.
3. Add a regression test for every bug fix.
4. Run the full test and typecheck commands.
5. Rebuild and verify `bin/prr.mjs`.
6. Run `npm run check:public` (and `npm run precommit:check` after staging); fix every problem.
7. Review `git diff --check` and the final changed-file list.
8. Report remaining risks honestly.

Do not commit, push, or publish PR comments unless the user explicitly requests that action.
