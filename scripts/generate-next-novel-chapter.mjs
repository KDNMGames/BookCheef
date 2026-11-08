import fs from "node:fs/promises";
import path from "node:path";

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

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY.");
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

let data;
let lastError = "";
for (let attempt = 1; attempt <= 3; attempt++) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://kdnmgames.github.io/BookCheef/",
      "X-Title": "BookCheef Novel Writer"
    },
    body: JSON.stringify({
      model: "openrouter/free",
      messages: [
        { role: "system", content: "Ты пишешь качественную русскую научную фантастику. Возвращай только законченный Markdown-текст главы." },
        { role: "user", content: prompt }
      ],
      temperature: 0.82,
      max_tokens: 8192
    })
  });
  data = await res.json().catch(() => ({}));
  if (res.ok) break;
  lastError = `HTTP ${res.status}: ${data?.error?.message || JSON.stringify(data)}`;
  if (![429, 500, 502, 503, 504].includes(res.status) || attempt === 3) break;
  const delay = 5000 * attempt;
  console.log(`Temporary provider error; retrying in ${delay / 1000}s (attempt ${attempt}/3).`);
  await new Promise(resolve => setTimeout(resolve, delay));
}
if (!data || data.error) throw new Error(`OpenRouter request failed: ${lastError || data?.error?.message || "unknown error"}`);

const choice = data.choices?.[0];
let markdown = choice?.message?.content;
if (typeof markdown !== "string" || !markdown.trim()) {
  throw new Error(`Model returned no text. finish_reason=${choice?.finish_reason || "unknown"}`);
}
markdown = markdown.trim().replace(/^\x60{3}(?:markdown)?\s*/i, "").replace(/\s*\x60{3}$/, "").trim();
if (choice.finish_reason === "length") {
  throw new Error("Model hit its output-token limit and cut off the chapter. No files were changed; reduce chapter size or use a model with a larger output limit.");
}
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
manifest.last_generated_at = new Date().toISOString();
manifest.last_provider = data.model || "OpenRouter (free routing)";
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Saved chapter ${next}: ${title} (${words} words).`);
console.log(`Provider model: ${data.model || "openrouter/free"}; finish: ${choice.finish_reason || "unknown"}; tokens: ${data.usage?.total_tokens ?? "not reported"}.`);
console.log("Saved as a draft only; it is not published to the website.");
