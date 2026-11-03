-- BookCheef: поддержка загружаемых документов книг
alter table public.books
  add column if not exists book_file_url text,
  add column if not exists book_file_name text,
  add column if not exists book_file_type text;
