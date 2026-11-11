import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://kdnmgames.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(keyBytes: Uint8Array, data: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}
async function verifyInitData(raw: string, botToken: string) {
  if (!raw || raw.length > 8192) return null;
  const params = new URLSearchParams(raw);
  const receivedHash = params.get("hash") || "";
  if (!/^[a-f0-9]{64}$/i.test(receivedHash)) return null;
  const pairs: string[] = [];
  params.forEach((value, key) => { if (key !== "hash") pairs.push(key + "=" + value); });
  pairs.sort();
  const secret = await hmac(new TextEncoder().encode("WebAppData"), botToken);
  const expected = hex(await hmac(secret, pairs.join("\n")));
  if (expected !== receivedHash.toLowerCase()) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    if (!user || !/^\d{1,20}$/.test(String(user.id))) return null;
    return user;
  } catch { return null; }
}
function env(name: string) { return Deno.env.get(name) || ""; }
function adminIds() { return new Set(env("TELEGRAM_ADMIN_IDS").split(",").map((x) => x.trim()).filter(Boolean)); }
async function rest(path: string, init: RequestInit = {}) {
  const base = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) throw new Error("Supabase service credentials unavailable");
  const response = await fetch(base + "/rest/v1/" + path, {
    ...init,
    headers: { apikey: key, Authorization: "Bearer " + key, ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error("Database request failed: HTTP " + response.status);
  return response.status === 204 ? null : await response.json();
}
function stageInfo(row: any) {
  const p = row?.progress && typeof row.progress === "object" ? row.progress : {};
  const outline = p.outline || {};
  const chapters = Array.isArray(p.chapters) ? p.chapters : [];
  const totalChapters = Number(outline.chapter_count || 0);
  const words = chapters.reduce((n: number, c: any) => n + (String(c.content || "").trim().match(/\S+/g) || []).length, 0);
  const stageMap: Record<string,string> = {
    awaiting_free_provider: "Ожидает доступной бесплатной квоты",
    generating: "Создаёт текст книги",
    editing: "Черновик собран — нужна редакторская проверка",
    preflight_blocked: "Остановлено: бесплатный провайдер недоступен",
    failed: "Остановлено с ошибкой",
    published: "Опубликовано",
  };
  let stage = stageMap[row?.status] || String(row?.status || "Нет данных");
  if (row?.status === "generating") {
    if (!outline.title) stage = "Подготовка плана и структуры";
    else if (chapters.length < totalChapters) stage = "Пишет главу " + Math.min(chapters.length + 1, totalChapters) + " из " + totalChapters;
    else stage = "Собирает и проверяет книгу";
  }
  const report = row?.postflight_report || {};
  return {
    id: row?.id, topic: row?.topic, status: row?.status, stage,
    title: outline.title || report.title || "",
    completed_chapters: chapters.length, total_chapters: totalChapters,
    words, worker_step: Number(p.worker_step_count || 0),
    updated_at: row?.updated_at || p.worker_updated_at || row?.created_at,
    last_error: String(p.worker_error || "").slice(0, 250),
    assets: Array.isArray(p.bookcheef_assets) ? p.bookcheef_assets.length : Number(report.asset_count || 0),
    validation: report.verdict || "",
    warnings: Array.isArray(report.warnings) ? report.warnings.length : 0,
  };
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "POST required" }, 405);
  try {
    const body = await req.json();
    const user = await verifyInitData(String(body.initData || ""), env("TELEGRAM_BOT_TOKEN"));
    if (!user) return reply({ error: "Telegram session is invalid or expired. Reopen the app from Telegram." }, 401);
    const userId = String(user.id);
    const admins = adminIds();
    const isAdmin = admins.has(userId);
    const allowedRows = await rest("telegram_bot_allowed_users?select=telegram_user_id");
    const allowed = isAdmin || (Array.isArray(allowedRows) && allowedRows.some((x: any) => String(x.telegram_user_id) === userId));
    if (!allowed) return reply({ error: "Нет доступа к BookCheef App." }, 403);

    const action = String(body.action || "dashboard");
    if (action === "start" || action === "stop") {
      if (!isAdmin) return reply({ error: "Управление генератором доступно только администратору." }, 403);
      const current = await rest("bookcheef_generation_control?id=eq.true&select=clear_requested");
      if (!Array.isArray(current) || !current.length) return reply({ error: "Не найдена запись управления генератором." }, 500);
      if (action === "start" && current[0].clear_requested) return reply({ error: "Сначала дождитесь завершения очистки очереди." }, 409);
      const rows = await rest("bookcheef_generation_control?id=eq.true", {
        method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ enabled: action === "start", updated_at: new Date().toISOString(), updated_by: userId }),
      });
      if (!Array.isArray(rows) || rows[0]?.enabled !== (action === "start")) return reply({ error: "Не удалось подтвердить изменение состояния." }, 502);
    } else if (action === "create") {
      if (!isAdmin) return reply({ error: "Создавать книги может только администратор." }, 403);
      const topic = String(body.topic || "").trim();
      if (topic.length < 3 || topic.length > 2000) return reply({ error: "Тема должна содержать от 3 до 2000 символов." }, 400);
      const internalSecret = env("TELEGRAM_INTERNAL_SECRET");
      if (!internalSecret) return reply({ error: "Внутренний ключ бота не настроен." }, 503);
      const base = env("SUPABASE_URL").replace(/\/$/, "");
      const response = await fetch(base + "/functions/v1/telegram-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-internal-secret": internalSecret },
        body: JSON.stringify({ action: "create_book_request", topic, user_id: userId, chat_id: userId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) return reply({ error: result.error || "Не удалось создать запрос." }, response.status || 502);
    } else if (action !== "dashboard") return reply({ error: "Unknown action" }, 400);

    const controlRows = await rest("bookcheef_generation_control?id=eq.true&select=enabled,updated_at,clear_requested");
    const control = Array.isArray(controlRows) ? controlRows[0] : null;
    const filter = isAdmin ? "" : "&telegram_user_id=eq." + encodeURIComponent(userId);
    const requests = await rest("bookcheef_one_shot_requests?select=id,topic,status,progress,created_at,updated_at,postflight_report,preflight_report" + filter + "&order=updated_at.desc&limit=8");
    const list = Array.isArray(requests) ? requests.map(stageInfo) : [];
    const active = list.find((x: any) => ["awaiting_free_provider","generating"].includes(x.status)) || null;
    const preflight = Array.isArray(requests) && requests.length ? requests[0].preflight_report : null;
    const providers = Array.isArray(preflight?.providers) ? preflight.providers.map((p: any) => ({
      name: p.provider, status: p.status, note: p.note,
      quota: typeof p.quota === "object" && p.quota ? p.quota : null,
      free_verified: p.free_tier_verified === true,
    })) : [];
    return reply({
      ok: true,
      user: { id: userId, name: String(user.first_name || "") + (user.last_name ? " " + user.last_name : ""), is_admin: isAdmin },
      generator: { enabled: control?.enabled === true, clear_requested: control?.clear_requested === true, updated_at: control?.updated_at || null },
      active, requests: list, providers,
      actions: { can_create: isAdmin, can_control: isAdmin },
      refreshed_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("tg app api error", String(error));
    return reply({ error: "Ошибка панели. Попробуйте обновить данные." }, 500);
  }
});
