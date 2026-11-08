import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCheckpointStore } from "./book-checkpoint.mjs";

const ROOT = process.cwd();
const CONFIG_PATH = "book-publications/automation-config.json";
const ROTATION_PATH = "book-publications/rotation-state.json";
const INBOX = "book-publications/inbox";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CURSOR_API_KEY = process.env.CURSOR_API_KEY;
let openRouterDisabled = false;

const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
const rotation = JSON.parse(await fs.readFile(ROTATION_PATH, "utf8"));

async function findPendingPackage() {
  const queuePath = "book-publications/pending-publications.json";
  const queue = JSON.parse(await fs.readFile(queuePath, "utf8"));
  const entries = Array.isArray(queue.packages) ? queue.packages : [];
  if (!entries.length) return null;
  const entry = entries[0];
  const filePath = String(entry.path || "");
  if (!filePath.startsWith(INBOX + "/") || !filePath.endsWith(".json")) {
    throw new Error("Pending queue contains an invalid package path.");
  }
  const pkg = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!pkg.publication_key || pkg.publication_key !== entry.publication_key) {
    throw new Error("Pending queue publication key does not match its package.");
  }
  return { path: filePath, title: pkg.title, publication_key: pkg.publication_key };
}

const pending = await findPendingPackage();
if (pending) {
  console.log("Found a package in the explicit pending queue; retrying it before generating another book.");
  console.log(JSON.stringify(pending));
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, "package_path=" + pending.path + "\ncreated=false\n");
  }
  process.exit(0);
}


const WORK_PATH = "book-publications/work-in-progress/current.json";

const COOLDOWN_PATH = "book-publications/provider-cooldown.json";
const cooldownSeconds = 21600;
try {
  const state = JSON.parse(await fs.readFile(COOLDOWN_PATH, "utf8"));
  const until = Date.parse(state.retry_after || "");
  if (Number.isFinite(until) && until > Date.now()) {
    openRouterDisabled = true;
    console.log("OpenRouter is cooling down until " + new Date(until).toISOString() + "; other AI providers remain available.");
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }

if (!OPENROUTER_API_KEY && !CURSOR_API_KEY) {
  throw new Error("No text AI provider credentials are configured. Add OPENROUTER_API_KEY or CURSOR_API_KEY.");
}

async function saveOpenRouterCooldown(reason) {
  const retryAfter = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
  await fs.writeFile(COOLDOWN_PATH, JSON.stringify({
    provider: "openrouter",
    detected_at: new Date().toISOString(),
    retry_after: retryAfter,
    reason: String(reason || "OpenRouter quota exhausted").slice(0, 700)
  }, null, 2) + "\n");
  openRouterDisabled = true;
  console.warn("OpenRouter paused until " + retryAfter + "; switching to the next AI provider.");
}

function runCursorAgent(prompt, { timeout = 600000 } = {}) {
  if (!CURSOR_API_KEY) {
    const error = new Error("Cursor fallback is unavailable: CURSOR_API_KEY is not configured.");
    error.code = "NO_FALLBACK_PROVIDER";
    throw error;
  }
  console.log("Switching text generation to Cursor Agent CLI.");
  const args = ["-p", prompt, "--output-format", "text", "--trust"];
  if (process.env.CURSOR_MODEL) args.push("--model", process.env.CURSOR_MODEL);
  const result = spawnSync("agent", args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 40 * 1024 * 1024,
    timeout
  });
  if (result.error) throw new Error("Cursor Agent could not run: " + result.error.message);
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "").trim().slice(-2500);
    const error = new Error("Cursor Agent failed (exit " + result.status + "): " + (details || "no diagnostic output"));
    if (/rate.?limit|quota|usage limit|billing limit|out of credits/i.test(error.message)) error.code = "RATE_LIMIT";
    throw error;
  }
  const output = String(result.stdout || "").trim().replace(/^\x60{3}(?:json|markdown)?\s*/i, "").replace(/\s*\x60{3}$/, "").trim();
  if (!output) throw new Error("Cursor Agent returned an empty response.");
  return output;
}

function parseModelJson(output) {
  const cleaned = String(output).trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Cursor Agent did not return a JSON object.");
  return JSON.parse(cleaned.slice(start, end + 1));
}
const position = Number(rotation.cycle_position) || 1;
const cycle = config.daily_book.rotation || ["interactive", "ordinary", "ordinary"];
const bookType = cycle[(position - 1) % cycle.length];
const { saveWork, loadWork } = createCheckpointStore({ workPath: WORK_PATH, bookType });
const authorDir = "book-publications/authors";
const authorFiles = (await fs.readdir(authorDir)).filter(x => x.endsWith(".json")).sort();
const authors = [];
for (const name of authorFiles) {
  authors.push(JSON.parse(await fs.readFile(path.join(authorDir, name), "utf8")));
}
const existingFiles = (await fs.readdir(INBOX)).filter(x => x.endsWith(".json")).sort();
const existingTitles = [];
for (const name of existingFiles) {
  try {
    const p = JSON.parse(await fs.readFile(path.join(INBOX, name), "utf8"));
    if (p.title) existingTitles.push(p.title);
  } catch {}
}
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.timezone || "Europe/Berlin",
  year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());

const systemPrompt = [
  "Ты — профессиональная редакция BookCheef. Создавай оригинальные законченные книги на русском языке.",
  "Верни только один корректный JSON-объект, без Markdown и комментариев.",
  "Не используй чужие известные миры, персонажей или узнаваемую манеру конкретного автора.",
  "Книга должна быть содержательной, с полноценным сюжетом, сценами, конфликтом и завершением; не конспектом и не синопсисом.",
  "Не используй заглушки, TODO, пустые поля и служебные комментарии.",
  "Все изображения описывай точными визуальными промптами; не вставляй URL и base64."
].join("\n");

const userPrompt = `Создай ОДНУ полностью готовую бесплатную книгу для каталога BookCheef.

ВАЖНО: перед финальным ответом проверь, что title уникален и не совпадает ни с одним названием ниже даже после изменения регистра и знаков препинания. Придумай совершенно новое название, не вариацию существующего. Для каждой сноски скопируй в поле word точное слово из book_content или текста узлов, сохранив написание; после написания текста проверь каждую сноску поиском по готовому тексту. Не придумывай слова для сносок.

ТИП: ${bookType === "interactive" ? "ИНТЕРАКТИВНАЯ" : "ОБЫЧНАЯ"}.
Дата публикации: ${today}.
Авторы, уже заведённые в BookCheef (выбери одного подходящего и сохрани его точное имя и голос):
${JSON.stringify(authors, null, 2)}

Недавние названия, которых нельзя повторять или перефразировать:
${existingTitles.join(" | ")}

ОБЩИЕ ПОЛЯ JSON:
{
"title":"...",
"category":"...",
"description":"Краткое привлекательное описание без спойлеров",
"author":"точное имя одного автора из переданного пула",
"age":"6+ / 9+ / 12+ / 14+ / 16+ / 18+",
"genre":"...",
"series":"название серии или пустая строка",
"is_free":true,
"is_interactive":${bookType === "interactive" ? "true" : "false"},
"book_content":"...",
"reader_questions":[{"question":"...","answer":"..."},{"question":"...","answer":"..."},{"question":"...","answer":"..."}],
"footnotes":[{"word":"слово, дословно встречающееся в тексте","text":"понятное определение"}],
"cover":{"prompt":"...","visual_style_anchor":"ОДНА точная короткая фраза общего визуального стиля"},
"illustrations":[{"number":1,"chapter":"точный заголовок главы/сцены","prompt":"..."}]
${bookType === "interactive" ? ',"interactive_content":{"start":"scene-1","footnotes":[{"word":"...","text":"..."}],"nodes":[{"id":"scene-1","title":"...","text":"...","image_start":"{{illustration:точный заголовок сцены:1}}","image_start_alt":"...","choices":[{"text":"...","next":"scene-2"}]}]}' : "" }
}

ТРЕБОВАНИЯ К ТЕКСТУ:
- Русский язык, естественный и грамотный, без повторов и искусственного растягивания.
- Возраст выбирай по реальному содержанию. Текст должен соответствовать возрасту.
- ОБЪЁМ — ОБЯЗАТЕЛЬНОЕ ТРЕБОВАНИЕ. Итоговая взрослая книга (16+/18+) — не менее 18 000 слов (примерно 2–2,5 часа чтения), 10–14 глав. Детская/подростковая: 6+ — не менее 1 500 слов; 9+ — 1 800; 12+ — 2 400; 14+ — 2 700 слов; 5–9 глав. Генерация проходит в два этапа: сейчас верни структурный JSON-черновик с полноценными сюжетными заготовками по 100–180 слов на главу; затем каждая глава будет отдельно расширена до требуемого объёма. Не пытайся уместить весь роман в один ответ. Не допускай повторов и искусственного растягивания.
- Интерактивная книга: ровно 5 узлов; каждый узел — полноценная сцена. Для 16+/18+ каждый узел должен содержать не менее 5 000 слов, чтобы каждый маршрут (scene-1 → ветка → финал) давал не менее 15 000 слов и около 2 часов чтения. Для детской/подростковой аудитории минимальный объём каждого узла: 6+ — 450 слов, 9+ — 550, 12+ — 650, 14+ — 750. Используй граф из пяти узлов: scene-1, scene-2a, scene-2b, ending-a, ending-b. В первой сцене два выбора — к scene-2a и scene-2b. В сценах 2a и 2b предусмотрены переходы к двум различным финалам; оба финала должны быть достижимы. У двух финалов choices: []. Не менее двух действительно разных концовок. Каждому узлу соответствует ровно одна отдельная иллюстрация, всего ровно пять; chapter — точное title узла. В image_start каждого узла помести соответствующий маркер {{illustration:ТОЧНЫЙ TITLE УЗЛА:N}}. В book_content дай заголовок и короткое вступление, сам текст сцен хранится в nodes.
- В интерактивной книге choices — массив объектов {text,next}; next обязан ссылаться на существующий id.
- Вопросы reader_questions: 3–5 содержательных пар question/answer, не помещай их в book_content.
- Сноски: минимум одна для возраста 6+ и старше; слово в word должно дословно встречаться в тексте сцен/глав, текст определения соответствует возрасту.
- Для обложки и всех иллюстраций используй единый визуальный стиль. Сначала придумай visual_style_anchor — короткую фразу с материалом/техникой, палитрой, светом и характером реализма. В точности повтори эту фразу в начале каждого illustration.prompt. Никаких букв, логотипов, водяных знаков и коллажей.
- Все image prompts на английском языке, конкретные и визуальные, максимум 1800 символов.
- Не создавай серию, если история не нуждается в продолжении. Не повторяй недавние сюжеты и темы.

Верни полный JSON. Не добавляй publication_key — он будет назначен системой.`;

async function generatePackage(attempt, previousError = "") {
  const providerConfig = config.daily_book.text_provider || {};
  const modelCandidates = [providerConfig.model, ...(providerConfig.fallback_models || [])].filter(Boolean);
  const modelIndex = Math.min(modelCandidates.length - 1, Math.floor((attempt - 1) / 2));
  const model = modelCandidates[modelIndex] || "openrouter/free";
  console.log("Using text model " + model + " (attempt " + attempt + ").");
  const retryInstruction = attempt > 1
    ? "\n\nПРЕДЫДУЩАЯ ПОПЫТКА НЕ ПРОШЛА ПРОВЕРКУ: " + previousError +
      ". Исправь именно эту ошибку. Не повторяй прежнее название. Если ошибка связана с названием — придумай полностью новое название, не похожее на перечисленные. Если ошибка связана со сноской — скопируй word целиком из готовой главы/сцены, включая точную форму слова (падеж и число); не используй начальную форму, если в тексте стоит другая. Лучше выбрать простое слово, которое легко найти в тексте. Если ошибка связана с объёмом — создай правильное число глав для выбранного возраста (взрослая 16+/18+: 10–14 глав; детская/подростковая: 5–9 глав) и дай каждой главе содержательный черновик; полный объём система нарастит отдельными последовательными запросами. Если ошибка Missing illustration marker — chapter в illustrations должен точно совпадать с заголовком главы; вставь соответствующий маркер в book_content. Если ответ был обрезан — сократи необязательные описания и промпты, сохранив полный текст книги и все обязательные поля. Обязательно верни book_content как полный текст книги; не заменяй его полем content или chapters."
    : "";
  const requestBody = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt + retryInstruction }
    ],
    temperature: 0.65,
    max_tokens: 16000
  };
  if ((providerConfig.json_mode_models || []).includes(model)) {
    requestBody.response_format = { type: "json_object" };
  }
  if ((providerConfig.reasoning_off_models || []).includes(model)) {
    requestBody.reasoning = { enabled: false };
  }
  if (openRouterDisabled || !OPENROUTER_API_KEY) {
    return parseModelJson(runCursorAgent(systemPrompt + "\n\n" + userPrompt + retryInstruction +
      "\n\nОБЯЗАТЕЛЬНО: верни только один полный JSON-объект без Markdown и пояснений.", { timeout: 900000 }));
  }
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENROUTER_API_KEY,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://kdnmgames.github.io/BookCheef/",
        "X-Title": "BookCheef Daily Publisher"
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(120000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body.error?.message || body.error?.metadata?.raw || "OpenRouter HTTP " + response.status;
      const provider = body.error?.metadata?.provider_name || body.error?.provider || "";
      const failure = new Error((message + (provider ? " (provider: " + provider + ")" : "")).slice(0, 700));
      if (response.status === 429 || /rate.?limit|quota|daily limit|credits exhausted/i.test(message)) failure.code = "RATE_LIMIT";
      throw failure;
    }
    const choice = body.choices?.[0];
    const rawContent = choice?.message?.content;
    const content = typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.map(part => typeof part === "string" ? part : (part?.text || "")).join("\n")
        : "";
    if (!content.trim()) {
      const detail = choice?.finish_reason ? " (finish_reason: " + choice.finish_reason + ")" : "";
      const providerError = body.error?.message || body.provider_error || "";
      throw new Error(("OpenRouter returned empty content" + detail + (providerError ? ": " + providerError : ".")).slice(0, 700));
    }
    const cleaned = content.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
    return JSON.parse(cleaned);
  } catch (error) {
    if (error.code === "RATE_LIMIT" || /rate.?limit|quota|daily limit|credits exhausted/i.test(error.message || "")) {
      await saveOpenRouterCooldown(error.message);
      return parseModelJson(runCursorAgent(systemPrompt + "\n\n" + userPrompt + retryInstruction +
        "\n\nОБЯЗАТЕЛЬНО: верни только один полный JSON-объект без Markdown и пояснений.", { timeout: 900000 }));
    }
    throw error;
  }
}

function slugify(value) {
  const map = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"yo",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"kh",ц:"ts",ч:"ch",ш:"sh",щ:"shch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
  return value.toLowerCase().replace(/[а-яё]/g,c=>map[c]??c).normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,70) || "book";
}

function normalizePackage(pkg) {
  if (!pkg || typeof pkg !== "object") return pkg;
  if (typeof pkg.book_content !== "string" || !pkg.book_content.trim()) {
    if (typeof pkg.content === "string" && pkg.content.trim()) pkg.book_content = pkg.content;
    else if (Array.isArray(pkg.chapters) && pkg.chapters.length) {
      pkg.book_content = pkg.chapters.map((chapter, index) => {
        const title = String(chapter.title || chapter.name || ("Глава " + (index + 1))).trim();
        const text = String(chapter.content || chapter.text || "").trim();
        return "## " + title + "\n\n" + text;
      }).join("\n\n");
    } else if (bookType === "interactive" && Array.isArray(pkg.interactive_content?.nodes)) {
      pkg.book_content = "# " + String(pkg.title || "Интерактивная книга") + "\n\n" + String(pkg.description || "");
    }
  }
  if (!Array.isArray(pkg.reader_questions) && Array.isArray(pkg.questions)) {
    pkg.reader_questions = pkg.questions.map(q => ({ question: q.question || q.q, answer: q.answer || q.a }));
  }
  if (!Array.isArray(pkg.footnotes) && Array.isArray(pkg.interactive_content?.footnotes)) {
    pkg.footnotes = pkg.interactive_content.footnotes;
  }
  if (typeof pkg.is_interactive !== "boolean") pkg.is_interactive = bookType === "interactive";
  if (pkg.series == null) pkg.series = "";
  if (Array.isArray(pkg.illustrations) && typeof pkg.book_content === "string" && bookType === "ordinary") {
    const headings = [...pkg.book_content.matchAll(/^##\s+(.+)$/gm)].map(match => ({
      title: match[1].trim(),
      index: match.index,
      end: match.index + match[0].length
    }));
    const norm = value => String(value || "").normalize("NFKC").toLocaleLowerCase("ru")
      .replace(/^глава\s+\d+[.:\s-]*/i, "")
      .replace(/[«»“”"'’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    for (let i = 0; i < pkg.illustrations.length; i++) {
      const item = pkg.illustrations[i];
      if (!item || !item.chapter || !item.number || !headings.length) continue;
      const wanted = norm(item.chapter);
      let heading = headings.find(h => norm(h.title) === wanted) ||
        headings.find(h => norm(h.title).includes(wanted) || wanted.includes(norm(h.title)));
      if (!heading) heading = headings[Math.min(i, headings.length - 1)];
      item.chapter = heading.title;
      const marker = "{{illustration:" + item.chapter + ":" + item.number + "}}";
      if (!pkg.book_content.includes(marker)) {
        const insertAt = heading.end;
        pkg.book_content = pkg.book_content.slice(0, insertAt) + "\n\n" + marker + "\n\n" + pkg.book_content.slice(insertAt);
      }
    }
  }
  return pkg;
}


function countWords(value) {
  return (String(value || "").match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu) || []).length;
}

async function expandPart({ title, age, genre, bookTitle, description, author, draft, priorContext, targetWords, minimumWords, partLabel, partIndex }) {
  const provider = config.daily_book.text_provider || {};
  const models = [provider.model, ...(provider.fallback_models || [])].filter(Boolean);
  let lastError;
  for (let retry = 0; retry < 3; retry++) {
    const model = models[(partIndex + retry) % Math.max(1, models.length)] || "openrouter/free";
    try {
      const systemText = "Ты — профессиональный автор BookCheef. Пиши только художественный текст на русском языке, без JSON, Markdown-заголовков и комментариев. Не пересказывай события — показывай их сценами. Не повторяй уже изложенное.";
      const userText =
        "Напиши ПОЛНОЦЕННУЮ расширенную часть книги «" + bookTitle + "» (" + age + ", жанр: " + genre + ", авторский голос: " + author + "). " +
        "Раздел: «" + title + "». " + partLabel + ". Целевой объём — не менее " + targetWords + " слов. " +
        "Описание книги: " + description + "\nКонтекст предыдущих событий (соблюдай непрерывность): " + (priorContext || "Это начало истории.") +
        "\nЧерновик этой части, который нужно развить и существенно расширить, сохранив все важные события и смысл: " + draft +
        "\nТребования: цельная художественная проза; полноценные сцены, диалоги, причинно-следственные связи, атмосфера, эмоциональное развитие; не добавляй новые несогласованные сюжетные линии; не пересказывай черновик; не заканчивай всю книгу, если это не финальная глава. Выведи только текст этой части. Проверь, что объём близок к целевому.";
      let generatedText;
      if (openRouterDisabled || !OPENROUTER_API_KEY) {
        generatedText = runCursorAgent(systemText + "\n\n" + userText, { timeout: 900000 });
      } else {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + OPENROUTER_API_KEY,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://kdnmgames.github.io/BookCheef/",
            "X-Title": "BookCheef Long-form Chapter Writer"
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "system", content: systemText }, { role: "user", content: userText }],
            temperature: 0.72,
            max_tokens: 10000
          }),
          signal: AbortSignal.timeout(180000)
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = body.error?.message || "OpenRouter HTTP " + response.status;
          const failure = new Error(message);
          if (response.status === 429 || /rate.?limit|quota|daily limit|credits exhausted/i.test(message)) failure.code = "RATE_LIMIT";
          throw failure;
        }
        const raw = body.choices?.[0]?.message?.content;
        generatedText = (typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(x => x?.text || "").join("\n") : "")
          .trim().replace(/^\x60{3}[^\n]*\n?/,"").replace(/\n?\x60{3}$/,"").trim();
      }
      const words = countWords(generatedText);
      if (words < (Number(minimumWords) || Math.floor(targetWords * 0.78))) throw new Error("Part too short: " + words + " words; minimum " + (Number(minimumWords) || Math.floor(targetWords * 0.78)) + ".");
      return generatedText;
    } catch (error) {
      lastError = error;
      if (error.code === "RATE_LIMIT" || /rate.?limit|quota|daily limit|credits exhausted/i.test(error.message || "")) {
        await saveOpenRouterCooldown(error.message);
        try {
          const systemText = "Ты — профессиональный автор BookCheef. Пиши только художественный текст на русском языке, без JSON, Markdown-заголовков и комментариев. Не пересказывай события — показывай их сценами. Не повторяй уже изложенное.";
          const userText = "Напиши ПОЛНОЦЕННУЮ расширенную часть книги «" + bookTitle + "» (" + age + ", жанр: " + genre + ", авторский голос: " + author + "). Раздел: «" + title + "». " + partLabel + ". Целевой объём — не менее " + targetWords + " слов. Описание: " + description + "\\nКонтекст: " + (priorContext || "Начало истории.") + "\\nЧерновик: " + draft + "\\nСохрани события, напиши полноценную прозу, выведи только текст части.";
          const fallbackText = runCursorAgent(systemText + "\\n\\n" + userText, { timeout: 900000 });
          const fallbackWords = countWords(fallbackText);
          if (fallbackWords < (Number(minimumWords) || Math.floor(targetWords * 0.78))) throw new Error("Cursor fallback part too short: " + fallbackWords + " words.");
          return fallbackText;
        } catch (fallbackError) {
          lastError = fallbackError;
          console.warn("Cursor fallback also failed: " + fallbackError.message);
          throw fallbackError;
        }
      }
      console.warn("Long-form expansion retry " + (retry + 1) + " for " + title + ": " + error.message);
    }
  }
  throw new Error("Could not expand " + title + ": " + (lastError?.message || "unknown error"));
}

async function expandOrdinaryBook(pkg) {
  if (bookType !== "ordinary") return pkg;
  const matches = [...pkg.book_content.matchAll(/^##\s+(.+)$/gm)];
  const age = String(pkg.age || "12+");
  const adult = age === "16+" || age === "18+";
  const minChapters = adult ? 10 : (age === "12+" || age === "14+" ? 6 : 5);
  const maxChapters = adult ? 14 : 9;
  if (matches.length < minChapters || matches.length > maxChapters) {
    throw new Error("Chapter count does not fit the selected reading age: " + matches.length + "; expected " + minChapters + "-" + maxChapters + ".");
  }
  const targetWords = adult ? 1900 : age === "6+" ? 300 : age === "9+" ? 350 : age === "12+" ? 400 : 450;
  const minWords = adult ? 1800 : age === "6+" ? 250 : age === "9+" ? 300 : age === "12+" ? 350 : 400;
  const totalMinimum = adult ? 18000 : age === "6+" ? 1500 : age === "9+" ? 1800 : age === "12+" ? 2400 : 2700;
  const parts = [];
  let previous = "";
  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : pkg.book_content.length;
    let draft = pkg.book_content.slice(start, end).trim();
    const markerPattern = /\{\{illustration:[^}]+\}\}/g;
    const markers = [...draft.matchAll(markerPattern)].map(x => x[0]);
    draft = draft.replace(markerPattern, "").trim();
    const currentWords = countWords(draft);
    let expanded = draft;
    if (currentWords < minWords) {
      console.log("Expanding chapter " + (i + 1) + "/" + matches.length + ": " + heading + " (" + currentWords + " words; target " + targetWords + ").");
      expanded = await expandPart({
        title: heading, age, genre: pkg.genre, bookTitle: pkg.title, description: pkg.description,
        author: pkg.author, draft, priorContext: previous.slice(-1800), targetWords, minimumWords: minWords,
        partLabel: "Глава " + (i + 1) + " из " + matches.length, partIndex: i
      });
    }
    if (countWords(expanded) < minWords) throw new Error("Chapter " + heading + " is below the required word count.");
    const markerForChapter = pkg.illustrations.find(x => x.chapter === heading);
    const allMarkers = [...new Set([...markers, ...(markerForChapter ? ["{{illustration:" + heading + ":" + markerForChapter.number + "}}"] : [])])];
    parts.push("## " + heading + "\n\n" + (allMarkers.length ? allMarkers.join("\n") + "\n\n" : "") + expanded);
    const remaining = i + 1 < matches.length ? pkg.book_content.slice(matches[i + 1].index) : "";
    await saveWork({ ...pkg, book_content: parts.join("\n\n") + (remaining ? "\n\n" + remaining : "") });
    previous = expanded;
  }
  pkg.book_content = parts.join("\n\n");
  const total = countWords(pkg.book_content);
  if (total < totalMinimum) throw new Error("Book is too short after chapter expansion: " + total + " words; minimum " + totalMinimum + ".");
  console.log("Long-form ordinary book completed: " + total + " words, " + matches.length + " chapters.");
  return pkg;
}

function interactiveContext(nodes, nodeId) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const ids = nodeId === "scene-1" ? [] :
    nodeId === "scene-2a" || nodeId === "scene-2b" ? ["scene-1"] :
    nodeId === "ending-a" ? ["scene-1", "scene-2a"] :
    ["scene-1", "scene-2b"];
  return ids.map(id => {
    const node = byId.get(id);
    return node ? node.title + ": " + node.text.slice(-700) : "";
  }).filter(Boolean).join("\n") || "Начало истории.";
}

async function expandInteractiveBook(pkg) {
  if (bookType !== "interactive") return pkg;
  const age = String(pkg.age || "12+");
  const adult = age === "16+" || age === "18+";
  const targetWords = adult ? 5600 : age === "6+" ? 520 : age === "9+" ? 620 : age === "12+" ? 720 : 820;
  const minWords = adult ? 5000 : age === "6+" ? 450 : age === "9+" ? 550 : age === "12+" ? 650 : 750;
  for (let i = 0; i < pkg.interactive_content.nodes.length; i++) {
    const node = pkg.interactive_content.nodes[i];
    const current = countWords(node.text);
    if (current < minWords) {
      console.log("Expanding interactive scene " + node.id + " (" + current + " words; target " + targetWords + ").");
      node.text = await expandPart({
        title: node.title, age, genre: pkg.genre, bookTitle: pkg.title, description: pkg.description,
        author: pkg.author, draft: node.text, priorContext: interactiveContext(pkg.interactive_content.nodes, node.id),
        targetWords, minimumWords: minWords, partLabel: "Интерактивная сцена " + (i + 1) + " из 5", partIndex: i
      });
    }
    if (countWords(node.text) < minWords) throw new Error("Interactive scene " + node.id + " is too short.");
    await saveWork(pkg);
  }
  const byId = new Map(pkg.interactive_content.nodes.map(n => [n.id, n]));
  const routeA = countWords(byId.get("scene-1").text) + countWords(byId.get("scene-2a").text) + countWords(byId.get("ending-a").text);
  const routeB = countWords(byId.get("scene-1").text) + countWords(byId.get("scene-2b").text) + countWords(byId.get("ending-b").text);
  const routeMinimum = adult ? 15000 : minWords * 3;
  if (routeA < routeMinimum || routeB < routeMinimum) throw new Error("Interactive route is below its reading-length minimum.");
  console.log("Long-form interactive routes: " + routeA + " and " + routeB + " words.");
  return pkg;
}

async function expandBook(pkg) {
  if (bookType === "ordinary") return expandOrdinaryBook(pkg);
  return expandInteractiveBook(pkg);
}

function validate(pkg) {
  if (!pkg || typeof pkg !== "object") throw new Error("Model output is not an object.");
  for (const key of ["title","category","description","author","age","genre","book_content"]) {
    if (typeof pkg[key] !== "string" || !pkg[key].trim()) throw new Error("Missing required field: " + key);
  }
  if (pkg.title.length > 180) throw new Error("Title is too long.");
  if (!authors.some(author => author.author === pkg.author)) throw new Error("The selected author is not in the BookCheef author pool.");
  const normalizeTitle = value => String(value).normalize("NFKC").toLocaleLowerCase("ru").replace(/[«»“”"'’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  if (existingTitles.some(title => normalizeTitle(title) === normalizeTitle(pkg.title))) throw new Error("The generated title duplicates an existing inbox title. Choose a completely different title, not a variation.");
  if (!/^(6|9|12|14|16|18)\+$/.test(pkg.age.trim())) throw new Error("Age rating is not one of the supported categories.");
  if (pkg.is_interactive !== (bookType === "interactive")) throw new Error("Book type differs from rotation state.");
  if (pkg.is_free !== true) throw new Error("Daily books must be free.");
  if (!Array.isArray(pkg.reader_questions) || pkg.reader_questions.length < 3 || pkg.reader_questions.length > 5 ||
      pkg.reader_questions.some(q=>!q.question?.trim() || !q.answer?.trim())) throw new Error("reader_questions validation failed.");
  if (!Array.isArray(pkg.illustrations) || pkg.illustrations.length < 1 || pkg.illustrations.length > 5) throw new Error("Illustrations must contain 1-5 entries.");
  if (!pkg.cover?.prompt?.trim()) throw new Error("Missing cover prompt.");
  const anchor = String(pkg.cover.visual_style_anchor || "Cinematic painterly digital realism, finely etched details, cohesive restrained color palette, atmospheric directional lighting, consistent material textures.").trim();
  pkg.cover.visual_style_anchor = anchor;
  pkg.cover.prompt = anchor + " " + String(pkg.cover.prompt).trim();
  for (let i=0;i<pkg.illustrations.length;i++) {
    const item=pkg.illustrations[i];
    item.number=i+1;
    if (!item.chapter?.trim() || !item.prompt?.trim()) throw new Error("Illustration " + (i+1) + " is incomplete.");
    item.prompt = anchor + " " + item.prompt.replace(anchor,"").trim();
    if (item.prompt.length > 1800) throw new Error("Illustration prompt is too long.");
  }
  if (!Array.isArray(pkg.footnotes) && Array.isArray(pkg.interactive_content?.footnotes)) {
    pkg.footnotes = pkg.interactive_content.footnotes;
  }
  const combinedText = [pkg.book_content, ...(pkg.interactive_content?.nodes||[]).map(n=>n.text||"")].join("\n");
  if (!Array.isArray(pkg.footnotes) || pkg.footnotes.length < 1) {
    throw new Error("At least one valid footnote is required.");
  }
  const normalizeFootnoteToken = value => String(value || "").normalize("NFKC")
    .toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const bookTokens = [...combinedText.matchAll(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu)].map(match => match[0]);
  for (const note of pkg.footnotes) {
    if (!note?.word?.trim() || !note?.text?.trim()) {
      throw new Error("Each footnote must contain a word and its definition.");
    }
    const wanted = normalizeFootnoteToken(note.word);
    if (!wanted) throw new Error("Footnote word is empty after normalization.");
    const exact = bookTokens.find(token => normalizeFootnoteToken(token) === wanted);
    if (exact) {
      note.word = exact;
      continue;
    }
    // Russian words often appear in the story in an inflected form.
    // Match only a strong shared stem, then store the exact surface form from the text.
    const stemMatch = bookTokens.find(token => {
      const actual = normalizeFootnoteToken(token);
      let common = 0;
      while (common < actual.length && common < wanted.length && actual[common] === wanted[common]) common++;
      return Math.min(actual.length, wanted.length) >= 5 &&
        common >= Math.max(5, Math.ceil(Math.min(actual.length, wanted.length) * 0.7));
    });
    if (stemMatch) {
      note.word = stemMatch;
      console.log("Adjusted footnote word to its exact form in the book: " + note.word);
      continue;
    }
    throw new Error("Footnote word \"" + note.word + "\" does not appear in book text. Copy an exact word from a chapter or scene.");
  }
  if (pkg.cover.prompt.length > 1800) throw new Error("Cover prompt is too long.");
  const tokens = [...combinedText.matchAll(/\{\{illustration:([^:}]+):(\d+)\}\}/g)];
  if (bookType === "ordinary") {
    const ordinaryWords=countWords(pkg.book_content); const adult=pkg.age==="16+"||pkg.age==="18+"; const minimum=adult?18000:pkg.age==="6+"?1500:pkg.age==="9+"?1800:pkg.age==="12+"?2400:2700; if(ordinaryWords<minimum) throw new Error("Ordinary book is too short ("+ordinaryWords+" words; minimum "+minimum+").");
    for (const item of pkg.illustrations) {
      if (!pkg.book_content.includes("{{illustration:" + item.chapter + ":" + item.number + "}}")) throw new Error("Missing illustration marker for " + item.chapter);
    }
    if (pkg.interactive_content !== undefined) throw new Error("Ordinary book must not contain interactive_content.");
  } else {
    const data=pkg.interactive_content;
    if (!data || !Array.isArray(data.nodes) || data.nodes.length!==5 || data.start!=="scene-1") throw new Error("Interactive book must contain exactly five scenes.");
    if (pkg.illustrations.length!==5) throw new Error("Interactive books require exactly five illustrations.");
    const ids=new Set(data.nodes.map(n=>n.id));
    if (ids.size!==5 || !["scene-1","scene-2a","scene-2b","ending-a","ending-b"].every(id=>ids.has(id))) throw new Error("Interactive scene IDs are invalid.");
    const byId=new Map(data.nodes.map(n=>[n.id,n]));
    for (const node of data.nodes) {
      const ageMinimum=pkg.age==="16+"||pkg.age==="18+"?5000:pkg.age==="6+"?450:pkg.age==="9+"?550:pkg.age==="12+"?650:750; if (!node.title?.trim() || typeof node.text!=="string" || countWords(node.text)<ageMinimum || !Array.isArray(node.choices)) throw new Error("Interactive scene is incomplete or too short: "+node.id);
      for (const choice of node.choices) if (!choice.text?.trim() || !ids.has(choice.next)) throw new Error("Invalid branch in "+node.id);
      const index=Number(node.id==="scene-1"?1:node.id==="scene-2a"?2:node.id==="scene-2b"?3:node.id==="ending-a"?4:5);
      const illustration=pkg.illustrations.find(x=>x.number===index && x.chapter===node.title);
      if (!illustration) throw new Error("Scene illustration does not match "+node.title);
      node.image_start="{{illustration:"+node.title+":"+index+"}}";
      node.image_start_alt=node.image_start_alt || "Illustration for "+node.title;
    }
    if (byId.get("scene-1").choices.length!==2 ||
        !byId.get("scene-1").choices.some(c=>c.next==="scene-2a") ||
        !byId.get("scene-1").choices.some(c=>c.next==="scene-2b") ||
        byId.get("ending-a").choices.length!==0 || byId.get("ending-b").choices.length!==0) {
      throw new Error("Interactive graph must branch into two paths and have two endings.");
    }
    const visited=new Set(); const stack=[data.start];
    while(stack.length){const id=stack.pop();if(visited.has(id))continue;visited.add(id);for(const c of byId.get(id).choices)stack.push(c.next);}
    if(visited.size!==5) throw new Error("Every interactive scene must be reachable.");
    if (pkg.book_content.length<100) throw new Error("Interactive book introduction is missing.");
  }
  pkg.publication_key="bookcheef-"+today+"-"+slugify(pkg.title);
  pkg.is_free=true;
  pkg.is_interactive=bookType==="interactive";
  return pkg;
}

let pkg = await loadWork(), lastError;
const maxAttempts = Math.max(1, Number(config.daily_book.text_provider?.max_attempts) || 8);
if (pkg) {
  pkg = validate(await expandBook(pkg));
} else {
for (let attempt=1; attempt<=maxAttempts; attempt++) {
  try { const candidate=await generatePackage(attempt,lastError?.message||""); console.log("Model output fields:",Object.keys(candidate||{}).join(", ")); const normalized=normalizePackage(candidate); await saveWork(normalized); pkg=validate(await expandBook(normalized)); break; }
  catch(error) {
    lastError=error;
    console.error("Generation/validation attempt "+attempt+" failed: "+error.message);
    if (error.code === "RATE_LIMIT" || /rate.?limit|quota|daily limit/i.test(error.message)) {
      const retryAfter = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
      await fs.writeFile(COOLDOWN_PATH, JSON.stringify({ detected_at: new Date().toISOString(), retry_after: retryAfter, reason: error.message }, null, 2) + "\n");
      if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, "package_path=\ncreated=false\n");
      console.error("Quota reached; pausing generation until " + retryAfter + ".");
      break;
    }
    if (attempt<maxAttempts) await new Promise(resolve=>setTimeout(resolve, Math.max(1,Number(config.daily_book.text_provider?.retry_delay_seconds)||30)*1000));
  }
}
}
if (!pkg && (lastError?.code === "RATE_LIMIT" || /rate.?limit|quota|daily limit/i.test(lastError?.message || ""))) {
  console.log("All configured text providers are unavailable or quota-limited. The checkpoint remains saved; no book was published and rotation was not advanced.");
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, "package_path=\ncreated=false\n");
  process.exit(0);
}
if (!pkg) throw new Error("Could not create a valid book after retries: "+(lastError?.message||"unknown error"));

const fileName=today+"-"+slugify(pkg.title)+".json";
const filePath=path.join(INBOX,fileName);
await fs.writeFile(filePath,JSON.stringify(pkg,null,2)+"\n",{flag:"wx"});
const pendingQueuePath="book-publications/pending-publications.json";
const pendingQueue=JSON.parse(await fs.readFile(pendingQueuePath,"utf8"));
pendingQueue.packages=Array.isArray(pendingQueue.packages)?pendingQueue.packages:[];
pendingQueue.packages.push({path:filePath,title:pkg.title,publication_key:pkg.publication_key,created_at:new Date().toISOString()});
pendingQueue.updated_at=new Date().toISOString();
await fs.writeFile(pendingQueuePath,JSON.stringify(pendingQueue,null,2)+"\n");
await fs.rm(WORK_PATH, { force: true });
console.log("Created "+filePath+" ("+pkg.title+") and added it to the explicit retry queue.");
console.log("Type: "+bookType+"; rotation position remains unchanged until verified publication.");
if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(process.env.GITHUB_OUTPUT,"package_path="+filePath+"\ncreated=true\n");
}
