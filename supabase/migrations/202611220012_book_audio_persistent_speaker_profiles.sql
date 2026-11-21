alter table public.book_audio_settings
  add column if not exists speaker_profiles jsonb not null default '{}'::jsonb;
