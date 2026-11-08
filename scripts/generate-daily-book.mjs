import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const CONFIG_PATH = "book-publications/automation-config.json";
const ROTATION_PATH = "book-publications/rotation-state.json";
const INBOX = "book-publications/inbox";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

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

if (!OPENROUTER_API_KEY) throw new Error("Missing OPENROUTER_API_KEY secret.");
const position = Number(rotation.cycle_position) || 1;
const cycle = config.daily_book.rotation || ["interactive", "ordinary", "ordinary"];
const bookType = cycle[(position - 1) % cycle.length];
const authorDir = "book-publications/authors";
const authorFiles = (await fs.readdir(authorDir)).filter(x => x.endsWith(".json")).sort();
const authors = [];
for (const name of authorFiles) {
  authors.push(JSON.parse(await fs.readFile(path.join(authorDir, name), "utf8")));
}
const existingFiles = (await fs.readdir(INBOX)).filter(x => x.endsWith(".json")).sort().slice(-40);
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
- Обычная книга: не менее 5 000 символов book_content; 3–6 глав с заголовками ## Глава N. Название. Каждая глава — полноценная сцена, а не абзац. Вставь маркеры иллюстраций вида {{illustration:ТОЧНЫЙ ЗАГОЛОВОК ГЛАВЫ:1}} в подходящих местах. 1–5 иллюстраций, у каждой chapter совпадает с заголовком главы.
- Интерактивная книга: ровно 5 узлов; каждый узел — полноценная сцена не менее 700 символов. Используй граф из пяти узлов: scene-1, scene-2a, scene-2b, ending-a, ending-b. В первой сцене два выбора — к scene-2a и scene-2b. В сценах 2a и 2b предусмотрены переходы к двум различным финалам; оба финала должны быть достижимы. У двух финалов choices: []. Не менее двух действительно разных концовок. Каждому узлу соответствует ровно одна отдельная иллюстрация, всего ровно пять; chapter — точное title узла. В image_start каждого узла помести соответствующий маркер {{illustration:ТОЧНЫЙ TITLE УЗЛА:N}}. В book_content дай заголовок и короткое вступление, сам текст сцен хранится в nodes.
- В интерактивной книге choices — массив объектов {text,next}; next обязан ссылаться на существующий id.
- Вопросы reader_questions: 3–5 содержательных пар question/answer, не помещай их в book_content.
- Сноски: минимум одна для возраста 6+ и старше; слово в word должно дословно встречаться в тексте сцен/глав, текст определения соответствует возрасту.
- Для обложки и всех иллюстраций используй единый визуальный стиль. Сначала придумай visual_style_anchor — короткую фразу с материалом/техникой, палитрой, светом и характером реализма. В точности повтори эту фразу в начале каждого illustration.prompt. Никаких букв, логотипов, водяных знаков и коллажей.
- Все image prompts на английском языке, конкретные и визуальные, максимум 1800 символов.
- Не создавай серию, если история не нуждается в продолжении. Не повторяй недавние сюжеты и темы.

Верни полный JSON. Не добавляй publication_key — он будет назначен системой.`;

async function generatePackage(attempt) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + OPENROUTER_API_KEY,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://kdnmgames.github.io/BookCheef/",
      "X-Title": "BookCheef Daily Publisher"
    },
    body: JSON.stringify({
      model: config.daily_book.text_provider?.model || "openrouter/free",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt + (attempt > 1 ? "\n\nПРЕДЫДУЩАЯ ПОПЫТКА НЕ ПРОШЛА ПРОВЕРКУ. Сгенерируй полностью новый корректный вариант и внимательно соблюдай все ограничения." : "") }
      ],
      temperature: 0.75,
      max_tokens: 14000,
      response_format: { type: "json_object" }
    }),
    signal: AbortSignal.timeout(120000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error?.message || "OpenRouter HTTP " + response.status;
    throw new Error(message.slice(0, 700));
  }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("OpenRouter returned empty content.");
  const cleaned = content.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
  return JSON.parse(cleaned);
}

function slugify(value) {
  const map = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"yo",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"kh",ц:"ts",ч:"ch",ш:"sh",щ:"shch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
  return value.toLowerCase().replace(/[а-яё]/g,c=>map[c]??c).normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,70) || "book";
}

function validate(pkg) {
  if (!pkg || typeof pkg !== "object") throw new Error("Model output is not an object.");
  for (const key of ["title","category","description","author","age","genre","book_content"]) {
    if (typeof pkg[key] !== "string" || !pkg[key].trim()) throw new Error("Missing required field: " + key);
  }
  if (pkg.title.length > 180) throw new Error("Title is too long.");
  if (!authors.some(author => author.author === pkg.author)) throw new Error("The selected author is not in the BookCheef author pool.");
  if (existingTitles.some(title => title.trim().toLocaleLowerCase() === pkg.title.trim().toLocaleLowerCase())) throw new Error("The generated title duplicates an existing inbox title.");
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
  if (!Array.isArray(pkg.footnotes) || pkg.footnotes.length < 1 ||
      pkg.footnotes.some(f=>!f.word?.trim() || !f.text?.trim() || !combinedText.includes(f.word))) {
    throw new Error("Footnotes must define words that actually appear in the book.");
  }
  if (pkg.cover.prompt.length > 1800) throw new Error("Cover prompt is too long.");
  const tokens = [...combinedText.matchAll(/\{\{illustration:([^:}]+):(\d+)\}\}/g)];
  if (bookType === "ordinary") {
    if (pkg.book_content.length < 5000) throw new Error("Ordinary book is too short.");
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
      if (!node.title?.trim() || typeof node.text!=="string" || node.text.length<700 || !Array.isArray(node.choices)) throw new Error("Interactive scene is incomplete: "+node.id);
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

let pkg, lastError;
const maxAttempts = Math.max(1, Number(config.daily_book.text_provider?.max_attempts) || 3);
for (let attempt=1; attempt<=maxAttempts; attempt++) {
  try { pkg=validate(await generatePackage(attempt)); break; }
  catch(error) {
    lastError=error;
    console.error("Generation/validation attempt "+attempt+" failed: "+error.message);
    if (attempt<maxAttempts) await new Promise(resolve=>setTimeout(resolve, Math.max(1,Number(config.daily_book.text_provider?.retry_delay_seconds)||30)*1000));
  }
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
console.log("Created "+filePath+" ("+pkg.title+") and added it to the explicit retry queue.");
console.log("Type: "+bookType+"; rotation position remains unchanged until verified publication.");
if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(process.env.GITHUB_OUTPUT,"package_path="+filePath+"\ncreated=true\n");
}
