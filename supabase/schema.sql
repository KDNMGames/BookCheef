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
