import fs from "node:fs/promises";
import path from "node:path";

const NOVEL_ROOT = "book-publications/drafts/last-day-of-universe";
const TASK_ID = "last-day-of-universe";
const MIN_WORDS = 1400;
const MAX_WORDS = 6000;

function countWords(markdown) {
  return markdown.match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu)?.length || 0;
}

function expectedChapterPath(chapter, volume) {
  const expectedVolume = Math.ceil(chapter / 32);
  if (volume !== expectedVolume || volume < 1 || volume > 5) {
    throw new Error(`Invalid volume ${volume} for chapter ${chapter}; expected ${expectedVolume}.`);
  }
  return `${NOVEL_ROOT}/chapters/volume-${String(volume).padStart(2, "0")}-chapter-${String(chapter).padStart(3, "0")}.md`;
}

function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("Artifact must be a JSON object.");
  if (artifact.schema_version !== 1 || artifact.artifact_type !== "bookcheef_novel_chapter") throw new Error("Unsupported novel artifact schema.");
  if (artifact.worker_type !== "novel" || artifact.task_id !== TASK_ID) throw new Error("Artifact worker_type or task_id is invalid.");
  if (!Number.isSafeInteger(artifact.chapter) || artifact.chapter < 1 || artifact.chapter > 160) throw new Error("Artifact chapter must be an integer from 1 to 160.");
  if (!Number.isSafeInteger(artifact.volume)) throw new Error("Artifact volume must be a positive integer.");
  for (const field of ["title", "synopsis", "continuity_note", "markdown"]) {
    if (typeof artifact[field] !== "string" || !artifact[field].trim()) throw new Error(`Artifact ${field} is required.`);
  }
  const target = expectedChapterPath(artifact.chapter, artifact.volume);
  if (artifact.target_path !== target) throw new Error(`Unsafe or unexpected target_path; expected ${target}.`);
  const heading = artifact.markdown.match(/^#\s+Глава\s+(\d+)\.\s+(.+)$/m);
  if (!heading || Number(heading[1]) !== artifact.chapter || heading[2].trim() !== artifact.title.trim()) {
    throw new Error("Markdown heading must exactly match the artifact chapter number and title.");
  }
  const words = countWords(artifact.markdown);
  if (words < MIN_WORDS || words > MAX_WORDS) throw new Error(`Chapter word count ${words} is outside ${MIN_WORDS}–${MAX_WORDS}.`);
  if (artifact.word_count !== words) throw new Error(`word_count mismatch: artifact says ${artifact.word_count}, markdown contains ${words}.`);
  return { target, words };
}

async function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function writeCompletedCheckpoint(root, artifact, target, words) {
  const checkpointPath = path.join(root, "book-publications/workers/novel/checkpoints", TASK_ID + ".json");
  let previous = {};
  try {
    previous = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWriteJson(checkpointPath, {
    ...previous,
    worker_type: "novel",
    task_id: TASK_ID,
    status: "completed",
    completed_chapter: artifact.chapter,
    next_chapter: artifact.chapter + 1,
    chapter_path: target,
    title: artifact.title,
    word_count: words,
    artifact_path: null,
    updated_at: artifact.generated_at || new Date().toISOString()
  });
}

async function acquireLock(lockPath) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }) + "\n");
    return async () => {
      await handle.close();
      await fs.rm(lockPath, { force: true });
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error.code === "EEXIST") throw new Error(`Novel manifest merge is already locked: ${lockPath}`);
    throw error;
  }
}

export async function coordinateNovelArtifacts({ artifactRoot = "worker-artifacts/novel/outbox", repoRoot = process.cwd(), beforeManifestWrite } = {}) {
  const root = path.resolve(repoRoot);
  const artifactDir = path.resolve(root, artifactRoot);
  const relativeArtifactDir = path.relative(root, artifactDir);
  if (!relativeArtifactDir || relativeArtifactDir.startsWith("..") || path.isAbsolute(relativeArtifactDir)) {
    throw new Error("artifactRoot must be a child directory inside the repository.");
  }
  const files = (await fs.readdir(artifactDir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => path.join(artifactDir, entry.name))
    .sort();
  if (!files.length) return [];

  const lockPath = path.join(root, NOVEL_ROOT, ".manifest-merge.lock");
  const release = await acquireLock(lockPath);
  const results = [];
  try {
    const manifestPath = path.join(root, NOVEL_ROOT, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (!Array.isArray(manifest.completed_chapters) || !Array.isArray(manifest.volumes)) {
      throw new Error("Novel manifest is missing completed_chapters or volumes arrays.");
    }

    for (const sourcePath of files) {
      const artifact = JSON.parse(await fs.readFile(sourcePath, "utf8"));
      const { target, words } = validateArtifact(artifact);
      const existingEntry = manifest.completed_chapters.find(item => item.chapter === artifact.chapter);
      const chapterPath = path.join(root, target);
      await fs.mkdir(path.dirname(chapterPath), { recursive: true });

      if (existingEntry) {
        if (existingEntry.path !== target || existingEntry.title !== artifact.title || existingEntry.word_count !== words) {
          throw new Error(`Manifest already contains conflicting chapter ${artifact.chapter}.`);
        }
        const existingMarkdown = await fs.readFile(chapterPath, "utf8");
        if (existingMarkdown !== artifact.markdown + "\n" && existingMarkdown !== artifact.markdown) {
          throw new Error(`Chapter file conflicts with manifest entry for chapter ${artifact.chapter}.`);
        }
        await writeCompletedCheckpoint(root, artifact, target, words);
        await fs.rm(sourcePath);
        results.push({ chapter: artifact.chapter, status: "already_merged", path: target });
        continue;
      }

      const expectedNext = Number(manifest.next_chapter) || (Math.max(0, ...manifest.completed_chapters.map(item => item.chapter)) + 1);
      if (artifact.chapter !== expectedNext) {
        throw new Error(`Out-of-order chapter ${artifact.chapter}; manifest expects chapter ${expectedNext}.`);
      }
      if (artifact.chapter > Number(manifest.planned_chapters || 160)) throw new Error("Artifact exceeds planned chapter count.");

      let chapterExists = false;
      try {
        const existingMarkdown = await fs.readFile(chapterPath, "utf8");
        chapterExists = true;
        if (existingMarkdown !== artifact.markdown + "\n" && existingMarkdown !== artifact.markdown) {
          throw new Error(`Target chapter file already exists with different content: ${target}`);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!chapterExists) await fs.writeFile(chapterPath, artifact.markdown + "\n", { flag: "wx" });

      const nextManifest = structuredClone(manifest);
      nextManifest.completed_chapters.push({
        chapter: artifact.chapter,
        volume: artifact.volume,
        path: target,
        title: artifact.title,
        word_count: words,
        synopsis: artifact.synopsis,
        status: "draft",
        continuity_note: artifact.continuity_note
      });
      nextManifest.completed_chapters.sort((a, b) => a.chapter - b.chapter);
      nextManifest.current_word_count = (Number(nextManifest.current_word_count) || 0) + words;
      nextManifest.next_chapter = artifact.chapter + 1;
      const volumeEntry = nextManifest.volumes.find(item => item.volume === artifact.volume);
      if (!volumeEntry) throw new Error(`Manifest has no volume entry for volume ${artifact.volume}.`);
      volumeEntry.completed_chapters = (Number(volumeEntry.completed_chapters) || 0) + 1;
      volumeEntry.status = "writing";
      nextManifest.last_generated_at = artifact.generated_at || new Date().toISOString();
      nextManifest.last_provider = artifact.provider || "isolated novel worker";

      if (beforeManifestWrite) await beforeManifestWrite({ artifact, manifestPath, nextManifest });
      await atomicWriteJson(manifestPath, nextManifest);
      Object.assign(manifest, nextManifest);
      await writeCompletedCheckpoint(root, artifact, target, words);
      await fs.rm(sourcePath);
      results.push({ chapter: artifact.chapter, status: "merged", path: target, word_count: words });
    }
    return results;
  } finally {
    await release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const artifactRoot = process.argv[2] || "worker-artifacts/novel/outbox";
  const results = await coordinateNovelArtifacts({ artifactRoot });
  console.log(JSON.stringify({ merged: results.length, results }, null, 2));
}
