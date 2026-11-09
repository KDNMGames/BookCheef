# Shared BookCheef provider quota coordinator

## Purpose

The ordinary, interactive, and novel workers must share one account-level quota state per provider. Worker-local cooldown JSON files are useful diagnostics, but they are not a cross-runner lock: two independent GitHub runners can read stale copies and call the same provider at once.

The shared coordinator uses the existing BookCheef Supabase **Free** project as a transactional lock and rolling-window counter. PostgreSQL advisory transaction locks serialize reservations for the same provider key. Each request receives a short-lived reservation, and a provider-wide cooldown is recorded when a quota/rate-limit response is observed.

## Files in this change

- `supabase/provider-quota-setup.sql` — SQL setup script for the private schema, reservation tables, and two narrowly scoped RPC functions.
- `scripts/provider-quota-coordinator.mjs` — Node.js client for acquire/complete/run.
- `scripts/provider-quota-coordinator.test.mjs` — mocked RPC tests; no AI request is made.

The setup SQL is deliberately **not applied to the live database** by this change. A transaction-wrapped dry run against the existing Supabase project created the objects, reserved a slot, completed it, and rolled back. A follow-up read confirmed that neither table was left behind.

## One-time activation steps

1. Open the existing Supabase project SQL Editor.
2. Review and run the complete contents of `supabase/provider-quota-setup.sql`.
3. In GitHub repository Settings → Secrets and variables → Actions → Secrets, add:
   - `SUPABASE_URL` — the existing BookCheef project API URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — the server-side service-role key for that same project.
4. Never place the service-role key in Vite variables, frontend code, committed files, artifacts, or logs. It is intended only for trusted GitHub Actions jobs.
5. Keep `CURSOR_FREE_INCLUDED=true` disabled unless Cursor's included-free entitlement has been explicitly confirmed. This quota coordinator does not change that safeguard.

## Default policy

- One in-flight request per provider account (`maxConcurrent=1`).
- 15 seconds minimum between reservations for the same provider.
- 24-hour rolling counter, initially uncapped (`maxRequestsPerWindow=0`) until the exact account/model quota is verified.
- 20-minute reservation lease; expired reservations are reclaimed.
- A 429/503/quota response records a shared six-hour cooldown by default; an explicit `retryAfterSeconds` overrides it within safe bounds.

Use account-level provider keys such as `gemini`, `openrouter`, and `cursor-agent`, not per-worker keys. This way every worker shares the same limit. Provider/model-specific limits can later use separate keys only when the provider documents independent quotas.

## Current activation status

The client and SQL contract are prepared and CI-tested. The live schema has not been changed, GitHub Actions secrets have not been added, and generation workflows are not yet calling this coordinator. Until the activation and integration steps are complete, parallel AI generation must remain disabled. Do not infer or configure numeric daily quotas from plan names; set them only after verifying the actual provider entitlement.
