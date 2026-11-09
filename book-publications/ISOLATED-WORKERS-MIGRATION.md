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
- `BOOKCHEEF_WORKER_MODE=isolated` requires an explicit `BOOKCHEEF_WORKER_TYPE` (`ordinary` or `interactive`). In this mode the generator does not read the shared pending queue or rotation state, does not import the legacy shared checkpoint, does not mutate shared publication files, and only writes worker-scoped checkpoints/deferred state/outbox files.
- A manual, single-worker workflow (available for execution from `main` after review/merge) can run one selected worker, upload its worker directory as an artifact, and hand it to a downstream coordinator job. The coordinator restores worker-scoped checkpoints/deferred/cooldown state, imports outbox packages sequentially, commits the resulting queue/state, and dispatches the existing publisher for each accepted package. It intentionally does not run both worker types concurrently until provider-wide throttling is implemented.
- `coordinate-worker-packages.mjs` validates package structure, deduplicates by `publication_key`, updates the pending queue, records worker handoff, and moves packages to the publication inbox.
- `coordinate-worker-artifacts.mjs` accepts a downloaded artifact tree shaped as `<artifact-root>/<worker-type>/outbox/*.json`. It processes ordinary, interactive, then novel packages sequentially through the existing coordinator. It emits the resulting inbox paths as a GitHub Actions multiline output. Re-running after a partial handoff is safe because already-imported source files have been moved and package keys are deduplicated.
- The novel generator acquires a `novel` lease and writes a worker-scoped completion checkpoint. Its scheduled/manual workflow now stops before installing or invoking Cursor unless `CURSOR_FREE_INCLUDED=true`; the script independently enforces the same guard. Its chapter and shared manifest are still committed by its own serialized workflow.
- CI checks syntax and tests worker leases, package coordination, and artifact coordination.

## Not enabled / remaining work

- The existing daily workflow is still single-worker. No automatic or matrix parallel generation is active.
- The manual artifact-only workflow runs exactly one selected worker at a time and uploads its isolated state/outbox. It does not publish or commit the artifact.
- The artifact coordinator is connected to the manual workflow's downstream artifact-download job. This workflow is still manual and serial; it does not change the existing scheduled daily generator.
- A provider-wide throttle and coordinated quota budget are still required before running ordinary and interactive workers concurrently. Cursor is conservatively gated by the explicit included-free entitlement flag in the novel and isolated workflows.
- Novel generator supports a manual `artifact-only` mode: it writes a JSON chapter artifact and worker checkpoint without changing the shared chapter tree or manifest; the workflow uploads that artifact. The scheduled workflow remains in coordinated mode. A serialized artifact validator/manifest merger is still required before artifacts can be imported.
- Legacy deferred tasks still need a safe migration.
- Provider-wide throttling and cross-workflow publisher/queue serialization are required before any parallel run.

No AI generation is performed by the tests. No paid provider, billing setting, API credential, or paid credit is added by this migration.
