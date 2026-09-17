# Contributing

Thank you for improving `pr-review`.

## Before you start

Read:

- `AGENTS.md` for repository-wide engineering and privacy rules
- `SKILL.md` for the runtime contract
- `docs/improvement-plan.md` for architectural context
- `reference/standards.md` for review judgement guidance

## Development setup

Requirements:

- Node.js 18+
- npm
- Git

Install development dependencies and run the checks:

```bash
npm install
npm test
npm run typecheck
npm run build
```

The project deliberately has no runtime dependency. Development dependencies are used for bundling
and type checking; the committed `bin/prr.mjs` is what users execute.

## Change guidelines

- Keep semantic review decisions in the host Agent, not in `src/`.
- Keep Azure DevOps-specific transport code in `src/ado/`.
- Add tests for URL parsing, git behavior, triage, batching, evidence resolution, state transitions,
  posting gates, and output formats as applicable.
- Keep source comments in English.
- Do not place private organization names, real repositories, real pull request URLs, customer data,
  local paths, or credentials in source, tests, fixtures, or documentation.
- Use synthetic fixture names and temporary repositories for integration tests.
- Preserve read-only behavior unless a write operation has an explicit CLI gate and tests.

## Generated artifact

After any TypeScript source change:

```bash
npm run build
diff -q bin/prr.mjs /tmp/prr-check.mjs
```

The generated bundle must be committed with its source change.

## Pull requests

A contribution should explain:

- the user-visible or agent-visible behavior change
- the deterministic invariant being enforced
- the tests and checks run
- any portability, authentication, or API-version assumptions
- any deliberately deferred behavior

Keep pull requests focused. Do not mix private environment examples into public documentation.
