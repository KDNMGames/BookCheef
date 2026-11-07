-- Book Gallery database schema (run in Supabase SQL Editor)
create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null default 'Без категории',
  description text default '',
  cover_url text not null,
  buy_url text not null,
  views bigint not null default 0,
  created_at timestamptz not null default now()
);
alter table public.books add column if not exists category text not null default 'Без категории';
alter table public.books add column if not exists views bigint not null default 0;
create table if not exists public.site_settings (id integer primary key check(id=1), data jsonb not null default '{}'::jsonb);
create table if not exists public.admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table public.books enable row level security;
alter table public.site_settings enable row level security;
alter table public.admins enable row level security;
drop policy if exists "Public can read books" on public.books;
create policy "Public can read books" on public.books for select using(true);
drop policy if exists "Admins can insert books" on public.books;
create policy "Admins can insert books" on public.books for insert to authenticated with check(exists(select 1 from public.admins where user_id=auth.uid()));
drop policy if exists "Admins can update books" on public.books;
create policy "Admins can update books" on public.books for update to authenticated using(exists(select 1 from public.admins where user_id=auth.uid())) with check(exists(select 1 from public.admins where user_id=auth.uid()));
drop policy if exists "Admins can delete books" on public.books;
create policy "Admins can delete books" on public.books for delete to authenticated using(exists(select 1 from public.admins where user_id=auth.uid()));
drop policy if exists "Public can read settings" on public.site_settings;
create policy "Public can read settings" on public.site_settings for select using(true);
drop policy if exists "Admins can write settings" on public.site_settings;
create policy "Admins can write settings" on public.site_settings for all to authenticated using(exists(select 1 from public.admins where user_id=auth.uid())) with check(exists(select 1 from public.admins where user_id=auth.uid()));
drop policy if exists "Admins can read own admin record" on public.admins;
create policy "Admins can read own admin record" on public.admins for select to authenticated using(user_id=auth.uid());
-- Public can only increment the counter through this function; direct table updates remain admin-only.
create or replace function public.increment_book_view(book_id uuid)
returns bigint language plpgsql security definer set search_path=public
as $$ declare new_views bigint; begin
  update public.books set views=views+1 where id=book_id returning views into new_views;
  return new_views;
end; $$;
revoke all on function public.increment_book_view(uuid) from public;
grant execute on function public.increment_book_view(uuid) to anon, authenticated;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('gallery','gallery',true,10485760,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict(id) do update set public=true;
drop policy if exists "Public can view gallery images" on storage.objects;
create policy "Public can view gallery images" on storage.objects for select using(bucket_id='gallery');
drop policy if exists "Admins can upload gallery images" on storage.objects;
create policy "Admins can upload gallery images" on storage.objects for insert to authenticated with check(bucket_id='gallery' and exists(select 1 from public.admins where user_id=auth.uid()));
drop policy if exists "Admins can update gallery images" on storage.objects;
create policy "Admins can update gallery images" on storage.objects for update to authenticated using(bucket_id='gallery' and exists(select 1 from public.admins where user_id=auth.uid())) with check(bucket_id='gallery' and exists(select 1 from public.admins where user_id=auth.uid()));
drop policy if exists "Admins can delete gallery images" on storage.objects;
create policy "Admins can delete gallery images" on storage.objects for delete to authenticated using(bucket_id='gallery' and exists(select 1 from public.admins where user_id=auth.uid()));


-- BookCheef metadata and reader migration
alter table public.books add column if not exists author text not null default '';
alter table public.books add column if not exists age text not null default '';
alter table public.books add column if not exists genre text not null default '';
alter table public.books add column if not exists series text not null default '';
alter table public.books add column if not exists is_free boolean not null default false;
alter table public.books add column if not exists price text;
alter table public.books add column if not exists book_content text not null default '';
-- Existing records with a purchase URL remain paid until edited by an administrator.
update public.books set is_free=false where coalesce(buy_url,'')<>'';

-- Reader questions and branching interactive books
alter table public.books add column if not exists is_interactive boolean not null default false;
alter table public.books add column if not exists reader_questions jsonb not null default '[]'::jsonb;
alter table public.books add column if not exists interactive_content jsonb;


-- Chapter-based AI audiobooks (Gemini TTS)
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
on public.book_audio_chapters for select to anon, authenticated
using (
  exists (
    select 1 from public.books b
    where b.id = book_audio_chapters.book_id
      and (b.is_free is true or public.has_active_pro_subscription() or public.is_bookcheef_admin())
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('book-audio', 'book-audio', false, 104857600, array['audio/wav']::text[])
on conflict (id) do update set public=false, file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists "Users can read audio files for accessible books" on storage.objects;
create policy "Users can read audio files for accessible books"
on storage.objects for select to anon, authenticated
using (
  bucket_id = 'book-audio'
  and exists (
    select 1 from public.books b
    where b.id::text = split_part(storage.objects.name, '/', 2)
      and (b.is_free is true or public.has_active_pro_subscription() or public.is_bookcheef_admin())
  )
);
