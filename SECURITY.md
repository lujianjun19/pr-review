# Security Policy

## Scope

This project handles Azure DevOps metadata and can publish review comments when explicitly authorized.
It should be treated as security-sensitive tooling even though it does not contain application secrets.

## Safe usage

- Prefer `AZURE_DEVOPS_EXT_PAT` or an authenticated Azure CLI session; never put tokens in files,
  command arguments, fixtures, logs, or pull request comments.
- Review the target and scope before running a write command.
- Keep run state in the user cache directory and protect it with normal user filesystem permissions.
- Use `--dry-run` before publishing comments.
- Treat SARIF and JSON output as potentially containing source-code excerpts.

## Reporting a vulnerability

Do not open a public issue containing credentials, private source, exploitable details, or a live
Azure DevOps URL. Contact the repository maintainers through the private security channel configured
for the hosting service. Include a minimal reproduction, affected version, impact, and a suggested
mitigation when safe to do so.
