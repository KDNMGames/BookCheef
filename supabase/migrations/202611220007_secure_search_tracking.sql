-- Keep search tracking as a narrowly scoped invoker function; no privileged public RPC.
begin;
drop policy if exists "No direct access to book search analytics" on public.book_search_analytics;
drop policy if exists "Allow validated search analytics inserts" on public.book_search_analytics;
create policy "Allow validated search analytics inserts"
 on public.book_search_analytics for insert to anon,authenticated
 with check (
  char_length(query_text) between 2 and 100
  and query_normalized = lower(regexp_replace(
    btrim(regexp_replace(query_text,'[[:space:]]+',' ','g')),
    '[^[:alnum:][:space:]]+','','g'
  ))
  and results_count between 0 and 100000
  and visitor_key is not null
 );
grant insert on table public.book_search_analytics to anon,authenticated;
create or replace function public.track_book_search(p_query text,p_results_count integer,p_visitor_key uuid default null)
returns void
language plpgsql
security invoker
set search_path=''
as $function$
declare v_query text; v_normalized text; v_visitor uuid;
begin
 v_query:=left(regexp_replace(btrim(coalesce(p_query,'')),'[[:space:]]+',' ','g'),100);
 v_normalized:=lower(regexp_replace(v_query,'[^[:alnum:][:space:]]+','','g'));
 v_normalized:=btrim(regexp_replace(v_normalized,'[[:space:]]+',' ','g'));
 if char_length(v_normalized)<2 then return; end if;
 v_visitor:=coalesce(p_visitor_key,auth.uid(),gen_random_uuid());
 insert into public.book_search_analytics(visitor_key,query_text,query_normalized,results_count)
 values(v_visitor,v_query,v_normalized,greatest(0,least(coalesce(p_results_count,0),100000)));
end;
$function$;
revoke all on function public.track_book_search(text,integer,uuid) from public;
grant execute on function public.track_book_search(text,integer,uuid) to anon,authenticated;
notify pgrst,'reload schema';
commit;