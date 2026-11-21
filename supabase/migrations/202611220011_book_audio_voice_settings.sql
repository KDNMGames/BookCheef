create table if not exists public.book_audio_settings (
  book_id uuid primary key references public.books(id) on delete cascade,
  voice_mode text not null default 'auto_multi'
    check (voice_mode in ('auto_multi', 'single')),
  narrator_voice text not null default 'Charon',
  style_prompt text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.book_audio_settings enable row level security;
revoke all on public.book_audio_settings from anon, authenticated;
grant select, insert, update on public.book_audio_settings to authenticated;

drop policy if exists "Admins manage book audio settings" on public.book_audio_settings;
create policy "Admins manage book audio settings"
on public.book_audio_settings
for all
to authenticated
using (public.is_bookcheef_admin())
with check (public.is_bookcheef_admin());
