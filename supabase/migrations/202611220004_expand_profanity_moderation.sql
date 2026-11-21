-- Expand automatic profanity filtering for all human and automated book reviews/replies.
-- Every detected profane word is replaced with exactly four asterisks.
create or replace function public.moderate_book_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  nm text;
  bad text[] := array[
    'хуй[а-яё]*','ху[яеиюй][а-яё]*','пизд[а-яё]*','ёб[а-яё]*','еб[а-яё]*',
    'заеб[а-яё]*','наеб[а-яё]*','выеб[а-яё]*','въеб[а-яё]*','уеб[а-яё]*',
    'отъеб[а-яё]*','отеб[а-яё]*','проеб[а-яё]*','разъеб[а-яё]*','доеб[а-яё]*',
    'бля[а-яё]*','бляд[а-яё]*','муд[а-яё]*','гандон[а-яё]*','залуп[а-яё]*',
    'сук[аи][а-яё]*','нах[уи][йяею][а-яё]*','пох[уи][йяею][а-яё]*',
    'дерьм[а-яё]*','говн[а-яё]*','сран[а-яё]*','жоп[а-яё]*','шлюх[а-яё]*',
    'пид[а-яё]*','педик[а-яё]*','манда[а-яё]*',
    'fuck[[:alnum:]_]*','shit[[:alnum:]_]*','bitch[[:alnum:]_]*',
    'asshole[[:alnum:]_]*','motherfucker[[:alnum:]_]*','dick[[:alnum:]_]*',
    'cunt[[:alnum:]_]*','bastard[[:alnum:]_]*','bullshit[[:alnum:]_]*'
  ];
  w text;
begin
  if new.user_id is not null then
    select raw_user_meta_data into meta from auth.users where id = new.user_id;
    nm := coalesce(nullif(btrim(meta->>'display_name'), ''), nullif(btrim(meta->>'full_name'), ''), nullif(btrim(meta->>'name'), ''));
    if nm is null then
      select split_part(email, '@', 1) into nm from auth.users where id = new.user_id;
    end if;
    new.author_name := left(coalesce(nullif(nm, ''), 'Читатель'), 60);
    new.bot_profile_id := null;
    new.is_automated := false;
  else
    select display_name into new.author_name
      from public.book_bot_profiles where id = new.bot_profile_id and is_active;
    if new.author_name is null then raise exception 'Неизвестный автоучастник'; end if;
    new.is_automated := true;
  end if;

  if new.parent_id is not null and not exists (
    select 1 from public.book_reviews p where p.id = new.parent_id and p.book_id = new.book_id
  ) then
    raise exception 'Ответ должен относиться к той же книге';
  end if;

  foreach w in array bad loop
    if new.body ~* ('(^|[^[:alnum:]_])(' || w || ')([^[:alnum:]_]|$)') then
      new.body := regexp_replace(new.body, '(^|[^[:alnum:]_])(' || w || ')([^[:alnum:]_]|$)', '\1****\3', 'gi');
      new.moderation_status := 'censored';
    end if;
  end loop;

  new.updated_at := now();
  return new;
end
$function$;
