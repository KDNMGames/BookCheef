drop policy if exists "Allow validated search analytics inserts" on public.book_search_analytics;
create policy "Allow validated search analytics inserts"
 on public.book_search_analytics for insert to anon,authenticated
 with check (
  char_length(query_text) between 2 and 100
  and query_normalized = btrim(lower(regexp_replace(
    btrim(regexp_replace(query_text,'[[:space:]]+',' ','g')),
    '[^[:alnum:][:space:]]+','','g'
  )))
  and results_count between 0 and 100000
  and visitor_key is not null
);