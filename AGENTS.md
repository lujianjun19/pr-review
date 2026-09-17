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

## Scope and privacy

Keep this repository public-safe and repository-agnostic. Do not add:

- private organization, project, repository, customer, or pull request names
- internal URLs or real PR numbers
- local absolute paths from a developer machine
- access tokens, credentials, certificate paths, or environment-specific secrets
- copied production source from a private repository

Use neutral fixtures such as `contoso`, `Operations Platform`, `portal-api`, and synthetic temporary
git repositories in tests. Before publishing, scan tracked files for private references and secrets.

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
6. Scan for private repository information and secrets.
7. Review `git diff --check` and the final changed-file list.
8. Report remaining risks honestly.

Do not commit, push, or publish PR comments unless the user explicitly requests that action.
