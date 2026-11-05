-- BookCheef personal accounts: favorites, reading history and book ratings
create table if not exists public.user_book_favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id,book_id)
);
create table if not exists public.user_collection_favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  collection_id text not null,
  created_at timestamptz not null default now(),
  primary key(user_id,collection_id)
);
create table if not exists public.user_reading_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  last_opened_at timestamptz not null default now(),
  completed boolean not null default false,
  completed_at timestamptz,
  primary key(user_id,book_id),
  check ((completed = false) or completed_at is not null)
);
create table if not exists public.book_ratings (
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  rating smallint not null check (rating in (-1,1)),
  updated_at timestamptz not null default now(),
  primary key(user_id,book_id)
);

alter table public.user_book_favorites enable row level security;
alter table public.user_collection_favorites enable row level security;
alter table public.user_reading_history enable row level security;
alter table public.book_ratings enable row level security;

drop policy if exists "Users manage own book favorites" on public.user_book_favorites;
create policy "Users manage own book favorites" on public.user_book_favorites
for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());

drop policy if exists "Users manage own collection favorites" on public.user_collection_favorites;
create policy "Users manage own collection favorites" on public.user_collection_favorites
for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());

drop policy if exists "Users manage own reading history" on public.user_reading_history;
create policy "Users manage own reading history" on public.user_reading_history
for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());

drop policy if exists "Ratings are publicly readable" on public.book_ratings;
drop policy if exists "Users read own ratings" on public.book_ratings;
create policy "Users read own ratings" on public.book_ratings
for select to authenticated using(user_id=auth.uid());
drop policy if exists "Users manage own ratings" on public.book_ratings;
create policy "Users manage own ratings" on public.book_ratings
for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());

grant select,insert,delete on public.user_book_favorites to authenticated;
grant select,insert,delete on public.user_collection_favorites to authenticated;
grant select,insert,update,delete on public.user_reading_history to authenticated;
grant select on public.book_ratings to authenticated;
grant insert,update,delete on public.book_ratings to authenticated;

create index if not exists user_reading_history_last_opened_idx
on public.user_reading_history(user_id,last_opened_at desc);
create index if not exists book_ratings_book_idx
on public.book_ratings(book_id,rating);

notify pgrst,'reload schema';

-- Public counts without exposing individual reader identities
create or replace function public.get_book_rating_summary()
returns table(book_id uuid, likes bigint, dislikes bigint, my_rating smallint)
language sql stable security definer set search_path=public
as $$
  select r.book_id,
    count(*) filter (where r.rating=1) as likes,
    count(*) filter (where r.rating=-1) as dislikes,
    max(r.rating) filter (where r.user_id=auth.uid()) as my_rating
  from public.book_ratings r
  group by r.book_id;
$$;
revoke all on function public.get_book_rating_summary() from public;
grant execute on function public.get_book_rating_summary() to anon,authenticated;
notify pgrst,'reload schema';
