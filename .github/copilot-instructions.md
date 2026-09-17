# Repository instructions for GitHub Copilot

Read `AGENTS.md` before editing, testing, or reviewing this repository.

Use the closest supporting document for the task:

- `SKILL.md` for the runtime Agent Skill workflow
- `reference/standards.md` for semantic review standards
- `docs/improvement-plan.md` for architecture and implementation history
- `README.md` or `README.zh-CN.md` for public usage
- `CONTRIBUTING.md` for contribution and validation rules

Keep changes public-safe and repository-agnostic. Do not add private organization names, real pull
request URLs, production source, local absolute paths, credentials, or tokens. Use synthetic fixtures.

When changing `src/`, run `npm test`, `npm run typecheck`, and `npm run build`. Keep `bin/prr.mjs`
in sync with the TypeScript source. Source-code comments must be in English.
