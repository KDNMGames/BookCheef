# BookCheef isolated generation workers

This migration introduces state boundaries and a safe, sequential handoff path for independent generation workers. Parallel generation is intentionally not enabled yet.

## Worker identities

- `ordinary` — standard books
- `interactive` — branching/choice books
- `novel` — long-form novel chapters

Each worker owns `book-publications/workers/<type>/`: lease, queue, checkpoints, deferred tasks, cooldown observations, and (for book workers) an outbox. The shared publication inbox and publisher remain outside worker state.

## Concurrency contract

1. A worker acquires its type-specific lease before touching worker state.
2. A live lease cannot be stolen; stale lease recovery is ownership-safe.
3. A worker only releases its own lease.
4. Worker state is written atomically.
5. Provider cooldowns are observations, not a shared quota lock. Provider-wide throttling is still required before parallel calls to free providers.
6. All artifact packages are imported sequentially by one coordinator process. Each package handoff is idempotent by `publication_key`.

## Implemented

- Worker-specific paths, leases, atomic JSON writes, and unit tests.
- Ordinary/interactive generation writes newly created packages to its worker outbox.
- `coordinate-worker-packages.mjs` validates package structure, deduplicates by `publication_key`, updates the pending queue, records worker handoff, and moves packages to the publication inbox.
- `coordinate-worker-artifacts.mjs` accepts a downloaded artifact tree shaped as `<artifact-root>/<worker-type>/outbox/*.json`. It processes ordinary, interactive, then novel packages sequentially through the existing coordinator. It emits the resulting inbox paths as a GitHub Actions multiline output. Re-running after a partial handoff is safe because already-imported source files have been moved and package keys are deduplicated.
- The novel generator now acquires a `novel` lease and writes a worker-scoped completion checkpoint. Its chapter and shared manifest are still committed by its own serialized workflow.
- CI checks syntax and tests worker leases, package coordination, and artifact coordination.

## Not enabled / remaining work

- The daily workflow is still single-worker. No matrix or parallel generation is active.
- The artifact coordinator is tested but not yet wired to a matrix workflow; worker jobs must upload their isolated outboxes and state, and one downstream job must download all artifacts and run the coordinator.
- The ordinary/interactive generator still reads shared pending queue and rotation state. It needs a true artifact-only mode that cannot commit or mutate shared queue/rotation/cooldown state.
- Novel chapter/manifest changes still target the shared draft tree. Novel output needs artifact handoff and a serialized manifest merge.
- Legacy deferred tasks still need a safe migration.
- Provider-wide throttling and cross-workflow publisher/queue serialization are required before any parallel run.

No AI generation is performed by the tests. No paid provider, billing setting, API credential, or paid credit is added by this migration.
