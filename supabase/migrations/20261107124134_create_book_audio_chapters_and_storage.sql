create table if not exists public.book_audio_chapters (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  chapter_index integer not null check (chapter_index > 0),
  chapter_title text not null,
  storage_path text not null unique,
  duration_seconds numeric(10,2),
  voice_name text not null default 'Charon',
  model text not null default 'gemini-3.8-flash-tts',
  content_hash text not null,
  status text not null default 'ready' check (status in ('ready')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, chapter_index)
);

alter table public.book_audio_chapters enable row level security;
grant select on public.book_audio_chapters to anon, authenticated;

drop policy if exists "Users can read audio for accessible books" on public.book_audio_chapters;
create policy "Users can read audio for accessible books"
on public.book_audio_chapters
for select
to anon, authenticated
using (
  exists (
    select 1 from public.books b
    where b.id = book_audio_chapters.book_id
      and (b.is_free is true or public.has_active_pro_subscription() or public.is_bookcheef_admin())
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('book-audio', 'book-audio', false, 104857600, array['audio/wav']::text[])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read audio files for accessible books" on storage.objects;
create policy "Users can read audio files for accessible books"
on storage.objects
for select
to anon, authenticated
using (
  bucket_id = 'book-audio'
  and exists (
    select 1 from public.books b
    where b.id::text = split_part(storage.objects.name, '/', 2)
      and (b.is_free is true or public.has_active_pro_subscription() or public.is_bookcheef_admin())
  )
);
