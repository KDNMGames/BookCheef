-- BookCheef per-book reader reviews with author/admin moderation.
begin;

create table if not exists public.book_reviews (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null check (char_length(btrim(author_name)) between 1 and 60),
  body text not null check (char_length(btrim(body)) between 1 and 3000),
  rating smallint not null check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, user_id)
);

create index if not exists book_reviews_book_created_idx
  on public.book_reviews (book_id, created_at desc);

alter table public.book_reviews enable row level security;

revoke all on public.book_reviews from public, anon, authenticated;
grant select on public.book_reviews to anon, authenticated;
grant insert, update, delete on public.book_reviews to authenticated;

drop policy if exists "Anyone can read book reviews" on public.book_reviews;
create policy "Anyone can read book reviews"
  on public.book_reviews for select
  to anon, authenticated
  using (true);

drop policy if exists "Users create own book reviews" on public.book_reviews;
create policy "Users create own book reviews"
  on public.book_reviews for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.books b where b.id = book_reviews.book_id)
  );

drop policy if exists "Authors and admins update book reviews" on public.book_reviews;
create policy "Authors and admins update book reviews"
  on public.book_reviews for update
  to authenticated
  using (user_id = (select auth.uid()) or public.is_bookcheef_admin())
  with check (user_id = (select auth.uid()) or public.is_bookcheef_admin());

drop policy if exists "Authors and admins delete book reviews" on public.book_reviews;
create policy "Authors and admins delete book reviews"
  on public.book_reviews for delete
  to authenticated
  using (user_id = (select auth.uid()) or public.is_bookcheef_admin());

create or replace function public.set_book_review_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_book_review_updated_at() from public, anon, authenticated;

drop trigger if exists set_book_review_updated_at on public.book_reviews;
create trigger set_book_review_updated_at
before update on public.book_reviews
for each row execute function public.set_book_review_updated_at();

commit;
notify pgrst, 'reload schema';
