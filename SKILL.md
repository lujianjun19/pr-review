---
name: pr-review
description: 'Review an Azure DevOps pull request, a branch, or uncommitted work for bugs, security issues, logic errors, regressions, and breaking changes. Use for PR review, re-review of a new iteration, pre-push review of local changes, validation of automated-review findings, batched full-coverage review of large diffs, and approval-gated inline comments. Produces severity-rated, evidence-verified findings with safe fix snippets and a clear verdict. Read-only by default: never posts, votes, resolves threads, pushes, or edits files without explicit approval. Do not use to implement fixes, write commit messages, or create PR descriptions.'
argument-hint: 'An Azure DevOps pull request URL or number, or a base branch to compare against'
user-invocable: true
---

# Pull Request Review

High-signal review that catches real defects — bugs, security vulnerabilities, logic errors, contract
breaks — with zero noise on style or formatting.

Mechanical work is done by `prr`, a bundled toolkit: it pins the iteration, triages every changed
file, builds risk-ordered batches, numbers every diff line, verifies your evidence against the source
revision, enforces coverage, and posts comments. **You supply the judgement; it supplies the facts.**

## Running the toolkit

Every command has the same shape. `<skill>` is the directory containing this file.

```
node "<skill>/bin/prr.mjs" <subcommand> [--flags]
```

Requires Node 18+, git, and an Azure DevOps credential: `AZURE_DEVOPS_EXT_PAT` if set, otherwise
`az login`. Run commands from inside a clone of the repository under review. If `prr` cannot start,
report that and stop — do not fall back to reviewing by hand.

## Safety

- Read-only until the user approves a **named** write action. Reviewing never authorizes posting,
  voting, resolving threads, changing reviewers, pushing, or editing files.
- Never check out, switch, or reset the user's working tree. `prr` fetches the pinned commits without
  touching HEAD, and reads uncommitted work without staging it.
- Posting applies to Azure DevOps pull requests only. Branch and working-tree reviews end at the
  report.

## Workflow

### 1. Prepare

```
node "<skill>/bin/prr.mjs" prepare <pr-url-or-id>     # Azure DevOps pull request
node "<skill>/bin/prr.mjs" prepare --branch main      # current branch vs its merge base
node "<skill>/bin/prr.mjs" prepare --working-tree     # uncommitted and untracked work
```

Pick the scope from what the user asked for. If both a branch and uncommitted changes could be meant
and the request is ambiguous, ask which.

For a pull request, add `--since <iteration>` when re-reviewing one you have reviewed before: only the
changes since that iteration are then in scope. Add `--reset` to discard an earlier pass over the same
revision.

The summary tells you the batch list, the pinned revisions, the rule files in effect, and every file
that will **not** be reviewed with the reason. Those exclusions must appear in your final Summary.

### 2. Review each batch, highest risk first

Read `payload/bNN.md` from the run directory. It contains everything you need: the annotated diffs,
per-file metadata, any project rules that apply to those paths, and existing threads on those files.

**Line numbers in the payload are real.** The number left of each line is its line number in the
source revision — report it as-is, never count lines yourself. Lines marked `-|` were removed and
cannot be commented on.

A `Project rules for this path` block is a constraint the repository's owners chose. Check it in
addition to the standards, and treat a violation as a finding.

If the batch header says `plan first: yes`, list the risks worth checking before reading the diffs,
then check them.

Read more only when a candidate finding cannot be confirmed from the payload:

```
node "<skill>/bin/prr.mjs" context --path <file> [--start <n>] [--end <n>]
node "<skill>/bin/prr.mjs" grep <symbol> [--path <pathspec>] [--files-only]
```

`context` returns 120 lines from `--start` by default; pass `--end` to widen it. Use `grep` — not
shell `grep` or `rg` — to find call sites and definitions: the repository may hold only the fetched
commits with no checkout, so a working-tree search silently finds nothing.

Judge each file against every dimension in `reference/standards.md` that its change touches.

### 3. Record verdicts and findings

Write a JSON file with your own file-writing tool, then record it. Never pipe JSON through the shell.

```json
{
  "batch": 1,
  "verdicts": [
    { "path": "src/pay/charge.ts", "verdict": "findings" },
    { "path": "src/pay/__tests__/charge.test.ts", "verdict": "clean" }
  ],
  "findings": [
    {
      "path": "src/pay/charge.ts",
      "severity": "high",
      "category": "bug",
      "problem": "Refund path compares a float total for equality, so a cent of rounding leaves the order unrefunded.",
      "evidence": "if (order.total === refund.amount) {",
      "fix": "Compare in minor units.",
      "fixedCode": "if (toCents(order.total) === toCents(refund.amount)) {"
    }
  ]
}
```

```
node "<skill>/bin/prr.mjs" note --file <path.json>
```

- `evidence` must be copied **verbatim** from the source revision. It is what anchors the finding;
  step 4 rejects anything that is not there, and you do not need to supply a line number.
- `verdict` is `clean`, `findings`, or `cross-batch` — the last only when confirming the issue needs
  a file from a later batch. Every reviewable file needs a verdict eventually.

Every reviewed file gets a verdict. Batching limits how much you read at once; it never reduces
coverage. Defer a file only with the user's explicit approval, and list it in the Summary.

If independent subagents are available, dispatch batches in parallel: give each one its payload path,
`reference/standards.md`, and the JSON contract above. Validate their findings yourself before
recording them.

### 4. Finalize

```
node "<skill>/bin/prr.mjs" finalize
```

This verifies every finding's evidence against the source revision, resolves its line, re-files it if
the evidence belongs to another changed file, checks coverage, and shortlists possible duplicates of
existing threads. It exits non-zero while coverage is incomplete.

**Do not produce a verdict until `finalize` reports OK.**

Act on what it reports:

- Evidence not found, or unlocated — the claim is not anchored to the code. Quote the code exactly, or
  move the item to **Open Questions**. Never publish it as a finding.
- Possible duplicate — decide using the rule below. If it is a duplicate, re-record the finding with
  `"status": "duplicate"` and mention it in the Summary instead.

`finalize --render` prints the findings block for your report. `finalize --format sarif` emits SARIF
2.1.0 and `--format json` the raw findings, for a pipeline that consumes them.

### 5. Report, then stop

Present Summary, Findings, Open Questions (if any), and Verdict. Then, for a pull request, ask whether
to post; do nothing else until the user answers. A branch or working-tree review ends here.

## Project rules

Rules add per-path constraints on top of `reference/standards.md`. They are resolved from `--rule
<path>`, then `<repo>/.pr-review/rules.json`, then the user's `~/.config/pr-review/rules.json`, then
built-ins; the first entry whose glob matches a file wins.

```json
{
  "rules": [
    { "path": "src/payments/**", "rule": "Money is handled in minor units; no float arithmetic.", "mergeBuiltin": true }
  ],
  "exclude": ["**/__fixtures__/**"]
}
```

`prr rules check <path>` shows what applies to a file and from which layer. Suggest writing a rule
when the same project-specific correction keeps coming up; do not create or edit the file yourself
without being asked.

## Severity

- 🔴 **Critical** — readily exploitable security issue, irreversible data loss, or widespread outage.
- 🟠 **High** — likely user-visible failure, security boundary violation, major contract break, or
  severe regression on a common path.
- 🟡 **Medium** — reproducible correctness, reliability, or performance defect with limited scope or a
  viable workaround.
- 🔵 **Low** — real but low-impact correctness or maintainability risk. Never style, naming, or
  preference.

Critical, High and Medium block approval. The emoji is part of the label: always write `🟠 High`,
never `High` or `[HIGH]`.

Severity is not confidence. If the evidence does not confirm a defect, it belongs in **Open
Questions**, not in a lower severity.

## Duplicates of existing threads

A candidate is already identified when an existing thread describes the same **root cause** and
affected behavior, even if its wording, severity, anchor, or proposed fix differs. Shared symptoms
alone do not make two findings duplicates; a shared root cause does.

- Exclude duplicates from Findings and from posting. Never open a second thread on the same defect.
- Mention them in one line in the Summary.
- A resolved or closed thread is evidence to check against the current revision, not a reason to
  repost. If the defect survives, say so in the Summary and leave the thread alone.

## What to report

Report confirmed defects only: bugs, security issues, contract breaks, races, leaks, incorrect failure
handling, intent violations, measurable regressions. Ignore style, naming, subjective design, and
harmless refactors. Note meaningful positives briefly.

## Output format

### Summary

One paragraph: what the change does, overall risk, batch coverage, files excluded by triage and why,
validation performed, remaining gaps, and any confirmed issue omitted because an existing thread
already covers it.

### Findings

Ordered by severity, as rendered by `finalize --render`. Each finding must stand alone as a comment.

### Open Questions (optional)

Only questions whose answers could change correctness, severity, or the verdict, each with the file,
line, and the exact evidence needed. Do not disguise speculative findings as questions.

### Verdict

- ✅ **Approve** — no Critical, High, or Medium findings
- 🔄 **Request Changes** — one or more confirmed blocking findings
- ❓ **Needs Clarification** — missing information prevents a responsible verdict

With no findings, say so explicitly and state any validation gaps. Never manufacture a finding.

## Posting (only after explicit approval)

```
node "<skill>/bin/prr.mjs" post --dry-run
node "<skill>/bin/prr.mjs" post [--min-severity medium] [--summary <path.md>]
```

Critical and High are posted by default; Medium and Low require the user to say so. Posting is
idempotent — a finding already posted is never posted twice — and only verified, located,
non-duplicate findings are eligible. Report what was posted and what was withheld.

Voting, resolving threads, changing reviewers, pushing, and editing files each need their own
explicit approval.

## Anti-patterns

- Do not count diff lines yourself, or report a line number the payload did not give you.
- Do not search with shell `grep`/`rg`; there may be no checkout to search. Use `prr grep`.
- Do not report a finding whose evidence `finalize` could not verify.
- Do not duplicate an existing thread, comment on style, or fabricate a fix.
- Do not read a whole file when the payload already answers the question.
- Do not skip `finalize`, and do not issue a verdict while it reports blockers.
