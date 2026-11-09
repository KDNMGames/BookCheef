import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createBookWorkerState } from "./book-worker-state.mjs";

if (process.env.CURSOR_FREE_INCLUDED !== "true") {
  throw new Error("Novel generation stopped: set the CURSOR_FREE_INCLUDED Actions variable to true only after confirming that Cursor Agent usage is covered by an included free allowance. No paid usage is permitted.");
}

const workerState = createBookWorkerState({ workerType: "novel" });
await workerState.acquireLease();
try {
const workerCheckpointPath = workerState.checkpointPath("last-day-of-universe");

const ROOT = "book-publications/drafts/last-day-of-universe";
const manifestPath = path.join(ROOT, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const chapters = [...manifest.completed_chapters].sort((a, b) => a.chapter - b.chapter);
const next = chapters.length ? chapters.at(-1).chapter + 1 : 1;
if (next > manifest.planned_chapters) throw new Error("All planned chapters are already present.");
if (chapters.some(c => c.chapter === next)) throw new Error(`Chapter ${next} already exists; refusing to overwrite.`);

const volume = Math.ceil(next / 32);
const chapterPath = path.join(ROOT, "chapters", `volume-${String(volume).padStart(2, "0")}-chapter-${String(next).padStart(3, "0")}.md`);
try {
  await fs.access(chapterPath);
  throw new Error(`Target file already exists: ${chapterPath}; refusing to overwrite.`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const outline = await fs.readFile(path.join(ROOT, "outline.md"), "utf8");
const outlineLine = outline.split(/\r?\n/).find(line => new RegExp(`^[-*]\\s+\\*\\*${next}\\.`).test(line));
if (!outlineLine) throw new Error(`Outline entry for chapter ${next} not found.`);

const bibleFiles = ["characters.md", "style.md", "world.md", "timeline.md", "plotlines.md"];
const bible = (await Promise.all(bibleFiles.map(async name =>
  `\n--- ${name} ---\n${await fs.readFile(path.join(ROOT, "bible", name), "utf8")}`
))).join("\n");
const recent = chapters.slice(-3);
const recentText = (await Promise.all(recent.map(async item =>
  `\n--- Chapter ${item.chapter}: ${item.title} ---\n${await fs.readFile(item.path, "utf8")}`
))).join("\n");

if (!process.env.CURSOR_API_KEY) throw new Error("Missing CURSOR_API_KEY. Add it in GitHub Settings → Secrets and variables → Actions.");
const model = process.env.CURSOR_MODEL || "";
const prompt = `
Напиши полноценную художественную главу романа «Последний день Вселенной» на русском языке.
Верни ТОЛЬКО Markdown-текст главы. Не возвращай JSON, пояснения, synopsis, кодовые ограждения или комментарии.
Начни строго с заголовка: # Глава ${next}. [Название главы]

ЗАДАНИЕ ИЗ ПЛАНА:
${outlineLine}

Автор: Лиор Эстен. Рассказчик: Илья Воронцов. Том: ${volume}.
Объём: 1800–2400 русских слов. Это законченная глава романа, а не конспект. Нужны несколько полноценных сцен, развитие конфликта, диалоги, телесные ощущения Ильи, открытия и последствия. Не растягивай текст повторами.

БИБЛИЯ РОМАНА:
${bible}

ПОСЛЕДНИЕ ГЛАВЫ:
${recentText}

СТРОГИЕ ПРАВИЛА:
- Первое лицо, прошедшее время, голос Ильи; ясный литературный русский язык.
- Не превращай главу в лекцию. Научные идеи раскрывай через опыт и события.
- Лада не всеведущая; Единый не злодей. Их позиции могут различаться.
- Не вводи новую естественную биологическую жизнь в настоящем времени.
- Никаких порталов, запасных вселенных, спасения от финала, сверхспособностей или внезапных разгадок.
- Не выдавай спекулятивную физику за установленный научный факт.
- Не повторяй сцены и формулировки предыдущих глав.
- Заверши содержательным поворотом или решением, ведущим к следующей главе.
- Не обрывайся посреди предложения. Последняя строка должна быть полноценным завершением главы.
`;

const agentArgs = ["-p", prompt, "--output-format", "text", "--trust"];
if (model) agentArgs.push("--model", model);
const result = spawnSync("agent", agentArgs, {
  encoding: "utf8",
  env: process.env,
  maxBuffer: 20 * 1024 * 1024,
  timeout: 20 * 60 * 1000
});
if (result.error) throw new Error(`Cursor Agent could not start: ${result.error.message}`);
if (result.status !== 0) {
  const details = (result.stderr || result.stdout || "").trim().slice(-5000);
  throw new Error(`Cursor Agent failed (exit ${result.status}): ${details || "no diagnostic output"}`);
}
let markdown = (result.stdout || "").trim();
markdown = markdown.replace(/^\x60{3}(?:markdown)?\s*/i, "").replace(/\s*\x60{3}$/, "").trim();
if (!markdown) throw new Error("Cursor Agent returned an empty chapter.");
const heading = markdown.match(/^#\s+(.+)$/m);
if (!heading || !heading[1].includes(`Глава ${next}`)) {
  throw new Error(`Missing or incorrect chapter heading. Expected chapter ${next}; no files were changed.`);
}
const words = markdown.match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu)?.length || 0;
if (words < 1400) throw new Error(`Chapter too short (${words} words); refusing to save an incomplete draft.`);
if (words > 6000) throw new Error(`Chapter unexpectedly long (${words} words); refusing to save.`);
if (/[—,:;]\s*$/.test(markdown)) throw new Error("Chapter appears to end mid-sentence; refusing to save.");

const title = heading[1].replace(/^Глава\s+\d+\.\s*/, "").trim();
const synopsis = outlineLine.replace(/^[-*]\s+\*\*\d+\.\s*/, "").replace(/\*\*\s*[—-]\s*/, " — ").trim();
const continuityNote = `Сохранить события и изменения персонажей главы ${next}; продолжить сюжет согласно следующему пункту плана.`;

await fs.mkdir(path.dirname(chapterPath), { recursive: true });
await fs.writeFile(chapterPath, markdown + "\n", { flag: "wx" });
manifest.completed_chapters.push({
  chapter: next,
  volume,
  path: chapterPath,
  title,
  word_count: words,
  synopsis,
  status: "draft",
  continuity_note: continuityNote
});
manifest.current_word_count = (Number(manifest.current_word_count) || 0) + words;
manifest.next_chapter = next + 1;
const currentVolume = manifest.volumes?.find(item => item.volume === volume);
if (currentVolume) currentVolume.completed_chapters = (Number(currentVolume.completed_chapters) || 0) + 1;
manifest.last_generated_at = new Date().toISOString();
manifest.last_provider = model ? `Cursor Agent CLI (${model})` : "Cursor Agent CLI (account default model)";
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Saved chapter ${next}: ${title} (${words} words).`);
console.log(`Provider: Cursor Agent CLI; model: ${model || "account default"}.`);
console.log("Saved as a draft only; it is not published to the website.");
await workerState.atomicWriteJson(workerCheckpointPath, {
  worker_type: "novel",
  task_id: "last-day-of-universe",
  status: "completed",
  completed_chapter: next,
  next_chapter: next + 1,
  chapter_path: chapterPath,
  title,
  word_count: words,
  updated_at: new Date().toISOString()
});
} finally {
  await workerState.releaseLease();
}
