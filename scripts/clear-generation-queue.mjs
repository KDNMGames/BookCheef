import fs from "node:fs/promises";
import path from "node:path";

const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
if (!base || !key) throw new Error("Cannot verify queue-clear request: Supabase credentials are missing.");

const endpoint = base + "/rest/v1/bookcheef_generation_control?id=eq.true&select=enabled,clear_requested,clear_requested_at,clear_requested_by";
const headers = { apikey: key, Authorization: "Bearer " + key };
const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10000) });
if (!response.ok) throw new Error("Cannot read queue-clear state: HTTP " + response.status);
const rows = await response.json();
if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Generation control row is missing or ambiguous.");
const control = rows[0];
if (!control.clear_requested) {
  console.log("No full queue-clear request is pending.");
  process.exit(0);
}
if (control.enabled !== false) throw new Error("Refusing to clear while generation is enabled; stop state must be confirmed first.");

const removed = [];
async function removeIfExists(relativePath) {
  const full = path.resolve(relativePath);
  const root = path.resolve("book-publications");
  if (!full.startsWith(root + path.sep)) throw new Error("Unsafe cleanup path: " + relativePath);
  try {
    await fs.rm(full, { recursive: true, force: true });
    removed.push(relativePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
for (const type of ["ordinary", "interactive", "novel"]) {
  await removeIfExists("book-publications/workers/" + type);
  await fs.mkdir("book-publications/workers/" + type, { recursive: true });
}
for (const relativePath of [
  "book-publications/deferred-books.json",
  "book-publications/pending-publications.json",
  "book-publications/work-in-progress",
  "book-publications/inbox",
  "book-publications/provider-cooldown.json",
  "book-publications/cursor-cooldown.json",
  "book-publications/gemini-cooldown.json"
]) await removeIfExists(relativePath);

await fs.mkdir("book-publications/inbox", { recursive: true });
await fs.mkdir("book-publications/work-in-progress", { recursive: true });
await fs.writeFile("book-publications/pending-publications.json", JSON.stringify({ packages: [], updated_at: new Date().toISOString() }, null, 2) + "\n");
await fs.writeFile("book-publications/deferred-books.json", JSON.stringify({ tasks: [], updated_at: new Date().toISOString() }, null, 2) + "\n");
const rotationPath = "book-publications/rotation-state.json";
try {
  const rotation = JSON.parse(await fs.readFile(rotationPath, "utf8"));
  rotation.cycle_position = 1;
  rotation.updated_at = new Date().toISOString();
  delete rotation.note;
  await fs.writeFile(rotationPath, JSON.stringify(rotation, null, 2) + "\n");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const reset = await fetch(base + "/rest/v1/bookcheef_generation_control?id=eq.true", {
  method: "PATCH",
  headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify({ clear_requested: false, clear_requested_at: null, clear_requested_by: null, updated_at: new Date().toISOString(), updated_by: "queue-clear-worker" })
});
if (!reset.ok) throw new Error("Files were cleared but the request flag could not be reset: HTTP " + reset.status + " " + (await reset.text()).slice(0, 300));
const resetRows = await reset.json();
if (!Array.isArray(resetRows) || resetRows.length !== 1 || resetRows[0].clear_requested !== false) throw new Error("Queue-clear request reset was not confirmed.");

const summary = "🧹 BookCheef: полная очистка очереди выполнена. Удалены незавершённые черновики, контрольные точки, отложенные задачи, очереди публикации и метаданные исполнителей. Опубликованные книги не затронуты. Генератор остаётся остановленным; для возобновления используй /genstart.";
console.log(summary);
console.log("Removed stores: " + removed.join(", "));
const token = process.env.TELEGRAM_BOT_TOKEN;
if (token) {
  const notify = await fetch("https://wendffewxxmnaglfksfg.supabase.co/functions/v1/telegram-bot", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bookcheef-report-token": token },
    body: JSON.stringify({ action: "admin_notification", text: summary }),
    signal: AbortSignal.timeout(15000)
  });
  if (!notify.ok) console.warn("Telegram cleanup notification failed: HTTP " + notify.status);
}
