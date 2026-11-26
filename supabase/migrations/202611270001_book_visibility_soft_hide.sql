alter table public.books add column if not exists is_hidden boolean not null default false;

create or replace view public.book_catalog as
select id, title, description, cover_url, author, age, genre, series,
       is_free, is_interactive, views, created_at
from public.books
where coalesce(is_hidden, false) = false;

create or replace function public.get_book_content(target_book_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare result jsonb;
begin
  select to_jsonb(b) into result
  from public.books b
  where b.id = target_book_id
    and (
      public.is_bookcheef_admin()
      or (
        coalesce(b.is_hidden, false) = false
        and (
          b.is_free = true
          or public.has_active_pro_subscription()
        )
      )
    );
  if result is null then
    raise exception 'Книга недоступна или скрыта.';
  end if;
  return result;
end;
$function$;

create or replace function public.increment_book_view(p_book_id uuid, p_visitor_key uuid default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare new_views bigint; effective_visitor uuid;
begin
  effective_visitor := coalesce(p_visitor_key, auth.uid(), gen_random_uuid());
  update public.books
     set views = coalesce(views, 0) + 1
   where id = p_book_id
     and coalesce(is_hidden, false) = false
  returning views into new_views;
  if new_views is null then return null; end if;
  insert into public.book_analytics_events(book_id, user_id, visitor_key)
  values (p_book_id, auth.uid(), effective_visitor)
  on conflict (book_id, visitor_key, viewed_on) do nothing;
  return new_views;
end;
$function$;

notify pgrst, 'reload schema';
