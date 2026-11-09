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
Workers must never edit the global rotation state or append to the shared publication
queue directly. A single coordinator will validate worker outputs, deduplicate by
`publication_key`, and enqueue publication packages.

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

Phase 1 (this change): isolated path layout, lease ownership, atomic JSON writes,
and unit tests.

Phase 2: adapt the generator to accept an explicit worker type and move checkpoints,
deferred tasks, and cooldown state into that worker's directory. Preserve the legacy
single-worker paths for migration/recovery; do not delete old checkpoints.

Phase 3: add a coordinator that imports completed worker artifacts into the inbox
with publication-key deduplication and one serialized commit.

Phase 4: enable a two-worker matrix for ordinary and interactive generation, with
novel generation remaining independently scheduled. Add provider-wide throttling
and end-to-end tests before raising concurrency.

Until phases 2–4 are complete, the existing daily workflow remains single-worker.
No new paid provider, billing setting, or API credential is introduced by this
migration.
