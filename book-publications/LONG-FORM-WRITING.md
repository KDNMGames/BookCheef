# BookCheef — long-form manuscript protocol

This protocol is for books explicitly requested as novels, sagas, or very large works (including a target comparable in scale to *War and Peace*). It supplements the existing publication package format; it does not change the reader or database schema.

## Scale targets

- Target manuscript: 500,000–600,000 words (configurable per request); never claim the target has been met without counting words in the assembled manuscript.
- Plan: 5 volumes, approximately 30–36 chapters per volume (about 150–180 chapters total).
- Typical chapter: 3,000–4,000 words. Chapter count and length may vary to serve the story.
- Build a substantial cast, several intersecting plotlines, a dated chronology, geography, social/historical rules, and a clear ending. Avoid padding and repetitive scenes.
- A long novel is an ordinary book unless the user explicitly requests interactive format. The existing interactive-book five-scene/image cap does not limit ordinary novels.

## Persistent draft layout

Use a stable ASCII slug derived from the publication key:
`book-publications/drafts/<slug>/manifest.json`
`book-publications/drafts/<slug>/chapters/volume-01-chapter-001.md` and so on.
`book-publications/drafts/<slug>/bible/world.md`
`book-publications/drafts/<slug>/bible/characters.md`
`book-publications/drafts/<slug>/bible/timeline.md`
`book-publications/drafts/<slug>/bible/plotlines.md`
`book-publications/drafts/<slug>/bible/style.md`

The manifest must record: title, publication_key, author, age, genre, series, target_word_count, current_word_count, volume_count, planned_chapters, completed_chapters (ordered list with path, title, word_count, short synopsis, status), next_chapter, current_status (planning/writing/revision/ready_to_publish), continuity_last_updated, and final_package_path. Keep every path ASCII/Latin.

## Resumable writing protocol

1. When long-form mode is requested, create the manuscript bible and a chapter-by-chapter outline before drafting. Each chapter entry has a purpose, viewpoint characters, conflict, turning point, continuity dependencies, and expected word range.
2. Write in bounded batches of at most TWO chapters per automation run. Aim for 3,000–4,000 words per chapter; do not sacrifice quality to hit a number. Never try to emit the entire novel in one response or one JSON payload.
3. Save each completed chapter as its own Markdown file immediately. Update manifest word counts, synopsis, completed_chapters and next_chapter in the same run. Commit/checkpoint after each batch. Do not overwrite a completed chapter unless a specific revision is required; preserve the previous content in a versioned backup file before revising.
4. At the beginning of every subsequent run, inspect all draft manifests. If a long-form draft is incomplete, resume the oldest active draft before starting another book. Read its bible, outline, latest chapter, and previous chapter summaries. Continue from next_chapter; never restart, rename the work, or silently discard saved chapters.
5. After each chapter, perform continuity checks against the bible and previous summaries: character identity/age/relationships, chronology, geography, established facts, unresolved plotlines, viewpoint, and consequences. Record a concise continuity note in the manifest or chapter synopsis. If a contradiction is found, fix the smallest relevant passage and preserve the prior version.
6. After every 5 chapters, do a structural review of pacing, voice, plotline balance, character development, and repetition. After each volume, review the volume arc and update the bible. Do not rewrite the entire manuscript in one pass.
7. When the target length is reached and all planned chapters are complete, run a final editorial audit: chronology, names, geography, motivations, plot resolution, repeated passages, chapter order, and word count. A novel is not complete merely because the outline is complete.
8. Assemble the final publication JSON only after the manuscript is complete and audited. Join chapters in planned order into the existing `book_content` Markdown field using `# Title`, `## Volume ...`, and `### Chapter ...`. Preserve full chapter text without summarizing or truncating it. Include the usual metadata, 3–5 reader_questions, age-appropriate footnotes, cover prompt, and 1–5 carefully chosen illustration prompts. Keep the ordinary-book schema; do not send interactive_content unless the user requested an interactive novel.
9. Save the assembled package to `book-publications/inbox/YYYY-MM-DD-<slug>.json`, validate that the assembled text contains every completed chapter in order and that its counted words match manifest.current_word_count (allow only known Markdown heading/metadata overhead), then mark the draft ready_to_publish. Only this inbox package triggers the existing image generation/publication workflow.
10. Do not advance rotation-state or report publication until the existing publish and deploy workflows succeed and the book row is verified in Supabase. A failed image quota or publish attempt must leave the complete draft and package available for retry with the same publication_key.
11. Never use paid APIs or paid image generation. Keep Cloudflare Workers AI primary and existing free OVHcloud SDXL fallback unchanged. Generate illustrations only after the full text is complete, so image quotas are not wasted on unfinished manuscripts.

## Important limits and honesty

- This is resumable, multi-run authoring, not an instant single-response generation. A 300,000–400,000-word manuscript may require many daily checkpoints. Do not promise a finished novel on the same day.
- GitHub is the durable manuscript checkpoint store; the final reader still receives one assembled book_content field. No new Supabase tables or schema changes are needed for this protocol.
- If the assembled payload or reader has a practical size/performance limit, report the measured limit and stop before publication rather than truncating the book. Do not split a single novel into unrelated catalog entries without user approval.
- Keep normal short-book automation behavior for requests that do not ask for a long-form novel.

## Illustration and visual continuity rules

- Generate no images while the manuscript is incomplete. After the complete text and editorial audit, create a visual passport from the cover concept: medium/technique, line/detail treatment, palette, lighting, contrast, texture, and realism.
- Repeat one identical concise style anchor in the cover prompt and every internal illustration prompt. Change only the depicted episode, framing, and camera angle. Do not mix media, palettes, lighting, or realism levels within one book.
- Every published book requires a cover and 1–5 internal illustrations. For a long ordinary novel, select 1–5 high-value moments across the complete manuscript; do not mechanically illustrate every chapter. Put illustration markers beside the corresponding visual episode and ensure the publisher replaces every marker.
- Prefer environments, architecture, objects, and silhouettes over complex close-up anatomy. Avoid crowds, tangled hands, complex gestures, extra limbs, collages, text, logos, and watermarks. Do not claim images are defect-free unless the generated files were actually inspected.
- The five-scene/one-image-per-scene rule applies to interactive books only. An ordinary long novel is not limited to five chapters or scenes; it still has no more than five internal illustrations because of the current publisher limit.

## Author and series continuity

- Maintain a reusable pool of original pseudonymous authors and series. Store each author's distinct voice and biography in `book-publications/authors/<latin-slug>.json`; check existing author bibles and the catalog before inventing a new author or series.
- Do not use the prohibited fixed author names specified in the active BookCheef automation. Do not imitate a specific living or deceased author's recognizable style or reuse protected characters/worlds.
- Select age rating from the actual content and intended audience, not to force demographic variety. Preserve series-world and character continuity across books.
