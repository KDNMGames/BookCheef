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

1. The SQL setup has already been applied to the existing Supabase Free project as migration `20261109123700_bookcheef_provider_quota_coordinator`; both private tables and RPC functions are present and verified.
2. In GitHub repository Settings → Secrets and variables → Actions → Secrets, add:
   - `SUPABASE_URL` — the existing BookCheef project API URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — the server-side service-role key for that same project.
3. Never place the service-role key in Vite variables, frontend code, committed files, artifacts, or logs. It is intended only for trusted GitHub Actions jobs.
4. In GitHub Actions Variables, set `BOOKCHEEF_SHARED_QUOTA_ENABLED=true` only after the SQL setup and both Supabase secrets are in place.
5. Keep `CURSOR_FREE_INCLUDED=true` and `GEMINI_FREE_INCLUDED=true` disabled unless the corresponding provider's included-free API entitlement has been explicitly confirmed. A Gemini Pro subscription does not by itself establish free Gemini API quota. This quota coordinator does not change those safeguards.

## Default policy

- One in-flight request per provider account (`maxConcurrent=1`).
- 15 seconds minimum between reservations for the same provider.
- 24-hour rolling counter, initially uncapped (`maxRequestsPerWindow=0`) until the exact account/model quota is verified.
- 20-minute reservation lease; expired reservations are reclaimed.
- A 429/503/quota response records a shared six-hour cooldown by default; an explicit `retryAfterSeconds` overrides it within safe bounds.

Use account-level provider keys such as `gemini`, `openrouter`, and `cursor-agent`, not per-worker keys. This way every worker shares the same limit. Provider/model-specific limits can later use separate keys only when the provider documents independent quotas.

## Current activation status

The client and SQL contract are prepared and CI-tested. The SQL migration is installed in the existing Supabase Free project and its RPC behavior and access controls were verified. The daily book and novel generators are wired behind `BOOKCHEEF_SHARED_QUOTA_ENABLED`, which remains off until the two GitHub Actions secrets and enablement variable are configured. No GitHub secrets/variables have been added by this change. Until activation and cross-workflow publisher/queue serialization are complete, parallel AI generation must remain disabled. Do not infer or configure numeric daily quotas from plan names; set them only after verifying the actual provider entitlement.
