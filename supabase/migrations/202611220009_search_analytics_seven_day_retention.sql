-- Keep only the latest 7 days of search analytics.
begin;

delete from public.book_search_analytics
where created_at < now() - interval '7 days';

do $$
begin
  if not exists (
    select 1 from cron.job where jobname = 'bookcheef-search-analytics-retention'
  ) then
    perform cron.schedule(
      'bookcheef-search-analytics-retention',
      '25 6 * * *',
      $job$delete from public.book_search_analytics where created_at < now() - interval '7 days';$job$
    );
  end if;
end;
$$;

commit;
