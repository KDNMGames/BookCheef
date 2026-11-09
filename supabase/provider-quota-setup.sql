-- BookCheef shared provider quota coordinator.
-- Apply only after reviewing this script. The tables live in a private schema;
-- the RPC functions are callable only by the GitHub Actions service_role key.

create schema if not exists bookcheef_private;
revoke all on schema bookcheef_private from public, anon, authenticated;
grant usage on schema bookcheef_private to service_role;

create table if not exists bookcheef_private.provider_quota_state (
  provider_key text primary key check (provider_key ~ '^[a-z0-9][a-z0-9._:-]{1,79}$'),
  cooldown_until timestamptz,
  last_reserved_at timestamptz,
  window_started_at timestamptz not null default now(),
  requests_in_window integer not null default 0 check (requests_in_window >= 0),
  last_reason text,
  updated_at timestamptz not null default now()
);

create table if not exists bookcheef_private.provider_quota_reservations (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null references bookcheef_private.provider_quota_state(provider_key) on delete cascade,
  worker_type text not null check (worker_type in ('ordinary', 'interactive', 'novel')),
  task_id text not null,
  status text not null default 'active' check (status in ('active', 'completed', 'rate_limited', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finished_at timestamptz,
  reason text
);

create index if not exists provider_quota_reservations_active_idx
  on bookcheef_private.provider_quota_reservations(provider_key, expires_at)
  where status = 'active';

alter table bookcheef_private.provider_quota_state enable row level security;
alter table bookcheef_private.provider_quota_reservations enable row level security;
revoke all on bookcheef_private.provider_quota_state from public, anon, authenticated;
revoke all on bookcheef_private.provider_quota_reservations from public, anon, authenticated;
grant select, insert, update, delete on bookcheef_private.provider_quota_state to service_role;
grant select, insert, update, delete on bookcheef_private.provider_quota_reservations to service_role;

create or replace function public.bookcheef_reserve_provider_request(
  p_provider_key text,
  p_worker_type text,
  p_task_id text,
  p_min_interval_seconds integer default 15,
  p_window_seconds integer default 86400,
  p_max_requests_per_window integer default 0,
  p_max_concurrent integer default 1,
  p_lease_seconds integer default 1200
)
returns table (
  allowed boolean,
  reservation_id uuid,
  retry_after timestamptz,
  reason text,
  requests_in_window integer,
  active_reservations integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_state bookcheef_private.provider_quota_state%rowtype;
  v_active integer := 0;
  v_retry timestamptz;
  v_reason text;
  v_id uuid;
begin
  if p_provider_key is null or p_provider_key !~ '^[a-z0-9][a-z0-9._:-]{1,79} or length(p_task_id) < 1 or length(p_task_id) > 160
     or p_min_interval_seconds is null or p_min_interval_seconds < 0 or p_min_interval_seconds > 3600
     or p_window_seconds is null or p_window_seconds < 60 or p_window_seconds > 2592000
     or p_max_requests_per_window is null or p_max_requests_per_window < 0 or p_max_requests_per_window > 1000000
     or p_max_concurrent is null or p_max_concurrent < 1 or p_max_concurrent > 100
     or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'Invalid provider quota reservation arguments';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_provider_key, 0));
  insert into bookcheef_private.provider_quota_state(provider_key)
  values (p_provider_key)
  on conflict (provider_key) do nothing;

  select * into v_state
  from bookcheef_private.provider_quota_state
  where provider_key = p_provider_key
  for update;

  update bookcheef_private.provider_quota_reservations
  set status = 'expired', finished_at = v_now
  where provider_key = p_provider_key and status = 'active' and expires_at <= v_now;

  select count(*)::integer into v_active
  from bookcheef_private.provider_quota_reservations
  where provider_key = p_provider_key and status = 'active' and expires_at > v_now;

  if v_state.window_started_at + pg_catalog.make_interval(secs => p_window_seconds) <= v_now then
    update bookcheef_private.provider_quota_state
    set window_started_at = v_now, requests_in_window = 0, updated_at = v_now
    where provider_key = p_provider_key
    returning * into v_state;
  end if;

  v_reason := null;
  v_retry := null;
  if v_state.cooldown_until is not null and v_state.cooldown_until > v_now then
    v_reason := 'provider_cooldown';
    v_retry := v_state.cooldown_until;
  elsif v_state.last_reserved_at is not null
    and v_state.last_reserved_at + pg_catalog.make_interval(secs => p_min_interval_seconds) > v_now then
    v_reason := 'minimum_interval';
    v_retry := v_state.last_reserved_at + pg_catalog.make_interval(secs => p_min_interval_seconds);
  elsif v_active >= p_max_concurrent then
    v_reason := 'concurrency_limit';
    select min(expires_at) into v_retry
    from bookcheef_private.provider_quota_reservations
    where provider_key = p_provider_key and status = 'active' and expires_at > v_now;
  elsif p_max_requests_per_window > 0 and v_state.requests_in_window >= p_max_requests_per_window then
    v_reason := 'window_request_limit';
    v_retry := v_state.window_started_at + pg_catalog.make_interval(secs => p_window_seconds);
  end if;

  if v_reason is not null then
    return query select false, null::uuid, v_retry, v_reason,
      v_state.requests_in_window, v_active;
    return;
  end if;

  insert into bookcheef_private.provider_quota_reservations(
    provider_key, worker_type, task_id, expires_at
  ) values (
    p_provider_key, p_worker_type, p_task_id,
    v_now + pg_catalog.make_interval(secs => p_lease_seconds)
  ) returning id into v_id;

  update bookcheef_private.provider_quota_state
  set last_reserved_at = v_now,
      requests_in_window = bookcheef_private.provider_quota_state.requests_in_window + 1,
      updated_at = v_now
  where provider_key = p_provider_key
  returning * into v_state;

  return query select true, v_id, null::timestamptz, null::text,
    v_state.requests_in_window, v_active + 1;
end;
$$;

create or replace function public.bookcheef_finish_provider_request(
  p_reservation_id uuid,
  p_outcome text default 'success',
  p_cooldown_seconds integer default 0,
  p_reason text default ''
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_provider text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_outcome is null or p_outcome not in ('success', 'failed', 'rate_limited')
     or p_cooldown_seconds is null or p_cooldown_seconds < 0 or p_cooldown_seconds > 2592000 then
    raise exception 'Invalid provider quota completion arguments';
  end if;

  select provider_key into v_provider
  from bookcheef_private.provider_quota_reservations
  where id = p_reservation_id and status = 'active';

  if v_provider is null then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_provider, 0));

  update bookcheef_private.provider_quota_reservations
  set status = case when p_outcome = 'rate_limited' then 'rate_limited' else p_outcome end,
      finished_at = v_now,
      reason = pg_catalog.left(coalesce(p_reason, ''), 700)
  where id = p_reservation_id and status = 'active';

  if not found then
    return false;
  end if;

  if p_outcome = 'rate_limited' then
    update bookcheef_private.provider_quota_state
    set cooldown_until = pg_catalog.greatest(
          coalesce(cooldown_until, v_now),
          v_now + pg_catalog.make_interval(secs => p_cooldown_seconds)
        ),
        last_reason = pg_catalog.left(coalesce(p_reason, ''), 700),
        updated_at = v_now
    where provider_key = v_provider;
  end if;
  return true;
end;
$$;

revoke all on function public.bookcheef_reserve_provider_request(text, text, text, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.bookcheef_finish_provider_request(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.bookcheef_reserve_provider_request(text, text, text, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.bookcheef_finish_provider_request(uuid, text, integer, text) to service_role;

     or p_worker_type is null or p_worker_type not in ('ordinary', 'interactive', 'novel')
     or p_task_id is null or length(p_task_id) < 1 or length(p_task_id) > 160
     or p_min_interval_seconds < 0 or p_min_interval_seconds > 3600
     or p_window_seconds < 60 or p_window_seconds > 2592000
     or p_max_requests_per_window < 0 or p_max_requests_per_window > 1000000
     or p_max_concurrent < 1 or p_max_concurrent > 100
     or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'Invalid provider quota reservation arguments';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_provider_key, 0));
  insert into bookcheef_private.provider_quota_state(provider_key)
  values (p_provider_key)
  on conflict (provider_key) do nothing;

  select * into v_state
  from bookcheef_private.provider_quota_state
  where provider_key = p_provider_key
  for update;

  update bookcheef_private.provider_quota_reservations
  set status = 'expired', finished_at = v_now
  where provider_key = p_provider_key and status = 'active' and expires_at <= v_now;

  select count(*)::integer into v_active
  from bookcheef_private.provider_quota_reservations
  where provider_key = p_provider_key and status = 'active' and expires_at > v_now;

  if v_state.window_started_at + pg_catalog.make_interval(secs => p_window_seconds) <= v_now then
    update bookcheef_private.provider_quota_state
    set window_started_at = v_now, requests_in_window = 0, updated_at = v_now
    where provider_key = p_provider_key
    returning * into v_state;
  end if;

  v_reason := null;
  v_retry := null;
  if v_state.cooldown_until is not null and v_state.cooldown_until > v_now then
    v_reason := 'provider_cooldown';
    v_retry := v_state.cooldown_until;
  elsif v_state.last_reserved_at is not null
    and v_state.last_reserved_at + pg_catalog.make_interval(secs => p_min_interval_seconds) > v_now then
    v_reason := 'minimum_interval';
    v_retry := v_state.last_reserved_at + pg_catalog.make_interval(secs => p_min_interval_seconds);
  elsif v_active >= p_max_concurrent then
    v_reason := 'concurrency_limit';
    select min(expires_at) into v_retry
    from bookcheef_private.provider_quota_reservations
    where provider_key = p_provider_key and status = 'active' and expires_at > v_now;
  elsif p_max_requests_per_window > 0 and v_state.requests_in_window >= p_max_requests_per_window then
    v_reason := 'window_request_limit';
    v_retry := v_state.window_started_at + pg_catalog.make_interval(secs => p_window_seconds);
  end if;

  if v_reason is not null then
    return query select false, null::uuid, v_retry, v_reason,
      v_state.requests_in_window, v_active;
    return;
  end if;

  insert into bookcheef_private.provider_quota_reservations(
    provider_key, worker_type, task_id, expires_at
  ) values (
    p_provider_key, p_worker_type, p_task_id,
    v_now + pg_catalog.make_interval(secs => p_lease_seconds)
  ) returning id into v_id;

  update bookcheef_private.provider_quota_state
  set last_reserved_at = v_now,
      requests_in_window = requests_in_window + 1,
      updated_at = v_now
  where provider_key = p_provider_key
  returning * into v_state;

  return query select true, v_id, null::timestamptz, null::text,
    v_state.requests_in_window, v_active + 1;
end;
$$;

create or replace function public.bookcheef_finish_provider_request(
  p_reservation_id uuid,
  p_outcome text default 'success',
  p_cooldown_seconds integer default 0,
  p_reason text default ''
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_provider text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_outcome not in ('success', 'failed', 'rate_limited')
     or p_cooldown_seconds < 0 or p_cooldown_seconds > 2592000 then
    raise exception 'Invalid provider quota completion arguments';
  end if;

  select provider_key into v_provider
  from bookcheef_private.provider_quota_reservations
  where id = p_reservation_id and status = 'active';

  if v_provider is null then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_provider, 0));

  update bookcheef_private.provider_quota_reservations
  set status = case when p_outcome = 'rate_limited' then 'rate_limited' else p_outcome end,
      finished_at = v_now,
      reason = pg_catalog.left(coalesce(p_reason, ''), 700)
  where id = p_reservation_id and status = 'active';

  if not found then
    return false;
  end if;

  if p_outcome = 'rate_limited' then
    update bookcheef_private.provider_quota_state
    set cooldown_until = pg_catalog.greatest(
          coalesce(cooldown_until, v_now),
          v_now + pg_catalog.make_interval(secs => p_cooldown_seconds)
        ),
        last_reason = pg_catalog.left(coalesce(p_reason, ''), 700),
        updated_at = v_now
    where provider_key = v_provider;
  end if;
  return true;
end;
$$;

revoke all on function public.bookcheef_reserve_provider_request(text, text, text, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.bookcheef_finish_provider_request(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.bookcheef_reserve_provider_request(text, text, text, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.bookcheef_finish_provider_request(uuid, text, integer, text) to service_role;
