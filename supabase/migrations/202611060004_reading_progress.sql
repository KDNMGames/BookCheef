-- Store the last reading position for each user's book.
-- Progress is intentionally JSONB so the same field can hold scroll position,
-- chapter/page metadata, or an interactive story node without duplicating columns.
ALTER TABLE public.user_reading_history
  ADD COLUMN IF NOT EXISTS reading_progress jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.user_reading_history.reading_progress IS
  'Last reading position for this user and book (e.g. scrollY, chapter, page, interactive node).';

NOTIFY pgrst, 'reload schema';
