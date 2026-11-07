const feeds = [
  "https://readrate.com/rus/rss/news",
];

const token = process.env.TELEGRAM_BOT_TOKEN;
const channel = process.env.TELEGRAM_CHANNEL_ID || "@BookCheef";
const statePath = "book-publications/telegram-news-state.json";
if (!token) throw new Error("TELEGRAM_BOT_TOKEN secret is missing");

const fs = await import("node:fs");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const seen = new Set(state.seen || []);
const cutoff = Date.now() - 5 * 24 * 60 * 60 * 1000;

function decode(value = "") {
  return value
    .replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g, "$1")
    .replace(/<(br|\\/p|\\/div|\\/li)\\b[^>]*>/gi, "\\n\\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .split("\\n").map(line => line.replace(/[ \\t]+/g, " ").trim()).filter(Boolean).join("\\n\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
}

function tag(block, name) {
  const re = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i");
  return decode(block.match(re)?.[1] || "");
}

function parseItems(xml) {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(m => m[0]);
  return blocks.map(block => {
    const title = tag(block, "title");
    const description = tag(block, "description") || tag(block, "summary") || tag(block, "content");
    const dateText = tag(block, "pubDate") || tag(block, "published") || tag(block, "updated");
    const atomLink = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1];
    const link = tag(block, "link") || atomLink || "";
    const date = Date.parse(dateText);
    return { title, description, link, date };
  }).filter(x => x.title && /^https?:\/\//i.test(x.link) && Number.isFinite(x.date) && x.date >= cutoff);
}

async function send(text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: channel, text, parse_mode: "HTML", disable_web_page_preview: false }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error("Telegram sendMessage failed: " + (result.description || response.status));
}

const candidates = [];
for (const url of feeds) {
  try {
    const response = await fetch(url, { headers: { "user-agent": "BookCheefNewsBot/1.0" } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const xml = await response.text();
    candidates.push(...parseItems(xml).map(item => ({ ...item, feed: url })));
  } catch (error) {
    console.log("Feed unavailable:", url, String(error));
  }
}
const unique = [...new Map(candidates.map(x => [x.link, x])).values()]
  .filter(x => !seen.has(x.link))
  .sort((a, b) => b.date - a.date)
  .slice(0, 1);

if (!unique.length) {
  console.log("No new verified RSS items in the last five days; nothing posted.");
} else {
  for (const item of unique) {
    const excerpt = item.description.length > 700 ? item.description.slice(0, 699).trimEnd() + "…" : item.description;
    const post = [
      "📰 <b>КНИЖНЫЕ НОВОСТИ</b>",
      "",
      "📖 <b>" + item.title + "</b>",
      excerpt ? excerpt : "",
      "",
      "🔗 <a href=\"" + item.link + "\">Читать источник</a>",
      "",
      "📚 BookCheef — https://kdnmgames.github.io/BookCheef/",
    ].filter(Boolean).join("\n");
    await send(post.slice(0, 3900));
    seen.add(item.link);
    console.log("Published:", item.title);
  }
  state.seen = [...seen].slice(-300);
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}
