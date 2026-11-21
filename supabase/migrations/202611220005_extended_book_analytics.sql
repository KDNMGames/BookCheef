-- Extended BookCheef analytics: category, author and catalog-search insights.
begin;

create table if not exists public.book_search_analytics (
  id bigint generated always as identity primary key,
  visitor_key uuid not null,
  query_text text not null,
  query_normalized text not null,
  results_count integer not null default 0 check (results_count >= 0),
  created_at timestamptz not null default now()
);
create index if not exists book_search_analytics_created_idx
  on public.book_search_analytics(created_at desc);
create index if not exists book_search_analytics_query_idx
  on public.book_search_analytics(query_normalized, created_at desc);
create index if not exists book_search_analytics_visitor_idx
  on public.book_search_analytics(visitor_key, created_at desc);

alter table public.book_search_analytics enable row level security;
revoke all on table public.book_search_analytics from public, anon, authenticated;
drop policy if exists "No direct access to book search analytics" on public.book_search_analytics;
create policy "No direct access to book search analytics"
  on public.book_search_analytics for all to anon, authenticated
  using (false) with check (false);

create or replace function public.track_book_search(
  p_query text,
  p_results_count integer,
  p_visitor_key uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_query text;
  v_normalized text;
  v_visitor uuid;
begin
  v_query := left(regexp_replace(btrim(coalesce(p_query, '')), '[[:space:]]+', ' ', 'g'), 100);
  v_normalized := lower(regexp_replace(v_query, '[^[:alnum:][:space:]]+', '', 'g'));
  v_normalized := btrim(regexp_replace(v_normalized, '[[:space:]]+', ' ', 'g'));
  if char_length(v_normalized) < 2 then return; end if;

  v_visitor := coalesce(p_visitor_key, auth.uid(), gen_random_uuid());
  if exists (
    select 1 from public.book_search_analytics s
    where s.visitor_key = v_visitor
      and s.query_normalized = v_normalized
      and s.created_at > now() - interval '10 minutes'
  ) then
    return;
  end if;

  insert into public.book_search_analytics(visitor_key, query_text, query_normalized, results_count)
  values (v_visitor, v_query, v_normalized, greatest(0, least(coalesce(p_results_count, 0), 100000)));
end;
$function$;
revoke all on function public.track_book_search(text, integer, uuid) from public;
grant execute on function public.track_book_search(text, integer, uuid) to anon, authenticated;

create or replace function public.get_book_analytics_dashboard(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_days integer := greatest(0, least(coalesce(p_days, 30), 365));
  v_result jsonb;
begin
  if not coalesce(public.is_bookcheef_admin(), false) then
    raise exception 'Недостаточно прав для просмотра аналитики' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'period_days', v_days,
    'totals', (
      select jsonb_build_object(
        'books', (select count(*) from public.books),
        'views', (select coalesce(sum(coalesce(b.views,0)),0) from public.books b),
        'unique_visitors', (select count(distinct e.visitor_key) from public.book_analytics_events e),
        'registered_visitors', (select count(distinct e.user_id) from public.book_analytics_events e where e.user_id is not null),
        'started_readers', (select count(distinct h.user_id) from public.user_reading_history h),
        'completed_readers', (select count(distinct h.user_id) from public.user_reading_history h where h.completed),
        'human_reviews', (select count(*) from public.book_reviews r where coalesce(r.is_automated,false)=false and r.user_id is not null and r.parent_id is null),
        'human_replies', (select count(*) from public.book_reviews r where coalesce(r.is_automated,false)=false and r.user_id is not null and r.parent_id is not null),
        'bot_reviews', (select count(*) from public.book_reviews r where r.is_automated=true and r.parent_id is null),
        'bot_replies', (select count(*) from public.book_reviews r where r.is_automated=true and r.parent_id is not null),
        'searches', (select count(*) from public.book_search_analytics s where v_days=0 or s.created_at >= now() - make_interval(days => v_days)),
        'search_visitors', (select count(distinct s.visitor_key) from public.book_search_analytics s where v_days=0 or s.created_at >= now() - make_interval(days => v_days)),
        'search_no_results', (select count(*) from public.book_search_analytics s where s.results_count=0 and (v_days=0 or s.created_at >= now() - make_interval(days => v_days)))
      )
    ),
    'categories', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.total_views desc, x.category), '[]'::jsonb)
      from (
        select coalesce(nullif(btrim(b.category),''),'Без категории') category,
          count(*)::bigint book_count,
          coalesce(sum(coalesce(b.views,0)),0)::bigint total_views,
          (select count(distinct e.visitor_key) from public.book_analytics_events e join public.books bx on bx.id=e.book_id where coalesce(nullif(btrim(bx.category),''),'Без категории')=coalesce(nullif(btrim(b.category),''),'Без категории'))::bigint unique_visitors,
          (select count(distinct h.user_id) from public.user_reading_history h join public.books bx on bx.id=h.book_id where coalesce(nullif(btrim(bx.category),''),'Без категории')=coalesce(nullif(b.category,''),'Без категории'))::bigint started_readers,
          (select count(*) from public.book_reviews r join public.books bx on bx.id=r.book_id where coalesce(nullif(btrim(bx.category),''),'Без категории')=coalesce(nullif(b.category,''),'Без категории') and coalesce(r.is_automated,false)=false and r.user_id is not null)::bigint human_reviews
        from public.books b
        group by coalesce(nullif(btrim(b.category),''),'Без категории')
      ) x
    ),
    'authors', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.total_views desc, x.author), '[]'::jsonb)
      from (
        select coalesce(nullif(btrim(b.author),''),'Автор не указан') author,
          count(*)::bigint book_count,
          coalesce(sum(coalesce(b.views,0)),0)::bigint total_views,
          (select count(distinct e.visitor_key) from public.book_analytics_events e join public.books bx on bx.id=e.book_id where coalesce(nullif(btrim(bx.author),''),'Автор не указан')=coalesce(nullif(btrim(b.author),''),'Автор не указан'))::bigint unique_visitors,
          (select count(distinct h.user_id) from public.user_reading_history h join public.books bx on bx.id=h.book_id where coalesce(nullif(btrim(bx.author),''),'Автор не указан')=coalesce(nullif(btrim(b.author),''),'Автор не указан'))::bigint started_readers,
          (select count(*) from public.book_reviews r join public.books bx on bx.id=r.book_id where coalesce(nullif(btrim(bx.author),''),'Автор не указан')=coalesce(nullif(btrim(b.author),''),'Автор не указан') and coalesce(r.is_automated,false)=false and r.user_id is not null)::bigint human_reviews
        from public.books b
        group by coalesce(nullif(btrim(b.author),''),'Автор не указан')
      ) x
    ),
    'search_terms', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.search_count desc, x.query), '[]'::jsonb)
      from (
        select max(s.query_text) query,
          s.query_normalized,
          count(*)::bigint search_count,
          count(distinct s.visitor_key)::bigint unique_visitors,
          count(*) filter(where s.results_count=0)::bigint no_results,
          round(avg(s.results_count))::bigint average_results,
          max(s.created_at) last_searched
        from public.book_search_analytics s
        where v_days=0 or s.created_at >= now() - make_interval(days => v_days)
        group by s.query_normalized
        order by count(*) desc, s.query_normalized
        limit 100
      ) x
    ),
    'search_daily', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.day), '[]'::jsonb)
      from (
        select s.created_at::date day, count(*)::bigint searches,
          count(*) filter(where s.results_count=0)::bigint no_results
        from public.book_search_analytics s
        where s.created_at >= now() - interval '30 days'
        group by s.created_at::date
      ) x
    )
  ) into v_result;

  return v_result;
end;
$function$;
revoke all on function public.get_book_analytics_dashboard(integer) from public, anon;
grant execute on function public.get_book_analytics_dashboard(integer) to authenticated;

notify pgrst, 'reload schema';
commit;
