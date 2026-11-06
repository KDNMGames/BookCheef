-- BookCheef subscription and private book-file hardening
-- Removes the public self-service demo upgrade and makes book documents private.

drop function if exists public.activate_demo_subscription(integer);

alter table public.books
  add column if not exists book_file_path text;

-- Keep the public gallery for covers and decorative illustrations.
-- Book documents must be uploaded to this separate private bucket.
insert into storage.buckets (id, name, public, file_size_limit)
values ('book-files', 'book-files', false, 52428800)
on conflict (id) do update
  set public = false,
      file_size_limit = 52428800;

drop policy if exists "Book files readable by entitled readers" on storage.objects;
create policy "Book files readable by entitled readers"
on storage.objects for select
to anon, authenticated
using (
  bucket_id = 'book-files'
  and exists (
    select 1
    from public.books b
    where b.id::text = (storage.foldername(name))[1]
      and (
        b.is_free = true
        or public.is_bookcheef_admin()
        or public.has_active_pro_subscription()
      )
  )
);

drop policy if exists "Admins upload private book files" on storage.objects;
create policy "Admins upload private book files"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'book-files'
  and public.is_bookcheef_admin()
  and (storage.foldername(name))[1] is not null
);

drop policy if exists "Admins update private book files" on storage.objects;
create policy "Admins update private book files"
on storage.objects for update
to authenticated
using (bucket_id = 'book-files' and public.is_bookcheef_admin())
with check (bucket_id = 'book-files' and public.is_bookcheef_admin());

drop policy if exists "Admins delete private book files" on storage.objects;
create policy "Admins delete private book files"
on storage.objects for delete
to authenticated
using (bucket_id = 'book-files' and public.is_bookcheef_admin());

-- A direct PostgREST request must never return a paid book to an unentitled user.
drop policy if exists "Free or Pro subscribers read books" on public.books;
create policy "Free or Pro subscribers read books"
on public.books for select
to anon, authenticated
using (
  is_free = true
  or public.is_bookcheef_admin()
  or public.has_active_pro_subscription()
);

-- Do not expose subscription management or promo administration to anonymous clients.
revoke all on public.user_subscriptions from anon;
grant select, insert, update, delete on public.user_subscriptions to authenticated;
revoke all on public.promo_codes from anon;
grant select, insert, delete on public.promo_codes to authenticated;
revoke all on public.promo_redemptions from anon;
grant select on public.promo_redemptions to authenticated;

-- Return book data only after checking the entitlement on the database.
-- The legacy public URL is deliberately omitted; new documents use book_file_path.
create or replace function public.get_book_content(target_book_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  select to_jsonb(b) - 'book_file_url'
    into result
  from public.books b
  where b.id = target_book_id
    and (
      b.is_free = true
      or public.is_bookcheef_admin()
      or public.has_active_pro_subscription()
    );

  if result is null then
    raise exception 'Книга доступна только по подписке Pro.';
  end if;

  return result;
end;
$$;

revoke all on function public.get_book_content(uuid) from public;
grant execute on function public.get_book_content(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
