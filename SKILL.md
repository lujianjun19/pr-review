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

`--depth quick|standard|deep` (default `standard`) sets thoroughness. Use `deep` when the user asks
for it or the change is security- or data-critical; `quick` only when asked for a fast pass.

| Depth | Batches | Plan first | Independent challenge required for | Low findings |
|---|---|---|---|---|
| quick | large | very large changes only | nothing | suppressed |
| standard | default | ≥ 50 changed lines | Critical, High, Medium | reported |
| deep | small | always | every finding | reported |

The summary tells you the batch list, pinned revisions, rule files, Azure DevOps policy/PR-status
signals, and every file that will **not** be reviewed with the reason. `policies.json` and
`builds.json` retain the bounded API evidence; an unavailable endpoint is a validation gap, not a
prepare failure. Those exclusions and gaps must appear in your final Summary. It also reports:

- **intent** — `intent.md` holds the title, description and linked work items (or, for a branch,
  the commit messages). An excerpt opens every payload.
- **guidance** — `AGENTS.md`, `CLAUDE.md`, `REVIEW.md` and Copilot instruction files that govern
  the changed paths, collected in `guidance.md`. Read it once per review.
- **risk tier** — a suggested number of human approvers (0, 1 or 2) with its reasons. Advisory only:
  quote it in the Summary; never vote or assign reviewers because of it.
- **prior prr findings** — threads posted by earlier runs, in `prior-findings.json` (see Re-review).
- **WARNING: this change edits review configuration** — rules and guidance are always read from the
  base revision, so the change cannot loosen its own review. Review the edit itself.

Commands after `prepare` only infer a run that belongs to the current git repository. Outside that
repository — or when several repos are in play — pass `--dir <run-directory>` explicitly; the tool
never falls back to another repository's most recent run.

### 2. Review each batch, highest risk first

Read `payload/bNN.md` from the run directory. It contains everything you need: the annotated diffs,
per-file metadata, any project rules that apply to those paths, and existing threads on those files.
Duplicate generated outputs (for example equivalent multi-target `.g.cs` files) are collapsed: one
representative is reviewed and the twins appear as `stat-only` with a `duplicate-of:<path>` reason.

**Line numbers in the payload are real.** The number left of each line is its line number in the
source revision — report it as-is, never count lines yourself. Lines marked `-|` were removed and
cannot be commented on.

A `Project rules for this path` block is a constraint the repository's owners chose. Check it in
addition to the standards, and treat a violation as a finding.

If the batch header says `plan first: yes`, list the risks worth checking before reading the diffs,
then check them.

Check each change against the **Stated intent** section: a change that does something other than
what was asked, or only part of it, is a finding. Rules stated in repository guidance are constraints
like project rules; style or tone guidance is never a reason to report.

Existing threads are listed with their **replies**. If the author already answered a point, do not
raise it again unless the answer is wrong — and then say why.

A defect you notice in code this change did not introduce is **pre-existing**: record it with
`"preExisting": true`. It is reported in its own section, never blocks the verdict, and is not posted
unless the user asks.

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
    { "path": "src/api/pagination.ts", "verdict": "findings" },
    { "path": "src/api/__tests__/pagination.test.ts", "verdict": "clean" }
  ],
  "findings": [
    {
      "path": "src/api/pagination.ts",
      "severity": "high",
      "category": "bug",
      "problem": "The last page is never returned when the item count is an exact multiple of the page size.",
      "evidence": "for (let page = 1; page < pageCount; page++) {",
      "fix": "Include the last page in the loop bound.",
      "fixedCode": "for (let page = 1; page <= pageCount; page++) {",
      "rationale": "pageCount is 1-based; with 20 items and size 10 the loop stops after page 1."
    }
  ]
}
```

```
node "<skill>/bin/prr.mjs" note --file <path.json>
```

- `evidence` must be copied **verbatim** from the source revision. It is what anchors the finding;
  step 4 rejects anything that is not there, and you do not need to supply a line number.
- A claim that a dependency's API “does not exist”, “is invalid”, or “always throws” needs stronger
  proof than any text search: verify it at runtime (`node -e "console.log(typeof x.y)"`) or by
  running the project's own tests before recording it. Grep over vendored or built code proves
  nothing about an API surface. Record that proof in the finding:

  ```json
  "verification": {
    "method": "runtime",
    "detail": "node -e \"console.log(typeof client.method)\" => function"
  }
  ```

  Allowed methods are `runtime`, `test-run`, and `declaration`; `prr note` rejects this class of
  finding without one.
- `verdict` is `clean`, `findings`, or `cross-batch` — the last only when confirming the issue needs
  a file from a later batch. Every reviewable file needs a verdict eventually.
- `rationale` (optional, recommended) is the reasoning chain: why the code misbehaves and how you
  confirmed it. It is shown under "Why this was flagged" when posted.
- `preExisting: true` marks a defect not introduced by this change.

Every reviewed file gets a verdict. For a clean batch, use the deterministic bulk command instead of
copying every path into JSON:

```
node "<skill>/bin/prr.mjs" note --batch <n> --all-clean
node "<skill>/bin/prr.mjs" note --batch <n> --all-clean --except <path>=findings
```

The command refuses to overwrite an existing different verdict. Batching limits how much you read
at once; it never reduces coverage. Defer a file only with the user's explicit approval, and list it
in the Summary.

If independent subagents are available, dispatch batches in parallel: give each one its payload path,
`reference/standards.md`, and the JSON contract above. Validate their findings yourself before
recording them.

### 3b. Challenge every blocking finding

Evidence verification proves the quoted code exists, not that the claim about it is true. Before
finalizing, try to **refute** each finding the depth requires (see the table in step 1).

Preferably dispatch a fresh subagent per finding (or per batch of findings) with: the finding, the
payload it came from, and this instruction: *"Try to prove this finding wrong. Read the surrounding
code with `prr context` and `prr grep`. Answer `confirmed`, `refuted` or `uncertain`, with what you
checked."* Without subagents, re-read the code yourself with that adversarial instruction, and record
`"by": "self"`.

```json
{ "challenges": [
  { "id": "<finding-id>", "outcome": "confirmed", "detail": "Traced listAll() with 20 items, size 10: page 2 is skipped.", "by": "subagent" }
] }
```

```
node "<skill>/bin/prr.mjs" note --file <challenges.json>
```

- `refuted` retracts the finding immediately; it never reaches the author.
- `uncertain` routes it to **Open Questions** at finalize.
- `confirmed` keeps it; the detail is posted under "Why this was flagged".

### 4. Finalize

```
node "<skill>/bin/prr.mjs" finalize
```

This verifies every finding's evidence against the source revision, resolves its line, re-files it if
the evidence belongs to another changed file, applies path thresholds and the Low cap, checks that
every finding the depth requires has been challenged, checks coverage, and shortlists possible
duplicates of existing threads. It writes `result.json` (counts and a suggested verdict) and exits
non-zero while coverage or challenges are incomplete.

**Do not produce a verdict until `finalize` reports OK.**

Act on what it reports:

- Evidence not found, or unlocated — the claim is not anchored to the code. Quote the code exactly, or
  move the item to **Open Questions**. Never publish it as a finding.
- Possible duplicate — decide using the rule below. If it is a duplicate, record
  `{"duplicates": [{"id": "<finding-id>", "thread": <thread-id>}]}` with `prr note --file` and
  mention it in the Summary instead. Re-noting a finding never changes it: its id is unchanged, so
  the second record is ignored. To correct a severity, record
  `{"reclassify": [{"id": "<finding-id>", "severity": "medium"}]}`.
- Unconfirmed — the challenge was uncertain. Report it under **Open Questions**, not Findings.
- Suppressed — verified but below a path's `minSeverity`, over `maxLowFindings`, or Low in a quick
  review. Give the count in the Summary; do not list them as findings.
- Needs an independent challenge — go back to step 3b.

### Retracting a wrong finding

Evidence verification proves the quoted code exists; it cannot prove your claim about that code is
true. If you discover a recorded finding is wrong — at any point, including after posting — retract
it; do not leave it standing or silently edit it:

```json
{ "retract": ["<finding-id>"] }
```

```
node "<skill>/bin/prr.mjs" note --file <retract.json>
```

`retracted` is terminal: `finalize` will not re-verify it and normal posting will never publish it.
If it was already posted, obtain explicit approval, then use the gated write path:

```
node "<skill>/bin/prr.mjs" post --retract <finding-id> --dry-run
node "<skill>/bin/prr.mjs" post --retract <finding-id>
```

This appends a correction and closes the recorded thread idempotently. Retraction changes finding
counts, so render a corrected Summary and update its existing thread too:

```
node "<skill>/bin/prr.mjs" post --update-summary --summary <corrected.md> --dry-run
node "<skill>/bin/prr.mjs" post --update-summary --summary <corrected.md>
```

A wrong finding left active misleads the author more than no finding.

Record executable validation through the run when a narrow test/build is needed:

```
node "<skill>/bin/prr.mjs" exec --record --timeout 300 -- npm test
```

This runs an explicit argv vector without a shell and writes a redacted, capped record to
`validations.jsonl`. A non-zero command returns the same exit code. Never claim a command passed
unless its recorded exit code is zero.

`finalize --render` prints the findings block for your report. `finalize --format sarif` emits SARIF
2.1.0 and `--format json` the raw findings, for a pipeline that consumes them.

### Re-review: earlier prr findings

Every comment `prr` posts ends with `prr finding <id>`, so a later run recognizes it.
`prior-findings.json` lists each such thread with its status, its replies, and whether its quoted
evidence still exists at the new revision. Payload thread lists mark them too.

For each **open** prior finding:

- Evidence gone, or the code visibly fixed — confirm the defect is gone, then propose resolving it.
- Author replied with a disagreement — judge it. If the author is right, propose withdrawing it.
- Still present and unanswered — leave it; do not post it again (posting skips it automatically).

Resolving is a write. With approval:

```
node "<skill>/bin/prr.mjs" post --resolve <thread-id>[,<id>...] --dry-run
node "<skill>/bin/prr.mjs" post --resolve <thread-id> [--resolution withdrawn] [--message reply.md]
```

`--resolve` only accepts threads listed in `prior-findings.json`; it never touches a human's thread.

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
    { "path": "src/api/**", "rule": "Every endpoint validates its input at the boundary.", "mergeBuiltin": true }
  ],
  "exclude": ["**/__fixtures__/**"]
}
```

Further keys, all optional:

- `"minSeverity": "high"` on a rule — findings below it on matching paths are suppressed, for code
  that deserves a higher bar (scripts, prototypes). A rule may set only `minSeverity`.
- `"maxLowFindings": 5` — the most Low findings one review publishes; the rest are counted.
- `"alwaysHuman": ["infra/**"]` — paths that always lift the risk tier to at least one human.
- `"riskPaths": [{ "path": "src/core/**", "weight": 3, "label": "core-logic" }]` — areas the project
  wants reviewed earlier. The toolkit is business-agnostic: built-in risk signals are technical
  only, so business-critical areas are declared here by the project. Entries sharing a label count
  once. Globs are case-sensitive.

For a review, the project file is read from the **base revision**, so a change cannot rewrite its own
rules. `prr rules check <path>` reads the working tree by default (`--rev <ref>` reads a revision).
Suggest writing a rule when the same project-specific correction keeps coming up; do not create or
edit the file yourself without being asked.

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

🟣 **Pre-existing** marks a defect this change did not introduce, alongside its severity, e.g.
`🟣 Pre-existing (High)`. It never blocks approval.

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

One paragraph: what the change does and whether it matches the stated intent, the suggested risk
tier, batch coverage, files excluded by triage and why, validation performed, remaining gaps,
findings suppressed by thresholds or caps (count only), any confirmed issue omitted because an
existing thread already covers it, and the state of earlier prr findings on a re-review.

### Findings

Ordered by severity, as rendered by `finalize --render`. Each finding must stand alone as a comment.
Pre-existing issues follow in their own section.

### Open Questions (optional)

Only questions whose answers could change correctness, severity, or the verdict, each with the file,
line, and the exact evidence needed. Do not disguise speculative findings as questions.

### Verdict

- ✅ **Approve** — no Critical, High, or Medium findings
- 🔄 **Request Changes** — one or more confirmed blocking findings
- ❓ **Needs Clarification** — missing information prevents a responsible verdict

`result.json` carries a `suggestedVerdict` computed from the recorded findings. Use it unless you have
a stated reason to differ. Pre-existing findings never change the verdict.

With no findings, say so explicitly and state any validation gaps. Never manufacture a finding.

## Posting (only after explicit approval)

```
node "<skill>/bin/prr.mjs" post --dry-run
node "<skill>/bin/prr.mjs" post [--min-severity medium] [--summary <path.md>]
```

Critical and High are posted by default; Medium and Low require the user to say so. Pre-existing
findings need `--include-pre-existing`. Posting is idempotent — a finding (also one posted by an
earlier run), retraction correction, or identical summary correction is never posted twice — and
only verified, located, non-duplicate, non-suppressed findings are eligible. A posted summary ends
with a generated `prr result:` line that pipelines can parse. Report what was posted and what was
withheld.

Voting, resolving threads, changing reviewers, pushing, and editing files each need their own
explicit approval.

## Anti-patterns

- Do not count diff lines yourself, or report a line number the payload did not give you.
- Do not search with shell `grep`/`rg`; there may be no checkout to search. Use `prr grep`.
- Do not claim a dependency API is missing or broken from a text search; verify at runtime first.
- Do not report a finding whose evidence `finalize` could not verify.
- Do not duplicate an existing thread, comment on style, or fabricate a fix.
- Do not read a whole file when the payload already answers the question.
- Do not skip `finalize`, and do not issue a verdict while it reports blockers.
- Do not let the agent that found an issue be its only judge; challenge blocking findings.
- Do not block a change on a pre-existing defect, or repeat a point the author already answered.
