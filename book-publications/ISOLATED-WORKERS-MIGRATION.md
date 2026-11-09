# BookCheef isolated generation workers

This migration introduces the state boundary for independent book-generation workers.
It is deliberately not enabled by the current daily workflow yet.

## Worker identities

- `ordinary` — standard books
- `interactive` — branching/choice books
- `novel` — long-form novel chapters

Each worker owns `book-publications/workers/<type>/`:

- `lease.json` — exclusive worker lease with expiry and run ownership
- `queue.json` — that worker's task queue
- `checkpoints/<task-id>.json` — resumable task state
- `deferred/<task-id>.json` — tasks parked after provider quota/rate limits
- `provider-cooldowns.json` — worker-local provider observations

The shared publication inbox and Supabase publisher remain outside worker state.
The target architecture requires workers not to edit the global rotation state or append
to the shared publication queue directly. The current Phase 2 adapter has not reached
that boundary yet: ordinary/interactive generation still appends to the legacy shared
pending-publication queue and may advance global rotation when a task is deferred. Do
not run multiple workers until the coordinator replaces these shared writes.

## Concurrency contract

1. A worker must acquire its type-specific lease before reading or writing worker state.
2. A live lease cannot be stolen. An expired lease can be reclaimed only after the
   existing lease file is atomically renamed out of the way.
3. A worker may only release a lease whose `run_id` matches its own.
4. Checkpoints and queue snapshots are written through a temporary file and rename.
5. Provider cooldowns are observations, not a global quota lock. Provider-level
   throttling must be coordinated separately before increasing parallelism.
6. Publication stays serialized by the existing `bookcheef-publication` workflow
   concurrency group.

## Rollout status

Phase 1: isolated path layout, lease ownership, atomic JSON writes, and unit tests.

Phase 2 (partially implemented): ordinary/interactive generator now uses its worker's
checkpoint, deferred-task file, cooldown files, lease, and completion queue record.
A matching legacy work-in-progress/current.json checkpoint is copied into the worker
store without deleting the original. The existing legacy deferred queue is preserved
but is not yet automatically migrated. The novel chapter generator is not yet adapted.
The shared inbox, pending-publication queue, and rotation state are still written by
the daily generator, so this is not yet safe for parallel runs.

Phase 3 (partially implemented): the daily generator writes new packages only to its
worker outbox. `coordinate-worker-packages.mjs` validates the package, serializes local
queue updates with an exclusive lock, deduplicates by `publication_key`, atomically
updates the pending queue, records the worker handoff, and moves the package into the
publication inbox. Unit tests cover successful handoff, duplicate keys, type mismatch,
and path traversal. The daily workflow runs the coordinator before committing and
dispatching the publisher. Cross-workflow publication locking and artifact handoff
for genuinely parallel runner machines are still outstanding. Legacy deferred tasks
and the novel chapter generator are not yet migrated.

Phase 4: enable a two-worker matrix for ordinary and interactive generation, with
novel generation remaining independently scheduled. Add provider-wide throttling
and end-to-end tests before raising concurrency.

Until phases 2–4 are complete, the existing daily workflow remains single-worker.
No new paid provider, billing setting, or API credential is introduced by this
migration.
