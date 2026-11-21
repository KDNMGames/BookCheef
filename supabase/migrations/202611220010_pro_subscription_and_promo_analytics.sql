-- Pro subscription lifecycle and promo-code analytics for BookCheef.
begin;
create table if not exists public.pro_subscription_analytics_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('activated','renewed','reactivated','expired')),
  expires_at timestamptz not null,
  event_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(user_id,event_type,expires_at)
);
create index if not exists pro_subscription_analytics_event_at_idx on public.pro_subscription_analytics_events(event_at desc);
create index if not exists pro_subscription_analytics_type_event_idx on public.pro_subscription_analytics_events(event_type,event_at desc);
alter table public.pro_subscription_analytics_events enable row level security;
revoke all on public.pro_subscription_analytics_events from public,anon,authenticated;
drop policy if exists "Admins read Pro subscription analytics" on public.pro_subscription_analytics_events;
create policy "Admins read Pro subscription analytics" on public.pro_subscription_analytics_events for select to authenticated using (public.is_bookcheef_admin());

create or replace function public.log_pro_subscription_change()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  if tg_op = 'INSERT' then
    if new.expires_at > now() then
      insert into public.pro_subscription_analytics_events(user_id,event_type,expires_at,event_at)
      values(new.user_id,'activated',new.expires_at,now()) on conflict (user_id,event_type,expires_at) do nothing;
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.expires_at > now() then
      insert into public.pro_subscription_analytics_events(user_id,event_type,expires_at,event_at)
      values(old.user_id,'expired',old.expires_at,now()) on conflict (user_id,event_type,expires_at) do nothing;
    end if;
    return old;
  else
    if new.expires_at is distinct from old.expires_at then
      if new.expires_at > old.expires_at then
        insert into public.pro_subscription_analytics_events(user_id,event_type,expires_at,event_at)
        values(new.user_id,case when old.expires_at <= now() then 'reactivated' else 'renewed' end,new.expires_at,now())
        on conflict (user_id,event_type,expires_at) do nothing;
      elsif old.expires_at > now() and new.expires_at <= now() then
        insert into public.pro_subscription_analytics_events(user_id,event_type,expires_at,event_at)
        values(old.user_id,'expired',old.expires_at,now()) on conflict (user_id,event_type,expires_at) do nothing;
      end if;
    end if;
    return new;
  end if;
end;
$$;
drop trigger if exists trg_log_pro_subscription_change on public.user_subscriptions;
create trigger trg_log_pro_subscription_change after insert or update of expires_at or delete on public.user_subscriptions for each row execute function public.log_pro_subscription_change();

insert into public.pro_subscription_analytics_events(user_id,event_type,expires_at,event_at)
select s.user_id,'expired',s.expires_at,s.expires_at from public.user_subscriptions s
where s.expires_at <= now() on conflict (user_id,event_type,expires_at) do nothing;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'bookcheef-pro-subscription-expiry') then
    perform cron.schedule('bookcheef-pro-subscription-expiry','35 6 * * *',
      $job$insert into public.pro_subscription_analytics_events(user_id,event_type,expires_at,event_at)
      select s.user_id,'expired',s.expires_at,s.expires_at from public.user_subscriptions s
      where s.expires_at <= now() on conflict (user_id,event_type,expires_at) do nothing;$job$);
  end if;
end;
$$;

create or replace function public.get_book_commercial_analytics(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path=public
as $$
declare v_days integer := greatest(0,least(coalesce(p_days,30),365)); v_result jsonb;
begin
  if not coalesce(public.is_bookcheef_admin(),false) then
    raise exception 'Недостаточно прав для просмотра аналитики' using errcode='42501';
  end if;
  select jsonb_build_object(
    'period_days',v_days,
    'subscription_totals',jsonb_build_object(
      'active_now',(select count(*) from public.user_subscriptions s where s.expires_at > now()),
      'incoming',(select count(*) from public.pro_subscription_analytics_events e where e.event_type in ('activated','reactivated') and (v_days=0 or e.event_at >= now()-make_interval(days=>v_days))),
      'activated',(select count(*) from public.pro_subscription_analytics_events e where e.event_type='activated' and (v_days=0 or e.event_at >= now()-make_interval(days=>v_days))),
      'reactivated',(select count(*) from public.pro_subscription_analytics_events e where e.event_type='reactivated' and (v_days=0 or e.event_at >= now()-make_interval(days=>v_days))),
      'renewed',(select count(*) from public.pro_subscription_analytics_events e where e.event_type='renewed' and (v_days=0 or e.event_at >= now()-make_interval(days=>v_days))),
      'outgoing',(select count(*) from public.pro_subscription_analytics_events e where e.event_type='expired' and (v_days=0 or e.event_at >= now()-make_interval(days=>v_days)))
    ),
    'promo_codes',(select coalesce(jsonb_agg(to_jsonb(x) order by x.activations desc,x.code),'[]'::jsonb) from (
      select p.id,p.code,p.duration_months,p.max_uses,p.used_count,count(r.id)::bigint activations,
        count(r.id) filter(where v_days=0 or r.redeemed_at >= now()-make_interval(days=>v_days))::bigint activations_period,
        max(r.redeemed_at) last_activated
      from public.promo_codes p left join public.promo_redemptions r on r.promo_code_id=p.id
      group by p.id,p.code,p.duration_months,p.max_uses,p.used_count
    ) x),
    'promo_daily',(select coalesce(jsonb_agg(to_jsonb(x) order by x.event_day),'[]'::jsonb) from (
      select r.redeemed_at::date event_day,count(*)::bigint activations from public.promo_redemptions r
      where v_days=0 or r.redeemed_at >= now()-make_interval(days=>v_days) group by r.redeemed_at::date
    ) x),
    'subscription_daily',(select coalesce(jsonb_agg(to_jsonb(x) order by x.event_day),'[]'::jsonb) from (
      select e.event_at::date event_day,
        count(*) filter(where e.event_type in ('activated','reactivated'))::bigint incoming,
        count(*) filter(where e.event_type='renewed')::bigint renewed,
        count(*) filter(where e.event_type='expired')::bigint outgoing
      from public.pro_subscription_analytics_events e
      where v_days=0 or e.event_at >= now()-make_interval(days=>v_days) group by e.event_at::date
    ) x),
    'subscription_events',(select coalesce(jsonb_agg(to_jsonb(x) order by x.event_at desc),'[]'::jsonb) from (
      select e.event_type,e.event_at,e.expires_at from public.pro_subscription_analytics_events e
      where v_days=0 or e.event_at >= now()-make_interval(days=>v_days)
      order by e.event_at desc limit 100
    ) x)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.get_book_commercial_analytics(integer) from public,anon;
grant execute on function public.get_book_commercial_analytics(integer) to authenticated;
notify pgrst,'reload schema';
commit;