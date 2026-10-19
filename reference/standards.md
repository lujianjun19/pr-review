# Review Standards

Apply each dimension whose surface the change actually touches. A file is `clean` only after the
applicable dimensions pass.

## Correctness

- Logic against stated intent — does the code do what the title, description, and linked work item say?
  The payload's **Stated intent** section carries them; a partial or divergent implementation is a
  finding.
- Boundary conditions: empty, null/undefined, zero, negative, maximum, off-by-one.
- Inverted, short-circuited, or accidentally always-true conditions.
- Units, currency, timezone, precision, and rounding. Float equality on money or measurements.
- Copy-paste errors: the wrong variable of a similar pair, a repeated branch that should differ.

## Security

- Injection: SQL, command, template, path, log.
- Authentication and authorization gaps, including a check that exists but is never reached.
- Secrets in code, logs, error messages, or telemetry.
- Unsafe deserialization, path traversal, SSRF, open redirects.
- Validation weakened or removed at a trust boundary.
- Dependency or manifest changes that add an untrusted source.

## Contracts

- Public API, exported type, or schema changes traced to every construction and consumption site.
- Serialization compatibility in both directions: can the old reader parse the new writer's output?
- Optional becoming required, enum members added or removed, nullability changes.
- Feature flag defaults, and behavior when the flag service is unavailable.

## Data

- Migrations: reversibility, locking, and behavior against existing rows.
- Persisted format changes and legacy records written by the previous version.
- Precision loss and lossy conversions.
- Missing-value paths: what happens to records that predate the new field.

## Failure handling

- Swallowed exceptions, and catch blocks that hide the original error.
- Error paths that leave partial state committed.
- Missing cancellation, timeouts, or backpressure.
- Retry without a cap or backoff.

## Concurrency and resources

- Races on shared mutable state; check-then-act sequences.
- Deadlocks and lock ordering.
- Blocking calls in async contexts; unawaited promises; fire-and-forget work that can outlive scope.
- Undisposed resources, unremoved listeners, unbounded caches.

## Regressions

- Deleted or weakened tests; assertions replaced with weaker ones.
- Removed validation or narrowed checks.
- Behavior changes with no matching test update.
- Silent fallback changes — a default that now hides a failure that used to surface.

## Performance

Report only measurable regressions, not speculative ones.

- New N+1 access patterns.
- Unbounded loops or allocations on a hot path.
- Synchronous I/O in an async context.
- Repeated expensive work per render or per request that was previously memoized.

## Claims about dependencies

A finding that asserts something about a third-party library — “this method does not exist”, “this
overload always throws”, “this option is ignored” — carries a different burden of proof than a
finding about the changed code itself:

- Text search over vendored, bundled, or minified code is **not** evidence of an API surface;
  formatting, build output shape, and re-exports all defeat it.
- Verify at runtime: `node -e "console.log(typeof require('lib').Thing.prototype.method)"`, a REPL
  probe, or the library's published type declarations.
- Strongest proof: run the repository's own tests that exercise the code path. A passing test that
  calls the API refutes “does not exist” conclusively.
- If runtime verification is unavailable in the environment, the claim belongs in **Open
  Questions**, not in Findings.

## Language-specific traps worth a second look

- **TypeScript/JavaScript** — `==` versus `===`; `typeof x === "number"` accepting `NaN`; `Array.sort`
  comparing as strings; mutation of props or state; `useEffect` dependency arrays; optional chaining
  masking a missing value.
- **C#** — `async void`; `.Result`/`.Wait()` deadlocks; `IDisposable` not disposed; LINQ enumerated
  more than once; nullable reference warnings suppressed.
- **Python** — mutable default arguments; broad `except`; late-binding closures in loops.
- **Go** — loop variable capture; ignored errors; missing `defer` on a resource; nil map writes.
- **SQL** — implicit cross joins; `NULL` comparison semantics; missing index on a new filter column.

## Introduced or pre-existing

A finding belongs to this change only if the change introduced it or made it reachable. Ask: does
the defect exist at the base revision with the same inputs?

- **Introduced** — the defect is in added or modified lines, or an unchanged line now misbehaves
  because of something the change did (a new caller, a changed contract, a removed guard). Report it
  normally.
- **Pre-existing** — the defect is in code the change did not touch and did not make newly
  reachable. Record it with `"preExisting": true`; it never blocks the verdict.

When unsure, it is introduced if the change is the reason a user would now hit it.

## Challenging a finding

The challenger's job is to break the claim, not to agree with it. Check, in order:

1. **Reachability** — is the bad input or state actually possible? Look for guards, validation,
   types, and callers upstream (`prr grep` for call sites).
2. **Behaviour** — trace the code path with a concrete input. Does it really produce the claimed
   result?
3. **Intent** — is the behaviour deliberate, per the stated intent, guidance, or a code comment?
4. **Impact** — does the severity match the consequence?

Answer `refuted` when any step disproves the claim, `uncertain` when the answer depends on something
the code does not show, and `confirmed` only after a concrete trace. Severity disagreements are not
refutations: correct the severity with `reclassify` instead.
