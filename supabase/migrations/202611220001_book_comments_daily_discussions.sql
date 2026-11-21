-- BookCheef discussion schema. The live database migration was applied separately.
begin;
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
create table if not exists public.book_bot_profiles(id uuid primary key default gen_random_uuid(),display_name text not null unique,avatar text not null default '📚',persona text not null default '',disclosure_label text not null default 'Автоучастник' check(disclosure_label='Автоучастник'),is_active boolean not null default true,created_at timestamptz not null default now());
alter table public.book_bot_profiles enable row level security;
revoke all on public.book_bot_profiles from public,anon,authenticated;
grant select on public.book_bot_profiles to anon,authenticated;
drop policy if exists "Public can read bot profiles" on public.book_bot_profiles;
create policy "Public can read bot profiles" on public.book_bot_profiles for select to anon,authenticated using(true);
insert into public.book_bot_profiles(display_name,avatar,persona) values('Марк','🦊','Любит приключения'),('Алиса','🌿','Замечает детали'),('Илья','🚀','Задаёт вопросы'),('Соня','🦉','Ценит атмосферу'),('Денис','🐺','Критично оценивает сюжет'),('Лера','🌸','Поддерживает авторов') on conflict(display_name) do update set avatar=excluded.avatar,persona=excluded.persona,disclosure_label='Автоучастник';
create table if not exists public.book_comments(id uuid primary key default gen_random_uuid(),book_id uuid not null references public.books(id) on delete cascade,user_id uuid references auth.users(id) on delete set null,bot_profile_id uuid references public.book_bot_profiles(id) on delete cascade,parent_id uuid references public.book_comments(id) on delete cascade,author_name text not null default 'Читатель',body text not null check(char_length(btrim(body)) between 1 and 2000),moderation_status text not null default 'visible' check(moderation_status in('visible','censored','hidden')),is_automated boolean not null default false,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),constraint book_comments_exactly_one_author check((user_id is not null and bot_profile_id is null and is_automated=false) or (user_id is null and bot_profile_id is not null and is_automated=true)));
create index if not exists book_comments_book_created_idx on public.book_comments(book_id,created_at);
create index if not exists book_comments_parent_idx on public.book_comments(parent_id,created_at);
alter table public.book_comments enable row level security;
revoke all on public.book_comments from public,anon,authenticated;
grant select on public.book_comments to anon,authenticated;
grant insert,delete on public.book_comments to authenticated;
drop policy if exists "Anyone can read visible book comments" on public.book_comments;
create policy "Anyone can read visible book comments" on public.book_comments for select to anon,authenticated using(moderation_status<>'hidden');
drop policy if exists "Users create own book comments" on public.book_comments;
create policy "Users create own book comments" on public.book_comments for insert to authenticated with check(user_id=(select auth.uid()) and bot_profile_id is null and is_automated=false);
drop policy if exists "Authors and admins delete book comments" on public.book_comments;
create policy "Authors and admins delete book comments" on public.book_comments for delete to authenticated using(user_id=(select auth.uid()) or public.is_bookcheef_admin());
create table if not exists public.book_comment_votes(comment_id uuid not null references public.book_comments(id) on delete cascade,user_id uuid not null references auth.users(id) on delete cascade,vote smallint not null check(vote in(-1,1)),created_at timestamptz not null default now(),primary key(comment_id,user_id));
alter table public.book_comment_votes enable row level security;
revoke all on public.book_comment_votes from public,anon,authenticated;
grant select on public.book_comment_votes to anon,authenticated;
grant insert,update,delete on public.book_comment_votes to authenticated;
drop policy if exists "Anyone can read comment votes" on public.book_comment_votes;
create policy "Anyone can read comment votes" on public.book_comment_votes for select to anon,authenticated using(true);
drop policy if exists "Users cast own comment votes" on public.book_comment_votes;
create policy "Users cast own comment votes" on public.book_comment_votes for insert to authenticated with check(user_id=(select auth.uid()));
drop policy if exists "Users update own comment votes" on public.book_comment_votes;
create policy "Users update own comment votes" on public.book_comment_votes for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
drop policy if exists "Users remove own comment votes" on public.book_comment_votes;
create policy "Users remove own comment votes" on public.book_comment_votes for delete to authenticated using(user_id=(select auth.uid()));
create or replace function public.moderate_book_comment() returns trigger language plpgsql security definer set search_path='' as $$
declare meta jsonb; display_name text; profanity text[]:=array['хуй','хуя','хуе','хуи','пизд','еба','ебу','ебл','бля','бляд','муд','гандон','залуп','сук[аи]','нах[уи]й','пох[уи]й','fuck','fucker','fucking','shit','bitch','asshole','motherfucker']; word text;
begin
 if new.user_id is not null then select u.raw_user_meta_data into meta from auth.users u where u.id=new.user_id; display_name:=coalesce(nullif(btrim(meta->>'display_name'),''),nullif(btrim(meta->>'full_name'),''),nullif(btrim(meta->>'name'),'')); if display_name is null then select split_part(u.email,'@',1) into display_name from auth.users u where u.id=new.user_id; end if; new.author_name:=left(coalesce(nullif(display_name,''),'Читатель'),60); new.is_automated:=false; new.bot_profile_id:=null;
 else select p.display_name into new.author_name from public.book_bot_profiles p where p.id=new.bot_profile_id and p.is_active; if new.author_name is null then raise exception 'Неизвестный автоучастник'; end if; new.is_automated:=true; end if;
 if new.parent_id is not null and not exists(select 1 from public.book_comments p where p.id=new.parent_id and p.book_id=new.book_id) then raise exception 'Ответ должен относиться к той же книге'; end if;
 foreach word in array profanity loop if new.body ~* ('(^|[^[:alnum:]_])('||word||')([^[:alnum:]_]|$)') then new.body:=regexp_replace(new.body,'(^|[^[:alnum:]_])('||word||')([^[:alnum:]_]|$)','\1***\3','gi');new.moderation_status:='censored';end if;end loop;
 new.updated_at:=now();return new;
end $$;
revoke all on function public.moderate_book_comment() from public,anon,authenticated;
drop trigger if exists moderate_book_comment_trigger on public.book_comments;
create trigger moderate_book_comment_trigger before insert or update on public.book_comments for each row execute function public.moderate_book_comment();
create or replace function public.prevent_self_comment_vote() returns trigger language plpgsql set search_path='' as $$ begin if exists(select 1 from public.book_comments c where c.id=new.comment_id and c.user_id=new.user_id) then raise exception 'Нельзя оценивать собственный комментарий';end if;return new;end $$;
revoke all on function public.prevent_self_comment_vote() from public,anon,authenticated;
drop trigger if exists prevent_self_comment_vote_trigger on public.book_comment_votes;
create trigger prevent_self_comment_vote_trigger before insert or update on public.book_comment_votes for each row execute function public.prevent_self_comment_vote();
create or replace function public.vote_book_comment(p_comment_id uuid,p_vote smallint) returns void language plpgsql set search_path='' as $$ declare existing smallint;begin if auth.uid() is null then raise exception 'Войдите в аккаунт';end if;if p_vote not in(-1,1) then raise exception 'Недопустимая оценка';end if;select v.vote into existing from public.book_comment_votes v where v.comment_id=p_comment_id and v.user_id=auth.uid();if existing=p_vote then delete from public.book_comment_votes where comment_id=p_comment_id and user_id=auth.uid();else insert into public.book_comment_votes(comment_id,user_id,vote) values(p_comment_id,auth.uid(),p_vote) on conflict(comment_id,user_id) do update set vote=excluded.vote,created_at=now();end if;end $$;
revoke all on function public.vote_book_comment(uuid,smallint) from public,anon;
grant execute on function public.vote_book_comment(uuid,smallint) to authenticated;
create or replace function public.get_book_comments(p_book_id uuid) returns table(id uuid,book_id uuid,user_id uuid,parent_id uuid,author_name text,body text,moderation_status text,is_automated boolean,bot_avatar text,bot_label text,created_at timestamptz,likes bigint,dislikes bigint,my_vote smallint,author_points bigint,author_rank text) language sql stable set search_path='' as $$
 with scores as(select c.user_id,count(*)::bigint comments,coalesce(sum(coalesce(vs.net,0)),0)::bigint votes,count(*) filter(where coalesce(vs.net,0)>=2)::bigint helpful from public.book_comments c left join lateral(select count(*) filter(where vote=1)-count(*) filter(where vote=-1) net from public.book_comment_votes where comment_id=c.id)vs on true where c.user_id is not null and c.moderation_status<>'hidden' group by c.user_id),
 rows as(select c.*,p.avatar,(select count(*) from public.book_comment_votes v where v.comment_id=c.id and v.vote=1) likes,(select count(*) from public.book_comment_votes v where v.comment_id=c.id and v.vote=-1) dislikes,(select v.vote from public.book_comment_votes v where v.comment_id=c.id and v.user_id=auth.uid()) my_vote,coalesce(s.comments+s.votes+s.helpful*2,0)::bigint points from public.book_comments c left join public.book_bot_profiles p on p.id=c.bot_profile_id left join scores s on s.user_id=c.user_id where c.book_id=p_book_id and c.moderation_status<>'hidden')
 select r.id,r.book_id,r.user_id,r.parent_id,r.author_name,r.body,r.moderation_status,r.is_automated,r.avatar,case when r.is_automated then 'Автоучастник' else null end,r.created_at,r.likes,r.dislikes,r.my_vote,r.points,case when r.is_automated then 'Автоучастник' when r.points>=100 then 'Книжный эксперт' when r.points>=50 then 'Критик' when r.points>=20 then 'Рецензент' when r.points>=5 then 'Активный читатель' else 'Читатель' end from rows r order by r.created_at asc $$;
grant execute on function public.get_book_comments(uuid) to anon,authenticated;
create table if not exists public.book_bot_daily_runs(run_date date primary key,comments_created integer not null default 0,created_at timestamptz not null default now());
alter table public.book_bot_daily_runs enable row level security;
revoke all on public.book_bot_daily_runs from public,anon,authenticated;
create or replace function public.generate_daily_book_discussion() returns integer language plpgsql security definer set search_path='' as $$
declare chosen_book uuid;bot_a uuid;bot_b uuid;bot_c uuid;first_id uuid;inserted integer:=0;phrases text[]:=array['Мне понравилось, как автор постепенно раскрывает героев. После этой главы хочется читать дальше.','А мне кажется, середина немного затянута. Сюжет интересный, но темп можно было сделать бодрее.','Не совсем согласен: спокойные главы помогают лучше понять персонажей.','Какая деталь в этой истории показалась вам самой важной?','Отдельно отмечу атмосферу и описания. Легко представить происходящее.','Книга оставила смешанное впечатление: сильная идея, но некоторые моменты хотелось бы раскрыть подробнее.','Хорошая история для обсуждения. У разных читателей будут разные трактовки.','Мне понравилась задумка, хотя финал хотелось бы чуть подробнее.'];
begin if exists(select 1 from public.book_bot_daily_runs where run_date=current_date) then return 0;end if;select b.id into chosen_book from public.books b order by random() limit 1;if chosen_book is null then return 0;end if;select id into bot_a from public.book_bot_profiles where is_active order by random() limit 1;select id into bot_b from public.book_bot_profiles where is_active and id<>bot_a order by random() limit 1;select id into bot_c from public.book_bot_profiles where is_active and id not in(bot_a,bot_b) order by random() limit 1;if bot_a is null or bot_b is null or bot_c is null then return 0;end if;
 insert into public.book_comments(book_id,bot_profile_id,author_name,body,is_automated) values(chosen_book,bot_a,'Автоучастник',phrases[1+floor(random()*array_length(phrases,1))::int],true) returning id into first_id;inserted:=inserted+1;
 insert into public.book_comments(book_id,bot_profile_id,author_name,body,is_automated) values(chosen_book,bot_b,'Автоучастник',phrases[1+floor(random()*array_length(phrases,1))::int],true);inserted:=inserted+1;
 insert into public.book_comments(book_id,bot_profile_id,parent_id,author_name,body,is_automated) values(chosen_book,bot_c,first_id,'Автоучастник','Интересно, что мнения разделились. Я бы ещё обсудил мотивацию главного героя и то, как она меняется к финалу.',true);inserted:=inserted+1;
 insert into public.book_bot_daily_runs(run_date,comments_created) values(current_date,inserted) on conflict(run_date) do nothing;return inserted;end $$;
revoke all on function public.generate_daily_book_discussion() from public,anon,authenticated;
do $$ begin if not exists(select 1 from cron.job where jobname='bookcheef-daily-discussions') then perform cron.schedule('bookcheef-daily-discussions','15 9 * * *','select public.generate_daily_book_discussion();');end if;end $$;
commit;
notify pgrst,'reload schema';