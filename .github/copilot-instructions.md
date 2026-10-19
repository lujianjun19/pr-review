# Repository instructions for GitHub Copilot

Read `AGENTS.md` before editing, testing, or reviewing this repository.

Use the closest supporting document for the task:

- `SKILL.md` for the runtime Agent Skill workflow
- `reference/standards.md` for semantic review standards
- `docs/improvement-plan.md` for architecture and implementation history
- `README.md` or `README.zh-CN.md` for public usage
- `CONTRIBUTING.md` for contribution and validation rules

Keep the skill business-agnostic: no business, product or industry vocabulary in heuristics, rules,
standards, examples or fixtures; project-specific priorities belong in the reviewed repository's
`.pr-review/rules.json`. Keep changes public-safe and repository-agnostic. Do not add private organization names, real pull
request URLs, production source, names of real people, local absolute paths, credentials, or tokens.
Use synthetic fixtures. Before every commit, run `npm run check:public` and fix every problem; the
`.githooks/pre-commit` hook enforces it on staged content. Never commit the private terms file.

When changing `src/`, run `npm test`, `npm run typecheck`, and `npm run build`. Keep `bin/prr.mjs`
in sync with the TypeScript source. Source-code comments must be in English.
