# Review Standards

Apply each dimension whose surface the change actually touches. A file is `clean` only after the
applicable dimensions pass.

## Correctness

- Logic against stated intent — does the code do what the title, description, and linked work item say?
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

## Language-specific traps worth a second look

- **TypeScript/JavaScript** — `==` versus `===`; `typeof x === "number"` accepting `NaN`; `Array.sort`
  comparing as strings; mutation of props or state; `useEffect` dependency arrays; optional chaining
  masking a missing value.
- **C#** — `async void`; `.Result`/`.Wait()` deadlocks; `IDisposable` not disposed; LINQ enumerated
  more than once; nullable reference warnings suppressed.
- **Python** — mutable default arguments; broad `except`; late-binding closures in loops.
- **Go** — loop variable capture; ignored errors; missing `defer` on a resource; nil map writes.
- **SQL** — implicit cross joins; `NULL` comparison semantics; missing index on a new filter column.
