-- Consolidate the discussion stream into book_reviews. Existing bot posts are
-- copied with their UUIDs so reply parent_id links remain valid.
begin;
alter table public.book_reviews alter column user_id drop not null;
alter table public.book_reviews drop constraint if exists book_reviews_book_id_user_id_key;
alter table public.book_reviews add column if not exists bot_profile_id uuid references public.book_bot_profiles(id) on delete cascade;
alter table public.book_reviews add column if not exists parent_id uuid references public.book_reviews(id) on delete cascade;
alter table public.book_reviews add column if not exists moderation_status text not null default 'visible';
alter table public.book_reviews add column if not exists is_automated boolean not null default false;
alter table public.book_reviews drop constraint if exists book_reviews_moderation_status_check;
alter table public.book_reviews add constraint book_reviews_moderation_status_check check(moderation_status in('visible','censored','hidden'));
alter table public.book_reviews drop constraint if exists book_reviews_author_identity_check;
alter table public.book_reviews add constraint book_reviews_author_identity_check check((user_id is not null and bot_profile_id is null and is_automated=false) or (user_id is null and bot_profile_id is not null and is_automated=true));
create index if not exists book_reviews_parent_created_idx on public.book_reviews(parent_id,created_at);
create index if not exists book_reviews_book_created_idx on public.book_reviews(book_id,created_at desc);
insert into public.book_reviews(id,book_id,user_id,bot_profile_id,parent_id,author_name,body,rating,moderation_status,is_automated,created_at,updated_at)
select c.id,c.book_id,null,c.bot_profile_id,c.parent_id,c.author_name,c.body,5,c.moderation_status,true,c.created_at,c.updated_at
from public.book_comments c where not exists(select 1 from public.book_reviews r where r.id=c.id)
order by (c.parent_id is not null),c.created_at;

create table if not exists public.book_review_votes(review_id uuid not null references public.book_reviews(id) on delete cascade,user_id uuid not null references auth.users(id) on delete cascade,vote smallint not null check(vote in(-1,1)),created_at timestamptz not null default now(),primary key(review_id,user_id));
alter table public.book_review_votes enable row level security;
revoke all on public.book_review_votes from public,anon,authenticated;
grant select on public.book_review_votes to anon,authenticated;
grant insert,update,delete on public.book_review_votes to authenticated;
drop policy if exists "Anyone can read review votes" on public.book_review_votes;
create policy "Anyone can read review votes" on public.book_review_votes for select to anon,authenticated using(true);
drop policy if exists "Users cast own review votes" on public.book_review_votes;
create policy "Users cast own review votes" on public.book_review_votes for insert to authenticated with check(user_id=(select auth.uid()));
drop policy if exists "Users update own review votes" on public.book_review_votes;
create policy "Users update own review votes" on public.book_review_votes for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
drop policy if exists "Users remove own review votes" on public.book_review_votes;
create policy "Users remove own review votes" on public.book_review_votes for delete to authenticated using(user_id=(select auth.uid()));

create or replace function public.moderate_book_review() returns trigger language plpgsql security definer set search_path='' as $$
declare meta jsonb;nm text;bad text[]:=array['хуй','хуя','хуе','хуи','пизд','еба','ебу','ебл','бля','бляд','муд','гандон','залуп','сук[аи]','нах[уи]й','пох[уи]й','fuck','fucker','fucking','shit','bitch','asshole','motherfucker'];w text;
begin
 if new.user_id is not null then
  select raw_user_meta_data into meta from auth.users where id=new.user_id;
  nm:=coalesce(nullif(btrim(meta->>'display_name'),''),nullif(btrim(meta->>'full_name'),''),nullif(btrim(meta->>'name'),''));
  if nm is null then select split_part(email,'@',1) into nm from auth.users where id=new.user_id;end if;
  new.author_name:=left(coalesce(nullif(nm,''),'Читатель'),60);new.bot_profile_id:=null;new.is_automated:=false;
 else
  select display_name into new.author_name from public.book_bot_profiles where id=new.bot_profile_id and is_active;
  if new.author_name is null then raise exception 'Неизвестный автоучастник';end if;new.is_automated:=true;
 end if;
 if new.parent_id is not null and not exists(select 1 from public.book_reviews p where p.id=new.parent_id and p.book_id=new.book_id) then raise exception 'Ответ должен относиться к той же книге';end if;
 foreach w in array bad loop
  if new.body ~* ('(^|[^[:alnum:]_])('||w||')([^[:alnum:]_]|$)') then new.body:=regexp_replace(new.body,'(^|[^[:alnum:]_])('||w||')([^[:alnum:]_]|$)','\\1***\\3','gi');new.moderation_status:='censored';end if;
 end loop;
 new.updated_at:=now();return new;
end $$;
revoke all on function public.moderate_book_review() from public,anon,authenticated;
drop trigger if exists moderate_book_review_trigger on public.book_reviews;
create trigger moderate_book_review_trigger before insert or update on public.book_reviews for each row execute function public.moderate_book_review();

create or replace function public.prevent_self_review_vote() returns trigger language plpgsql set search_path='' as $$
begin if exists(select 1 from public.book_reviews r where r.id=new.review_id and r.user_id=new.user_id) then raise exception 'Нельзя оценивать собственный отзыв';end if;return new;end $$;
revoke all on function public.prevent_self_review_vote() from public,anon,authenticated;
drop trigger if exists prevent_self_review_vote_trigger on public.book_review_votes;
create trigger prevent_self_review_vote_trigger before insert or update on public.book_review_votes for each row execute function public.prevent_self_review_vote();

create or replace function public.vote_book_review(p_review_id uuid,p_vote smallint) returns void language plpgsql set search_path='' as $$
declare old smallint;
begin
 if auth.uid() is null then raise exception 'Войдите в аккаунт';end if;
 if p_vote not in(-1,1) then raise exception 'Недопустимая оценка';end if;
 select vote into old from public.book_review_votes where review_id=p_review_id and user_id=auth.uid();
 if old=p_vote then delete from public.book_review_votes where review_id=p_review_id and user_id=auth.uid();
 else insert into public.book_review_votes(review_id,user_id,vote) values(p_review_id,auth.uid(),p_vote) on conflict(review_id,user_id) do update set vote=excluded.vote,created_at=now();end if;
end $$;
revoke all on function public.vote_book_review(uuid,smallint) from public,anon;
grant execute on function public.vote_book_review(uuid,smallint) to authenticated;

create or replace function public.get_book_reviews(p_book_id uuid)
returns table(id uuid,book_id uuid,user_id uuid,parent_id uuid,author_name text,body text,rating smallint,moderation_status text,is_automated boolean,bot_avatar text,created_at timestamptz,updated_at timestamptz,likes bigint,dislikes bigint,my_vote smallint,author_points bigint,author_rank text)
language sql stable set search_path='' as $$
with scores as(
 select r.user_id,count(*)::bigint n,coalesce(sum(coalesce(v.net,0)),0)::bigint pts,count(*) filter(where coalesce(v.net,0)>=2)::bigint helpful
 from public.book_reviews r left join lateral(select count(*) filter(where vote=1)-count(*) filter(where vote=-1) net from public.book_review_votes where review_id=r.id)v on true
 where r.user_id is not null and r.moderation_status<>'hidden' group by r.user_id
),rows as(
 select r.*,p.avatar,(select count(*) from public.book_review_votes x where x.review_id=r.id and x.vote=1) likes,(select count(*) from public.book_review_votes x where x.review_id=r.id and x.vote=-1) dislikes,(select x.vote from public.book_review_votes x where x.review_id=r.id and x.user_id=auth.uid()) my_vote,coalesce(s.n+s.pts+s.helpful*2,0)::bigint points
 from public.book_reviews r left join public.book_bot_profiles p on p.id=r.bot_profile_id left join scores s on s.user_id=r.user_id
 where r.book_id=p_book_id and r.moderation_status<>'hidden'
)
select r.id,r.book_id,r.user_id,r.parent_id,r.author_name,r.body,r.rating,r.moderation_status,r.is_automated,r.avatar,r.created_at,r.updated_at,r.likes,r.dislikes,r.my_vote,r.points,
case when r.is_automated then 'Автоучастник' when r.points>=100 then 'Книжный эксперт' when r.points>=50 then 'Критик' when r.points>=20 then 'Рецензент' when r.points>=5 then 'Активный читатель' else 'Читатель' end from rows r order by r.created_at desc
$$;
grant execute on function public.get_book_reviews(uuid) to anon,authenticated;

create table if not exists public.book_bot_daily_runs(run_date date primary key,comments_created integer not null default 0,created_at timestamptz not null default now());
alter table public.book_bot_daily_runs enable row level security;
revoke all on public.book_bot_daily_runs from public,anon,authenticated;
create or replace function public.generate_daily_book_reviews() returns integer language plpgsql security definer set search_path='' as $$
declare b uuid;a uuid;c uuid;d uuid;first uuid;n integer:=0;phrases text[]:=array['Мне понравилось, как автор постепенно раскрывает героев. После этой главы хочется читать дальше.','А мне кажется, середина немного затянута. Сюжет интересный, но темп можно было сделать бодрее.','Не совсем согласен: спокойные главы помогают лучше понять персонажей.','Какая деталь в этой истории показалась вам самой важной?','Отдельно отмечу атмосферу и описания. Легко представить происходящее.','Книга оставила смешанное впечатление: сильная идея, но некоторые моменты хотелось бы раскрыть подробнее.','Хорошая история для обсуждения. У разных читателей будут разные трактовки.','Мне понравилась задумка, хотя финал хотелось бы чуть подробнее.'];
begin
 if exists(select 1 from public.book_bot_daily_runs where run_date=current_date) then return 0;end if;
 select id into b from public.books order by random() limit 1;if b is null then return 0;end if;
 select id into a from public.book_bot_profiles where is_active order by random() limit 1;
 select id into c from public.book_bot_profiles where is_active and id<>a order by random() limit 1;
 select id into d from public.book_bot_profiles where is_active and id not in(a,c) order by random() limit 1;
 if a is null or c is null or d is null then return 0;end if;
 insert into public.book_reviews(book_id,user_id,bot_profile_id,author_name,body,rating,is_automated) values(b,null,a,'Автоучастник',phrases[1+floor(random()*array_length(phrases,1))::int],5,true) returning id into first;
 insert into public.book_reviews(book_id,user_id,bot_profile_id,author_name,body,rating,is_automated) values(b,null,c,'Автоучастник',phrases[1+floor(random()*array_length(phrases,1))::int],4,true);
 insert into public.book_reviews(book_id,user_id,bot_profile_id,parent_id,author_name,body,rating,is_automated) values(b,null,d,first,'Автоучастник','Интересно, что мнения разделились. Я бы ещё обсудил мотивацию главного героя и то, как она меняется к финалу.',5,true);
 n:=3;insert into public.book_bot_daily_runs(run_date,comments_created) values(current_date,n) on conflict(run_date) do nothing;return n;
end $$;
revoke all on function public.generate_daily_book_reviews() from public,anon,authenticated;
do $$ begin
 if exists(select 1 from cron.job where jobname='bookcheef-daily-discussions') then perform cron.unschedule(jobid) from cron.job where jobname='bookcheef-daily-discussions';end if;
 if not exists(select 1 from cron.job where jobname='bookcheef-daily-reviews') then perform cron.schedule('bookcheef-daily-reviews','15 6 * * *','select public.generate_daily_book_reviews();');end if;
end $$;
drop function if exists public.get_book_comments(uuid);
drop function if exists public.vote_book_comment(uuid,smallint);
drop function if exists public.generate_daily_book_discussion();
drop table if exists public.book_comment_votes cascade;
drop table if exists public.book_comments cascade;
commit;
notify pgrst,'reload schema';
