import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { coordinateNovelArtifacts } from "./coordinate-novel-artifacts.mjs";

const NOVEL = "book-publications/drafts/last-day-of-universe";
const TARGET = `${NOVEL}/chapters/volume-01-chapter-026.md`;
const markdown = "# Глава 26. Архив согласий\n\n" + ("Илья внимательно изучал старые записи и задавал вопросы Ладе. ".repeat(260));
const wordCount = markdown.match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu).length;

function artifact(overrides = {}) {
  return {
    schema_version: 1,
    artifact_type: "bookcheef_novel_chapter",
    worker_type: "novel",
    task_id: "last-day-of-universe",
    chapter: 26,
    volume: 1,
    title: "Архив согласий",
    word_count: wordCount,
    synopsis: "Илья исследует архив согласий.",
    continuity_note: "Сохранить право контуров пересматривать согласие.",
    target_path: TARGET,
    markdown,
    generated_at: "2026-11-09T00:00:00.000Z",
    provider: "test",
    ...overrides
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookcheef-novel-merge-"));
  const novelRoot = path.join(root, NOVEL);
  const outbox = path.join(root, "worker-artifacts", "novel", "outbox");
  await fs.mkdir(path.join(novelRoot, "chapters"), { recursive: true });
  await fs.mkdir(outbox, { recursive: true });
  const manifest = {
    planned_chapters: 160,
    current_word_count: 10000,
    next_chapter: 26,
    completed_chapters: [{ chapter: 25, volume: 1, path: `${NOVEL}/chapters/volume-01-chapter-025.md`, title: "Предыдущая", word_count: 1000 }],
    volumes: [{ volume: 1, status: "writing", completed_chapters: 25 }]
  };
  await fs.writeFile(path.join(novelRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { root, outbox, novelRoot, manifest };
}

test("merges a valid chapter and updates manifest exactly once", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.outbox, "chapter-026.json");
    await fs.writeFile(source, JSON.stringify(artifact()));
    const result = await coordinateNovelArtifacts({ artifactRoot: "worker-artifacts/novel/outbox", repoRoot: f.root });
    assert.equal(result[0].status, "merged");
    const updated = JSON.parse(await fs.readFile(path.join(f.novelRoot, "manifest.json"), "utf8"));
    assert.equal(updated.next_chapter, 27);
    assert.equal(updated.completed_chapters.length, 2);
    assert.equal(updated.current_word_count, 10000 + wordCount);
    assert.equal(updated.volumes[0].completed_chapters, 26);
    assert.equal(await fs.readFile(path.join(f.root, TARGET), "utf8"), markdown + "\n");
    await assert.rejects(() => fs.access(source), { code: "ENOENT" });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("retry resumes after chapter write but before manifest update", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.outbox, "chapter-026.json");
    await fs.writeFile(source, JSON.stringify(artifact()));
    await assert.rejects(() => coordinateNovelArtifacts({
      artifactRoot: "worker-artifacts/novel/outbox",
      repoRoot: f.root,
      beforeManifestWrite: async () => { throw new Error("simulated interruption"); }
    }), /simulated interruption/);
    assert.equal(await fs.readFile(path.join(f.root, TARGET), "utf8"), markdown + "\n");
    await fs.access(source);
    const result = await coordinateNovelArtifacts({ artifactRoot: "worker-artifacts/novel/outbox", repoRoot: f.root });
    assert.equal(result[0].status, "merged");
    const updated = JSON.parse(await fs.readFile(path.join(f.novelRoot, "manifest.json"), "utf8"));
    assert.equal(updated.completed_chapters.length, 2);
    assert.equal(updated.current_word_count, 10000 + wordCount);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("rejects path traversal, invalid word count, and out-of-order chapters", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.outbox, "bad.json");
    await fs.writeFile(source, JSON.stringify(artifact({ target_path: "../../escape.md" })));
    await assert.rejects(() => coordinateNovelArtifacts({ artifactRoot: "worker-artifacts/novel/outbox", repoRoot: f.root }), /target_path/);
    await fs.writeFile(source, JSON.stringify(artifact({ word_count: 1 })));
    await assert.rejects(() => coordinateNovelArtifacts({ artifactRoot: "worker-artifacts/novel/outbox", repoRoot: f.root }), /word_count mismatch/);
    await fs.writeFile(source, JSON.stringify(artifact({ chapter: 27, target_path: `${NOVEL}/chapters/volume-01-chapter-027.md`, markdown: markdown.replace("Глава 26", "Глава 27") })));
    await assert.rejects(() => coordinateNovelArtifacts({ artifactRoot: "worker-artifacts/novel/outbox", repoRoot: f.root }), /expects chapter 26/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("rejects a conflicting pre-existing chapter file", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.outbox, "chapter-026.json"), JSON.stringify(artifact()));
    await fs.writeFile(path.join(f.root, TARGET), "different chapter");
    await assert.rejects(() => coordinateNovelArtifacts({ artifactRoot: "worker-artifacts/novel/outbox", repoRoot: f.root }), /different content/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("rejects an artifact directory outside the repository", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => coordinateNovelArtifacts({ artifactRoot: "../outside", repoRoot: f.root }), /child directory/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
