# BookCheef automation — operating guide

## Management through ChatGPT

The user continues to manage the system by describing changes in the BookCheef chat. The assistant is responsible for editing the repository configuration, prompts, validation code, and GitHub Actions workflows, then checking the resulting run. The user should not need to edit YAML, JavaScript, or JSON manually.

## Source of truth

- `book-publications/automation-config.json` — schedules, rotation, provider selection, image limits, validation and failure policy.
- `book-publications/rotation-state.json` — current rotation position and last verified publication.
- `book-publications/authors/*.json` — author voice and series continuity.
- `book-publications/drafts/last-day-of-universe/` — the separate Cursor-only long novel.
- `.github/workflows/generate-daily-book.yml` — daily book orchestration.
- `.github/workflows/publish-book.yml` — image generation, staged Storage uploads and publication.
- `.github/workflows/generate-next-novel-chapter.yml` — Cursor-only novel chapter workflow.

## Daily book flow

1. GitHub Actions starts the daily workflow at 01:10 Europe/Berlin.
2. The workflow scans the inbox and checks each publication key against Supabase. An unpublished package is resumed before creating a new book.
3. If there is no pending package, OpenRouter's free router generates one book using the current rotation slot and existing author bibles.
4. The package is validated and committed to the inbox.
5. The publisher generates the complete image set with Cloudflare Workers AI, falling back to OVHcloud SDXL if necessary.
6. Each image is uploaded to Supabase Storage in a separate request. The final publication request contains public image URLs rather than a large base64 payload.
7. The publisher inserts the book. A separate verification step checks the Supabase row, all public image URLs, and that no illustration markers remain in reader content.
8. Only after verification does the workflow advance `rotation-state.json`.

## Failure behavior

- A failed generation does not create a publication package or advance rotation.
- A pending package is retried before generating another book.
- An image failure prevents publication.
- A failed publication keeps the package and publication key for retry.
- The rotation counter advances only after the database row and all image URLs are verified.
- Publication is idempotent by `publication_key`; retries must not create duplicate books.
- Existing books, images and Storage objects must never be deleted as part of recovery.

## Providers and credentials

- Text: OpenRouter free router, secret `OPENROUTER_API_KEY`.
- Images: Cloudflare Workers AI primary; OVHcloud SDXL free fallback.
- Publisher authorization: GitHub secret `BOOK_PUBLISHER_TOKEN`.
- Cursor is reserved exclusively for `Последний день Вселенной`; it must not generate daily catalog books.
- Secrets stay in GitHub/Supabase secret stores and must never be copied into repository files or chat messages.

## Safe migration

The former ChatGPT daily automation remains enabled until the GitHub pipeline has completed a real end-to-end test: generated package, successful publication, Supabase row verification, public image checks, rotation advancement and Telegram announcement. Only then may the old schedule be paused to prevent duplicate daily books.
