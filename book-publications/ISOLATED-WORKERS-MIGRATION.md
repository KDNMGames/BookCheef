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
- `coordinate-worker-artifacts.mjs` accepts book-publication package artifacts and hands them to the shared package coordinator. It must not be used for novel chapter artifacts, whose schema is different.
- The novel generator acquires a `novel` lease. In manual `artifact-only` mode it writes a `bookcheef_novel_chapter` JSON artifact and a worker-scoped checkpoint without touching the shared chapter tree or manifest. The scheduled workflow remains coordinated and gated by `CURSOR_FREE_INCLUDED=true`.
- CI checks syntax and tests worker leases, package coordination, book-package artifact coordination, and the separate novel chapter merger.

## Not enabled / remaining work

- The existing daily workflow is still single-worker. No automatic or matrix parallel generation is active.
- The manual novel artifact-only workflow uploads its chapter JSON and runs a dependent merge job. It commits the validated chapter and manifest only after successful validation.
- A shared provider-wide quota coordinator is prepared in `scripts/provider-quota-coordinator.mjs` with a private Supabase SQL setup script and mocked CI tests. The SQL setup has been applied to the existing Supabase Free project as migration `20261109123700_bookcheef_provider_quota_coordinator` and verified. It is not yet active in generation workflows because GitHub Actions service-role secrets and the enablement variable have not been added. Daily book and novel generators are wired behind `BOOKCHEEF_SHARED_QUOTA_ENABLED`, which remains off until activation. See `book-publications/PROVIDER-QUOTA-COORDINATOR.md`. Parallel generation remains disabled until activation, workflow integration, and cross-workflow publisher/queue serialization are complete. Cursor and Gemini API use are conservatively gated by explicit included-free entitlement flags; a Gemini Pro subscription is not treated as Gemini API credit.
- `coordinate-novel-artifacts.mjs` is a separate chapter merger. It validates the exact chapter artifact schema, canonical chapter path, heading/title, chapter number, volume, and word count; enforces manifest order; writes the chapter without overwriting different content; atomically updates the manifest; and only removes the source artifact after success. If interrupted after the chapter file is written, a retry can resume the manifest update. On successful merge it also persists the worker checkpoint as completed. A dedicated Node test suite and CI workflow cover successful merge, interrupted retry, invalid paths/counts/order, collisions, checkpoint persistence, and out-of-repository inputs. Latest CI run passed all five novel coordinator tests and the existing worker-state suite. The manual artifact-only workflow is now connected to a downstream merge job: it downloads the generated artifact, runs the dedicated validator/merger, and commits only the resulting chapter and manifest. The scheduled workflow remains in its existing coordinated mode.
- Legacy deferred tasks still need a safe migration.
- Provider-wide throttling and cross-workflow publisher/queue serialization are required before any parallel run.

No AI generation is performed by the tests. No paid provider, billing setting, API credential, or paid credit is added by this migration.
