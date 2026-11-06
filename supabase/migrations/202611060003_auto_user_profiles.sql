-- Automatically create a minimal public profile for every Supabase Auth user.
-- Applies to registrations from both the website and Android app.
-- Safe to run more than once; does not alter auth.users or existing user data.

begin;

create table if not exists public.user_profiles (
    user_id uuid primary key references auth.users(id) on delete cascade
);

comment on table public.user_profiles is
    'Minimal public profile index. Identity and email remain in Supabase Auth; do not duplicate them here.';
comment on column public.user_profiles.user_id is
    'One-to-one reference to auth.users.id. The Auth record already contains email and created_at.';

alter table public.user_profiles enable row level security;

drop policy if exists "Users can read own minimal profile" on public.user_profiles;
create policy "Users can read own minimal profile"
    on public.user_profiles
    for select
    to authenticated
    using ((select auth.uid()) = user_id);

revoke all on table public.user_profiles from public, anon, authenticated;
grant select on table public.user_profiles to authenticated;

create or replace function public.create_user_profile_after_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.user_profiles (user_id)
    values (new.id)
    on conflict (user_id) do nothing;

    return new;
end;
$$;

revoke all on function public.create_user_profile_after_signup() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_bookcheef_profile on auth.users;
create trigger on_auth_user_created_bookcheef_profile
    after insert on auth.users
    for each row
    execute function public.create_user_profile_after_signup();

-- Backfill accounts that existed before this migration.
insert into public.user_profiles (user_id)
select id
from auth.users
on conflict (user_id) do nothing;

commit;

notify pgrst, 'reload schema';
