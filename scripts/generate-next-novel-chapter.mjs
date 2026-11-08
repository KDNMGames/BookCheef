import fs from "node:fs/promises";
import path from "node:path";

const ROOT = "book-publications/drafts/last-day-of-universe";
const manifestPath = path.join(ROOT, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const chapters = [...manifest.completed_chapters].sort((a, b) => a.chapter - b.chapter);
const next = chapters.length ? chapters.at(-1).chapter + 1 : 1;
if (next > manifest.planned_chapters) throw new Error("All planned chapters are already present.");
if (chapters.some(c => c.chapter === next)) throw new Error(`Chapter ${next} already exists; refusing to overwrite.`);

const pad = String(next).padStart(3, "0");
const volume = Math.ceil(next / 32);
const chapterPath = path.join(ROOT, "chapters", `volume-${String(volume).padStart(2, "0")}-chapter-${pad}.md`);
try {
  await fs.access(chapterPath);
  throw new Error(`Target file already exists: ${chapterPath}; refusing to overwrite.`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const outline = await fs.readFile(path.join(ROOT, "outline.md"), "utf8");
const outlineLines = outline.split(/\r?\n/);
const outlineLine = outlineLines.find(line => new RegExp(`^[-*]\\s+\\*\\*${next}\\.`).test(line));
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
Ты — профессиональный русский романист и редактор. Напиши следующую полноценную главу романа «Последний день Вселенной».
Верни СТРОГО JSON без Markdown-ограждений в формате:
{"title":"...","synopsis":"...","continuity_note":"...","markdown":"# Глава N. Название\n\nПолный текст главы..."}

ЗАДАНИЕ ИЗ ПЛАНА:
${outlineLine}

НОМЕР: ${next}. Том: ${volume}. Автор: Лиор Эстен. Рассказчик: Илья Воронцов.
Целевой объём: 3000–4000 русских слов. Не сокращай главу до конспекта. Развивай полноценные сцены, диалоги, наблюдения, телесные ощущения, конфликт и последствия. Не повторяй уже написанные эпизоды.

БИБЛИЯ РОМАНА:
${bible}

ПОСЛЕДНИЕ ГЛАВЫ ДЛЯ НЕПРЕРЫВНОСТИ:
${recentText}

ОБЯЗАТЕЛЬНО:
- Первое лицо, прошедшее время, голос Ильи; литературный, ясный русский язык.
- Не превращай главу в лекцию или пересказ плана.
- Соблюдай причинно-следственную связь и характеры; Лада не всеведущая, Единый не злодей.
- Никакой новой естественной биологической жизни в настоящем времени.
- Никаких порталов, запасных вселенных, спасения от финала, сверхспособностей или внезапных разгадок.
- Не выдавай спекулятивную физику за установленный научный факт.
- Не повторяй дословно сцены/формулировки из предыдущих глав.
- Заверши главу содержательным поворотом/решением, который естественно ведёт к следующей главе.
- В synopsis кратко опиши реальные события главы; continuity_note укажи, что важно сохранить дальше.
- В markdown должен быть полный текст главы с заголовком. Не включай synopsis и continuity_note в саму главу.
`;

let response;
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
        { role: "system", content: "Пиши художественную прозу на русском. Точно соблюдай формат JSON и ограничения проекта." },
        { role: "user", content: prompt }
      ],
      temperature: 0.82,
      max_tokens: 8192
    })
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) { response = data; break; }
  lastError = `HTTP ${res.status}: ${data?.error?.message || JSON.stringify(data)}`;
  if (![429, 500, 502, 503, 504].includes(res.status) || attempt === 3) break;
  const delay = 5000 * attempt;
  console.log(`OpenRouter temporarily unavailable; retrying in ${delay / 1000}s (attempt ${attempt}/3).`);
  await new Promise(resolve => setTimeout(resolve, delay));
}
if (!response) throw new Error(`OpenRouter request failed: ${lastError}`);

const choice = response.choices?.[0];
const raw = choice?.message?.content;
if (typeof raw !== "string" || !raw.trim()) {
  throw new Error(`Model returned no text. finish_reason=${choice?.finish_reason || "unknown"}`);
}
const cleaned = raw.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
let result;
try { result = JSON.parse(cleaned); }
catch { throw new Error("Model response was not valid JSON; no files were changed. Response preview: " + cleaned.slice(0, 500)); }

if (!result.title || !result.synopsis || !result.continuity_note ||
    typeof result.markdown !== "string" || !result.markdown.trim()) {
  throw new Error("Generated JSON is missing required fields; no files were changed.");
}
if (!result.markdown.includes(`Глава ${next}.`) && !result.markdown.includes(`Глава ${next} `)) {
  throw new Error("Chapter heading does not match the expected chapter number; no files were changed.");
}
const words = result.markdown.match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu)?.length || 0;
if (words < 1800) throw new Error(`Chapter too short (${words} words); refusing to save an incomplete draft.`);
if (words > 6500) throw new Error(`Chapter unexpectedly long (${words} words); refusing to save.`);

await fs.mkdir(path.dirname(chapterPath), { recursive: true });
await fs.writeFile(chapterPath, result.markdown.trim() + "\n", { flag: "wx" });
manifest.completed_chapters.push({
  chapter: next,
  volume,
  path: chapterPath,
  title: result.title,
  word_count: words,
  synopsis: result.synopsis,
  status: "draft",
  continuity_note: result.continuity_note
});
manifest.current_word_count = (Number(manifest.current_word_count) || 0) + words;
manifest.last_generated_at = new Date().toISOString();
manifest.last_provider = "OpenRouter (free routing)";
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Saved chapter ${next}: ${result.title} (${words} words).`);
console.log(`Provider model: ${response.model || "openrouter/free"}; tokens: ${response.usage?.total_tokens ?? "not reported"}.`);
console.log("The chapter is saved as a draft only; it is not published to the website.");
