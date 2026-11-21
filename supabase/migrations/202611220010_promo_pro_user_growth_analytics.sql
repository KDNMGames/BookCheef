-- Promo, Pro subscription and user growth analytics.
begin;

alter table public.user_profiles add column if not exists last_active_at timestamptz;
update public.user_profiles p
set last_active_at=u.last_sign_in_at
from auth.users u
where u.id=p.user_id and p.last_active_at is null and u.last_sign_in_at is not null;

alter table public.pro_subscription_analytics_events
  drop constraint if exists pro_subscription_analytics_events_event_type_check;
alter table public.pro_subscription_analytics_events
  add constraint pro_subscription_analytics_events_event_type_check
  check (event_type=any(array['activated','renewed','reactivated','expired','legacy_active']));

create table if not exists public.user_activity_daily(
 user_id uuid not null references auth.users(id) on delete cascade,
 activity_date date not null default current_date,
 last_seen_at timestamptz not null default now(),
 primary key(user_id,activity_date)
);
create index if not exists user_activity_daily_date_idx on public.user_activity_daily(activity_date desc);
alter table public.user_activity_daily enable row level security;
revoke all on table public.user_activity_daily from public,anon,authenticated;

create table if not exists public.user_lifecycle_analytics_events(
 id bigint generated always as identity primary key,
 event_type text not null check(event_type in ('deleted')),
 event_at timestamptz not null default now(),
 created_at timestamptz not null default now()
);
create index if not exists user_lifecycle_analytics_events_at_idx on public.user_lifecycle_analytics_events(event_at desc);
alter table public.user_lifecycle_analytics_events enable row level security;
revoke all on table public.user_lifecycle_analytics_events from public,anon,authenticated;

create or replace function public.track_user_activity()
returns void language plpgsql security definer set search_path=''
as $function$
declare v_user uuid:=auth.uid(); v_now timestamptz:=now();
begin
 if v_user is null then return; end if;
 if exists(select 1 from public.user_activity_daily a where a.user_id=v_user and a.activity_date=(v_now at time zone 'utc')::date and a.last_seen_at>v_now-interval '30 minutes') then return; end if;
 insert into public.user_activity_daily(user_id,activity_date,last_seen_at) values(v_user,(v_now at time zone 'utc')::date,v_now)
 on conflict(user_id,activity_date) do update set last_seen_at=excluded.last_seen_at;
 insert into public.user_profiles(user_id,last_active_at) values(v_user,v_now)
 on conflict(user_id) do update set last_active_at=excluded.last_active_at
 where public.user_profiles.last_active_at is null or public.user_profiles.last_active_at<v_now-interval '30 minutes';
end;
$function$;
revoke all on function public.track_user_activity() from public,anon;
grant execute on function public.track_user_activity() to authenticated;

create or replace function public.log_user_deletion_for_analytics()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
 insert into public.user_lifecycle_analytics_events(event_type,event_at) values('deleted',now());
 return old;
end;
$function$;
revoke all on function public.log_user_deletion_for_analytics() from public,anon,authenticated;
drop trigger if exists trg_log_user_deletion_for_analytics on auth.users;
create trigger trg_log_user_deletion_for_analytics after delete on auth.users
for each row execute function public.log_user_deletion_for_analytics();

-- Existing Pro subscriptions are a baseline, not fabricated historical activations.
insert into public.pro_subscription_analytics_events(user_id,event_type,expires_at,event_at)
select s.user_id,'legacy_active',s.expires_at,s.updated_at
from public.user_subscriptions s where s.expires_at>now()
on conflict(user_id,event_type,expires_at) do nothing;

create or replace function public.get_growth_analytics_dashboard(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare v_days integer:=greatest(7,least(coalesce(p_days,30),365)); v_result jsonb;
begin
 if not coalesce(public.is_bookcheef_admin(),false) then
  raise exception 'Недостаточно прав для просмотра аналитики' using errcode='42501';
 end if;
 with users_base as (
  select u.id,u.created_at,coalesce(p.last_active_at,u.last_sign_in_at,u.created_at) as last_active_at
  from auth.users u left join public.user_profiles p on p.user_id=u.id
 ), promo_rows as (
  select pc.id,pc.code,pc.duration_months,pc.max_uses,pc.used_count,
   count(pr.id)::bigint as redemption_count,count(distinct pr.user_id)::bigint as unique_users,
   max(pr.redeemed_at) as last_redeemed,
   (count(pr.id) filter(where pr.redeemed_at>=now()-make_interval(days=>v_days)))::bigint as recent_redemptions
  from public.promo_codes pc left join public.promo_redemptions pr on pr.promo_code_id=pc.id group by pc.id
 ), pro_daily as (
  select e.event_at::date as event_date,
   (count(*) filter(where e.event_type in ('activated','reactivated')))::bigint as incoming,
   (count(*) filter(where e.event_type='renewed'))::bigint as renewals,
   (count(*) filter(where e.event_type='expired'))::bigint as outgoing
  from public.pro_subscription_analytics_events e where e.event_at>=current_date-29 group by e.event_at::date
 ), user_daily as (
  select d.calendar_date::date as calendar_date,
   (select count(*) from auth.users u where u.created_at>=d.calendar_date and u.created_at<d.calendar_date+interval '1 day')::bigint as signups,
   (select count(*) from public.user_lifecycle_analytics_events e where e.event_at>=d.calendar_date and e.event_at<d.calendar_date+interval '1 day' and e.event_type='deleted')::bigint as deletions,
   (select count(*) from public.user_activity_daily a where a.activity_date=d.calendar_date::date)::bigint as active_users
  from generate_series(current_date-29,current_date,interval '1 day') as d(calendar_date)
 )
 select jsonb_build_object(
  'period_days',v_days,
  'promo_codes',coalesce((select jsonb_agg(jsonb_build_object('code',p.code,'duration_months',p.duration_months,'max_uses',p.max_uses,'used_count',p.used_count,'redemption_count',p.redemption_count,'unique_users',p.unique_users,'recent_redemptions',p.recent_redemptions,'last_redeemed',p.last_redeemed) order by p.redemption_count desc,p.code) from promo_rows p),'[]'::jsonb),
  'promo_totals',jsonb_build_object(
   'codes',(select count(*) from public.promo_codes),
   'redemptions',(select count(*) from public.promo_redemptions),
   'unique_users',(select count(distinct user_id) from public.promo_redemptions),
   'recent_redemptions',(select count(*) from public.promo_redemptions where redeemed_at>=now()-make_interval(days=>v_days))
  ),
  'pro_summary',jsonb_build_object(
   'active_subscribers',(select count(*) from public.user_subscriptions where expires_at>now()),
   'expired_subscribers',(select count(*) from public.user_subscriptions where expires_at<=now()),
   'incoming',(select count(*) from public.pro_subscription_analytics_events where event_type in ('activated','reactivated') and event_at>=now()-make_interval(days=>v_days)),
   'new_activations',(select count(*) from public.pro_subscription_analytics_events where event_type='activated' and event_at>=now()-make_interval(days=>v_days)),
   'reactivations',(select count(*) from public.pro_subscription_analytics_events where event_type='reactivated' and event_at>=now()-make_interval(days=>v_days)),
   'renewals',(select count(*) from public.pro_subscription_analytics_events where event_type='renewed' and event_at>=now()-make_interval(days=>v_days)),
   'outgoing',(select count(*) from public.pro_subscription_analytics_events where event_type='expired' and event_at>=now()-make_interval(days=>v_days)),
   'legacy_active',(select count(*) from public.pro_subscription_analytics_events where event_type='legacy_active')
  ),
  'pro_events',coalesce((select jsonb_agg(jsonb_build_object('event_type',e.event_type,'event_count',e.event_count,'unique_users',e.unique_users,'last_event',e.last_event) order by e.event_count desc) from (
   select event_type,count(*)::bigint as event_count,count(distinct user_id)::bigint as unique_users,max(event_at) as last_event
   from public.pro_subscription_analytics_events where event_at>=now()-make_interval(days=>v_days) group by event_type
  ) e),'[]'::jsonb),
  'pro_daily',coalesce((select jsonb_agg(jsonb_build_object('date',d.calendar_date::date,'incoming',coalesce(p.incoming,0),'renewals',coalesce(p.renewals,0),'outgoing',coalesce(p.outgoing,0)) order by d.calendar_date)
   from generate_series(current_date-29,current_date,interval '1 day') as d(calendar_date) left join pro_daily p on p.event_date=d.calendar_date::date),'[]'::jsonb),
  'user_summary',jsonb_build_object(
   'total_users',(select count(*) from users_base),
   'new_users',(select count(*) from users_base where created_at>=now()-make_interval(days=>v_days)),
   'active_7d',(select count(*) from users_base where last_active_at>=now()-interval '7 days'),
   'active_30d',(select count(*) from users_base where last_active_at>=now()-interval '30 days'),
   'inactive_30d',(select count(*) from users_base where last_active_at<now()-interval '30 days'),
   'inactive_90d',(select count(*) from users_base where last_active_at<now()-interval '90 days'),
   'deleted_users',(select count(*) from public.user_lifecycle_analytics_events where event_type='deleted' and event_at>=now()-make_interval(days=>v_days))
  ),
  'user_daily',coalesce((select jsonb_agg(jsonb_build_object('date',d.calendar_date,'signups',d.signups,'deletions',d.deletions,'active_users',d.active_users) order by d.calendar_date) from user_daily d),'[]'::jsonb)
 ) into v_result;
 return v_result;
end;
$function$;
revoke all on function public.get_growth_analytics_dashboard(integer) from public,anon;
grant execute on function public.get_growth_analytics_dashboard(integer) to authenticated;

do $$
begin
 if not exists(select 1 from cron.job where jobname='bookcheef-user-activity-retention') then
  perform cron.schedule('bookcheef-user-activity-retention','45 6 * * *',$job$delete from public.user_activity_daily where activity_date<current_date-90;$job$);
 end if;
end;
$$;
notify pgrst,'reload schema';
commit;
