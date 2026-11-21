create or replace function public.get_book_analytics_dashboard(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare v_days integer:=greatest(0,least(coalesce(p_days,30),365)); v_result jsonb;
begin
 if not coalesce(public.is_bookcheef_admin(),false) then
  raise exception 'Недостаточно прав для просмотра аналитики' using errcode='42501';
 end if;
 select jsonb_build_object(
 'period_days',v_days,
 'totals',(select jsonb_build_object(
  'books',(select count(*) from public.books),
  'views',(select coalesce(sum(coalesce(b.views,0)),0) from public.books b),
  'unique_visitors',(select count(distinct e.visitor_key) from public.book_analytics_events e),
  'registered_visitors',(select count(distinct e.user_id) from public.book_analytics_events e where e.user_id is not null),
  'started_readers',(select count(distinct h.user_id) from public.user_reading_history h),
  'completed_readers',(select count(distinct h.user_id) from public.user_reading_history h where h.completed),
  'human_reviews',(select count(*) from public.book_reviews r where coalesce(r.is_automated,false)=false and r.user_id is not null and r.parent_id is null),
  'human_replies',(select count(*) from public.book_reviews r where coalesce(r.is_automated,false)=false and r.user_id is not null and r.parent_id is not null),
  'bot_reviews',(select count(*) from public.book_reviews r where r.is_automated=true and r.parent_id is null),
  'bot_replies',(select count(*) from public.book_reviews r where r.is_automated=true and r.parent_id is not null),
  'searches',(select count(*) from public.book_search_analytics s where v_days=0 or s.created_at>=now()-make_interval(days=>v_days)),
  'search_visitors',(select count(distinct s.visitor_key) from public.book_search_analytics s where v_days=0 or s.created_at>=now()-make_interval(days=>v_days)),
  'search_no_results',(select count(*) from public.book_search_analytics s where s.results_count=0 and (v_days=0 or s.created_at>=now()-make_interval(days=>v_days)))
 )),
 'categories',(select coalesce(jsonb_agg(to_jsonb(c) order by c.total_views desc,c.category),'[]'::jsonb) from (
  select g.category,g.book_count,g.total_views,
   (select count(distinct e.visitor_key) from public.book_analytics_events e join public.books bx on bx.id=e.book_id where coalesce(nullif(btrim(bx.category),''),'Без категории')=g.category)::bigint unique_visitors,
   (select count(distinct h.user_id) from public.user_reading_history h join public.books bx on bx.id=h.book_id where coalesce(nullif(btrim(bx.category),''),'Без категории')=g.category)::bigint started_readers,
   (select count(*) from public.book_reviews r join public.books bx on bx.id=r.book_id where coalesce(nullif(btrim(bx.category),''),'Без категории')=g.category and coalesce(r.is_automated,false)=false and r.user_id is not null)::bigint human_reviews
  from (select coalesce(nullif(btrim(b.category),''),'Без категории') category,count(*)::bigint book_count,coalesce(sum(coalesce(b.views,0)),0)::bigint total_views from public.books b group by 1) g
 ) c),
 'authors',(select coalesce(jsonb_agg(to_jsonb(a) order by a.total_views desc,a.author),'[]'::jsonb) from (
  select g.author,g.book_count,g.total_views,
   (select count(distinct e.visitor_key) from public.book_analytics_events e join public.books bx on bx.id=e.book_id where coalesce(nullif(btrim(bx.author),''),'Автор не указан')=g.author)::bigint unique_visitors,
   (select count(distinct h.user_id) from public.user_reading_history h join public.books bx on bx.id=h.book_id where coalesce(nullif(btrim(bx.author),''),'Автор не указан')=g.author)::bigint started_readers,
   (select count(*) from public.book_reviews r join public.books bx on bx.id=r.book_id where coalesce(nullif(btrim(bx.author),''),'Автор не указан')=g.author and coalesce(r.is_automated,false)=false and r.user_id is not null)::bigint human_reviews
  from (select coalesce(nullif(btrim(b.author),''),'Автор не указан') author,count(*)::bigint book_count,coalesce(sum(coalesce(b.views,0)),0)::bigint total_views from public.books b group by 1) g
 ) a),
 'search_terms',(select coalesce(jsonb_agg(to_jsonb(x) order by x.search_count desc,x.query),'[]'::jsonb) from (
  select max(s.query_text) query,s.query_normalized,count(*)::bigint search_count,count(distinct s.visitor_key)::bigint unique_visitors,count(*) filter(where s.results_count=0)::bigint no_results,round(avg(s.results_count))::bigint average_results,max(s.created_at) last_searched
  from public.book_search_analytics s where v_days=0 or s.created_at>=now()-make_interval(days=>v_days)
  group by s.query_normalized order by count(*) desc,s.query_normalized limit 100
 ) x),
 'search_daily',(select coalesce(jsonb_agg(to_jsonb(x) order by x.search_day),'[]'::jsonb) from (
  select s.created_at::date as search_day,count(*)::bigint searches,count(*) filter(where s.results_count=0)::bigint no_results
  from public.book_search_analytics s where s.created_at>=now()-interval '30 days' group by s.created_at::date
 ) x)
 ) into v_result;
 return v_result;
end;
$function$;
revoke all on function public.get_book_analytics_dashboard(integer) from public,anon;
grant execute on function public.get_book_analytics_dashboard(integer) to authenticated;
notify pgrst,'reload schema';