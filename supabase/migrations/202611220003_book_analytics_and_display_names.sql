-- Per-book visitor and engagement analytics, plus a user-editable display name in Auth metadata.
begin;

create table if not exists public.book_analytics_events (
  id bigint generated always as identity primary key,
  book_id uuid not null references public.books(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  visitor_key uuid not null,
  viewed_on date not null default current_date,
  created_at timestamptz not null default now(),
  unique (book_id, visitor_key, viewed_on)
);
create index if not exists book_analytics_events_book_idx
  on public.book_analytics_events(book_id, viewed_on desc);
alter table public.book_analytics_events enable row level security;
revoke all on table public.book_analytics_events from public, anon, authenticated;

drop function if exists public.increment_book_view(uuid);
create or replace function public.increment_book_view(p_book_id uuid, p_visitor_key uuid default null)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare new_views bigint; effective_visitor uuid;
begin
  effective_visitor := coalesce(p_visitor_key, auth.uid(), gen_random_uuid());
  update public.books set views = coalesce(views, 0) + 1
   where id = p_book_id returning views into new_views;
  if new_views is null then return null; end if;
  insert into public.book_analytics_events(book_id, user_id, visitor_key)
  values (p_book_id, auth.uid(), effective_visitor)
  on conflict (book_id, visitor_key, viewed_on) do nothing;
  return new_views;
end;
$$;
revoke all on function public.increment_book_view(uuid, uuid) from public;
grant execute on function public.increment_book_view(uuid, uuid) to anon, authenticated;

create or replace function public.get_book_analytics()
returns table(
  book_id uuid, title text, total_views bigint, tracked_unique_visitors bigint,
  registered_visitors bigint, anonymous_visitors bigint, started_readers bigint,
  completed_readers bigint, human_reviews bigint, human_replies bigint,
  bot_reviews bigint, bot_replies bigint, human_likes bigint, human_dislikes bigint
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not coalesce(public.is_bookcheef_admin(), false) then
    raise exception 'Недостаточно прав для просмотра аналитики' using errcode = '42501';
  end if;
  return query
  select b.id, b.title, coalesce(b.views,0)::bigint,
    coalesce(ev.unique_visitors,0)::bigint, coalesce(ev.registered_visitors,0)::bigint,
    coalesce(ev.anonymous_visitors,0)::bigint, coalesce(rh.started_readers,0)::bigint,
    coalesce(rh.completed_readers,0)::bigint, coalesce(rv.human_reviews,0)::bigint,
    coalesce(rv.human_replies,0)::bigint, coalesce(rv.bot_reviews,0)::bigint,
    coalesce(rv.bot_replies,0)::bigint, coalesce(rt.human_likes,0)::bigint,
    coalesce(rt.human_dislikes,0)::bigint
  from public.books b
  left join lateral (
    select count(distinct e.visitor_key) unique_visitors,
      count(distinct e.user_id) filter(where e.user_id is not null) registered_visitors,
      count(distinct e.visitor_key) filter(where e.user_id is null) anonymous_visitors
    from public.book_analytics_events e where e.book_id=b.id
  ) ev on true
  left join lateral (
    select count(distinct h.user_id) started_readers,
      count(distinct h.user_id) filter(where h.completed) completed_readers
    from public.user_reading_history h where h.book_id=b.id
  ) rh on true
  left join lateral (
    select count(*) filter(where coalesce(r.is_automated,false)=false and r.user_id is not null) human_reviews,
      count(*) filter(where coalesce(r.is_automated,false)=false and r.user_id is not null and r.parent_id is not null) human_replies,
      count(*) filter(where r.is_automated=true) bot_reviews,
      count(*) filter(where r.is_automated=true and r.parent_id is not null) bot_replies
    from public.book_reviews r where r.book_id=b.id
  ) rv on true
  left join lateral (
    select count(*) filter(where r.rating=1) human_likes,
      count(*) filter(where r.rating=-1) human_dislikes
    from public.book_ratings r where r.book_id=b.id
  ) rt on true
  order by b.created_at desc nulls last, b.title;
end;
$$;
revoke all on function public.get_book_analytics() from public, anon;
grant execute on function public.get_book_analytics() to authenticated;

notify pgrst, 'reload schema';
commit;
