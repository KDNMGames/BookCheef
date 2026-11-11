create table if not exists public.bookcheef_one_shot_requests (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id text not null,
  telegram_chat_id text not null,
  topic text not null check (char_length(topic) between 3 and 2000),
  status text not null default 'preflight_blocked'
    check (status in ('requested','preflight_blocked','awaiting_free_provider','generating','editing','illustrating','validating','ready_to_publish','published','awaiting_assistant','failed','cancelled')),
  preflight_report jsonb not null default '{}'::jsonb,
  postflight_report jsonb,
  progress jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bookcheef_one_shot_requests_user_created_idx
  on public.bookcheef_one_shot_requests (telegram_user_id, created_at desc);
alter table public.bookcheef_one_shot_requests enable row level security;
revoke all on public.bookcheef_one_shot_requests from anon, authenticated;
grant all on public.bookcheef_one_shot_requests to service_role;
