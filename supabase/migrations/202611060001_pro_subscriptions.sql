-- BookCheef Free + Pro subscriptions and promo codes
create table if not exists public.user_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  duration_months integer not null check (duration_months in (1,3,12)),
  max_uses integer,
  used_count integer not null default 0,
  created_at timestamptz not null default now(),
  check (max_uses is null or max_uses > 0)
);
create table if not exists public.promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  promo_code_id uuid not null references public.promo_codes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  unique(promo_code_id,user_id)
);
alter table public.user_subscriptions enable row level security;
alter table public.promo_codes enable row level security;
alter table public.promo_redemptions enable row level security;
drop policy if exists "Users read own subscription" on public.user_subscriptions;
create policy "Users read own subscription" on public.user_subscriptions for select to authenticated using(user_id=auth.uid());
drop policy if exists "Admins manage subscriptions" on public.user_subscriptions;
create policy "Admins manage subscriptions" on public.user_subscriptions for all to authenticated using(exists(select 1 from public.admins where user_id=auth.uid())) with check(exists(select 1 from public.admins where user_id=auth.uid()));
drop policy if exists "Admins read promo codes" on public.promo_codes;
create policy "Admins read promo codes" on public.promo_codes for select to authenticated using(exists(select 1 from public.admins where user_id=auth.uid()));
drop policy if exists "Admins create promo codes" on public.promo_codes;
create policy "Admins create promo codes" on public.promo_codes for insert to authenticated with check(exists(select 1 from public.admins where user_id=auth.uid()));
drop policy if exists "Admins delete promo codes" on public.promo_codes;
create policy "Admins delete promo codes" on public.promo_codes for delete to authenticated using(exists(select 1 from public.admins where user_id=auth.uid()));
drop policy if exists "Users read own promo redemptions" on public.promo_redemptions;
create policy "Users read own promo redemptions" on public.promo_redemptions for select to authenticated using(user_id=auth.uid());
create or replace function public.is_bookcheef_admin()
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.admins where user_id=auth.uid()); $$;
revoke all on function public.is_bookcheef_admin() from public;
grant execute on function public.is_bookcheef_admin() to anon, authenticated;
create or replace function public.get_my_subscription()
returns table(is_active boolean, expires_at timestamptz)
language sql stable security definer set search_path=public
as $$
  select coalesce(s.expires_at > now(),false), s.expires_at
  from (select auth.uid() as uid) u
  left join public.user_subscriptions s on s.user_id=u.uid
  where u.uid is not null;
$$;
revoke all on function public.get_my_subscription() from public;
grant execute on function public.get_my_subscription() to authenticated;
create or replace function public.activate_demo_subscription(months integer)
returns timestamptz language plpgsql security definer set search_path=public
as $$
declare expiry timestamptz;
begin
  if auth.uid() is null then raise exception 'Войдите в аккаунт.'; end if;
  if months not in (1,3,12) then raise exception 'Недопустимый срок подписки.'; end if;
  insert into public.user_subscriptions(user_id,expires_at)
  values(auth.uid(), now() + make_interval(months=>months))
  on conflict(user_id) do update
    set expires_at=greatest(public.user_subscriptions.expires_at,now()) + make_interval(months=>months),
        updated_at=now()
  returning expires_at into expiry;
  return expiry;
end;
$$;
revoke all on function public.activate_demo_subscription(integer) from public;
grant execute on function public.activate_demo_subscription(integer) to authenticated;
create or replace function public.redeem_promo_code(input_code text)
returns timestamptz language plpgsql security definer set search_path=public
as $$
declare p public.promo_codes%rowtype; expiry timestamptz;
begin
  if auth.uid() is null then raise exception 'Войдите в аккаунт.'; end if;
  select * into p from public.promo_codes
    where upper(code)=upper(trim(input_code)) for update;
  if not found then raise exception 'Промокод не найден.'; end if;
  if p.max_uses is not null and p.used_count >= p.max_uses then raise exception 'Лимит активаций этого промокода исчерпан.'; end if;
  if exists(select 1 from public.promo_redemptions where promo_code_id=p.id and user_id=auth.uid()) then
    raise exception 'Вы уже активировали этот промокод.';
  end if;
  insert into public.promo_redemptions(promo_code_id,user_id) values(p.id,auth.uid());
  update public.promo_codes set used_count=used_count+1 where id=p.id;
  insert into public.user_subscriptions(user_id,expires_at)
  values(auth.uid(),now()+make_interval(months=>p.duration_months))
  on conflict(user_id) do update
    set expires_at=greatest(public.user_subscriptions.expires_at,now())+make_interval(months=>p.duration_months),
        updated_at=now()
  returning expires_at into expiry;
  return expiry;
end;
$$;
revoke all on function public.redeem_promo_code(text) from public;
grant execute on function public.redeem_promo_code(text) to authenticated;


-- Hide Pro book contents from unauthorised direct table reads.
drop policy if exists "Public can read books" on public.books;
drop policy if exists "Free or Pro subscribers read books" on public.books;
create policy "Free or Pro subscribers read books" on public.books for select using (
  public.is_bookcheef_admin()
  or is_free = true
  or exists (
    select 1 from public.user_subscriptions s
    where s.user_id = auth.uid() and s.expires_at > now()
  )
);
create or replace view public.book_catalog
with (security_barrier=true)
as
select id,title,description,cover_url,author,age,genre,series,is_free,is_interactive,views,created_at
from public.books;
grant select on public.book_catalog to anon, authenticated;
create or replace function public.get_book_content(target_book_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public
as $$
declare result jsonb;
begin
  select to_jsonb(b) into result from public.books b
  where b.id=target_book_id
    and (
      b.is_free=true
      or public.is_bookcheef_admin()
      or exists(select 1 from public.user_subscriptions s where s.user_id=auth.uid() and s.expires_at>now())
    );
  if result is null then raise exception 'Книга доступна только по подписке Pro.'; end if;
  return result;
end;
$$;
revoke all on function public.get_book_content(uuid) from public;
grant execute on function public.get_book_content(uuid) to anon, authenticated;
