import fs from "node:fs";
import path from "node:path";

const queries = [
  '"книжный клуб" (набор OR сообщество OR обсуждение)',
  '"литературный форум" авторы читатели',
  '"форум фантастики" OR "сообщество фантастики"',
  '"книжное сообщество" читатели',
  '"клуб любителей фэнтези" OR "клуб любителей фантастики"'
];

const decode = (value = "") => value
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

const getTag = (xml, tag) => {
  const match = xml.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i"));
  return match ? decode(match[1]) : "";
};

const results = [];
const failures = [];
for (const query of queries) {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "ru");
  url.searchParams.set("gl", "RU");
  url.searchParams.set("ceid", "RU:ru");
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "BookCheefResearchBot/1.0 (+https://kdnmgames.github.io/BookCheef/)" },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const xml = await response.text();
    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
    for (const match of items) {
      const item = match[1];
      const title = getTag(item, "title");
      const link = getTag(item, "link");
      const pubDate = getTag(item, "pubDate");
      const source = getTag(item, "source");
      if (title && link) results.push({ query, title, link, pubDate, source });
    }
  } catch (error) {
    failures.push(query + ": " + error.message);
  }
}

const unique = new Map();
for (const item of results) {
  const key = item.link || item.title;
  if (!unique.has(key)) unique.set(key, item);
}
const items = [...unique.values()].sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));
const lines = [
  "# BookCheef — кандидаты для исследования сообществ",
  "",
  "- Источник поиска: публичные RSS-результаты Google News, русский язык / регион RU.",
  "- Режим: только сбор кандидатов; никаких публикаций, писем или автоматического изменения статусов площадок.",
  "- RSS-поиск не является официальным API с гарантией доступности; результаты могут быть неполными и содержать обычные новости.",
  "- Каждую площадку необходимо открыть отдельно, найти её собственные действующие правила и проверить разрешение на саморекламу.",
  "- Дата сбора: " + new Date().toISOString(),
  "- Уникальных результатов: " + items.length,
  "- Ошибок лент: " + failures.length,
  "",
  "## Найденные материалы для ручной проверки",
  ""
];
if (!items.length) lines.push("Новых материалов не получено.");
for (const item of items.slice(0, 100)) {
  lines.push("### " + item.title);
  lines.push("- Площадка/источник: " + (item.source || "не определён"));
  lines.push("- Дата: " + (item.pubDate || "не указана"));
  lines.push("- Запрос: " + item.query);
  lines.push("- Ссылка: " + item.link);
  lines.push("- Статус: review_required — это только поисковая находка, не разрешение на продвижение.");
  lines.push("");
}
if (failures.length) {
  lines.push("## Ошибки получения RSS");
  for (const failure of failures) lines.push("- " + failure);
}
const output = path.join("marketing", "reports", "community-discovery-latest.md");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, lines.join("\n") + "\n", "utf8");
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) fs.appendFileSync(summary, lines.join("\n") + "\n");
console.log("Collected " + items.length + " unique RSS results; " + failures.length + " feed errors.");
