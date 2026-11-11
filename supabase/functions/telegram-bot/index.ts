import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TELEGRAM_API = "https://api.telegram.org";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function safeEqual(a: string, b: string) {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

async function telegram(method: string, token: string, payload: Record<string, unknown> = {}) {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description ?? response.status}`);
  }
  return result.result;
}

function parseIds(value: string) {
  return new Set(value.split(",").map((x) => x.trim()).filter(Boolean));
}

function isObviousSpam(text: string) {
  const value = text.toLowerCase();
  const shortener = /https?:\/\/(bit\.ly|tinyurl\.com|t\.me\/\+|cutt\.ly|rb\.gy)\//i.test(value);
  const scam = /(удвоим ваш доход|гарантированн(ый|о) доход|заработ(ай|ок) без вложений|крипто.?сигнал|инвестиции без риска|casino|казино|ставки на спорт|18\+ контент)/i.test(value);
  const repeatedPromo = /(подпишись на мой канал|взаимная подписка|накрутка подписчиков|купить подписчиков)/i.test(value);
  return shortener || scam || repeatedPromo;
}

async function sendText(token: string, chatId: number | string, text: string) {
  return await telegram("sendMessage", token, {
    chat_id: chatId,
    text,
    disable_web_page_preview: false,
  });
}

async function getAllowedUserIds(adminIds: Set<string>) {
  const ids = new Set(adminIds);
  const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!base || !key) throw new Error("Supabase service credentials are unavailable");
  const response = await fetch(base + "/rest/v1/telegram_bot_allowed_users?select=telegram_user_id", {
    headers: { apikey: key, Authorization: "Bearer " + key },
  });
  if (!response.ok) throw new Error("Could not load bot access list: " + response.status);
  const rows = await response.json();
  for (const row of rows) ids.add(String(row.telegram_user_id));
  return ids;
}

async function changeAllowedUser(id: string, allow: boolean) {
  const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!base || !key) throw new Error("Supabase service credentials are unavailable");
  const url = base + "/rest/v1/telegram_bot_allowed_users";
  const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=minimal" };
  const response = allow
    ? await fetch(url, { method: "POST", headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ telegram_user_id: id }) })
    : await fetch(url + "?telegram_user_id=eq." + encodeURIComponent(id), { method: "DELETE", headers });
  if (!response.ok) throw new Error("Could not update bot access list: " + response.status + " " + (await response.text()).slice(0, 250));
}


async function getGenerationControl() {
  const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!base || !key) throw new Error("Supabase service credentials are unavailable");
  const response = await fetch(base + "/rest/v1/bookcheef_generation_control?id=eq.true&select=enabled,updated_at,updated_by,clear_requested,clear_requested_at", { headers: { apikey: key, Authorization: "Bearer " + key } });
  if (!response.ok) throw new Error("Could not read generation state: HTTP " + response.status);
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows.length || typeof rows[0].enabled !== "boolean") throw new Error("Generation control record is missing or invalid");
  return rows[0];
}
async function setGenerationControl(enabled: boolean, adminId: string) {
  const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!base || !key) throw new Error("Supabase service credentials are unavailable");
  const response = await fetch(base + "/rest/v1/bookcheef_generation_control?id=eq.true", {
    method: "PATCH",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ enabled, updated_at: new Date().toISOString(), updated_by: adminId }),
  });
  if (!response.ok) throw new Error("Could not update generation state: HTTP " + response.status + " " + (await response.text()).slice(0, 200));
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows.length || rows[0].enabled !== enabled) throw new Error("Generation state update was not confirmed");
  return rows[0];
}

async function requestGenerationQueueClear(adminId: string) {
  const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!base || !key) throw new Error("Supabase service credentials are unavailable");
  const response = await fetch(base + "/rest/v1/bookcheef_generation_control?id=eq.true", {
    method: "PATCH",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ enabled: false, clear_requested: true, clear_requested_at: new Date().toISOString(), clear_requested_by: adminId, updated_at: new Date().toISOString(), updated_by: adminId }),
  });
  if (!response.ok) throw new Error("Could not schedule queue cleanup: HTTP " + response.status + " " + (await response.text()).slice(0, 200));
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].enabled !== false || rows[0].clear_requested !== true) throw new Error("Queue cleanup request was not confirmed");
  return rows[0];
}

function decodeNewsXml(value = "") {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<(?:br\b|\/(?:p|div|li)\b)[^>]*>/gi, "\n\n")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t]+/g, " ").trim();
}

function newsXmlTag(block: string, name: string) {
  const re = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i");
  return decodeNewsXml(block.match(re)?.[1] || "");
}

async function sendTestNews(token: string, channelId: string) {
  const response = await fetch("https://readrate.com/rus/rss/news", { headers: { "user-agent": "BookCheefNewsBot/1.0" } });
  if (!response.ok) throw new Error("RSS недоступен: HTTP " + response.status);
  const xml = await response.text();
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(m => m[0]);
  const cutoff = Date.now() - 5 * 24 * 60 * 60 * 1000;
  const items = blocks.map(block => {
    const title = newsXmlTag(block, "title");
    const description = newsXmlTag(block, "description") || newsXmlTag(block, "summary") || newsXmlTag(block, "content");
    const dateText = newsXmlTag(block, "pubDate") || newsXmlTag(block, "published") || newsXmlTag(block, "updated");
    const link = newsXmlTag(block, "link") || block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] || "";
    return { title, description, link, date: Date.parse(dateText) };
  }).filter(x => x.title && /^https?:\/\//i.test(x.link) && Number.isFinite(x.date) && x.date >= cutoff)
    .sort((a, b) => b.date - a.date);
  if (!items.length) throw new Error("В RSS нет подходящих новостей за последние 5 дней.");
  const item = items[0];
  const escape = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const excerpt = item.description.length > 700 ? item.description.slice(0, 699).trimEnd() + "…" : item.description;
  const post = [
    "📰 <b>КНИЖНЫЕ НОВОСТИ — ТЕСТОВАЯ ОТПРАВКА</b>",
    "📖 <b>" + escape(item.title) + "</b>",
    excerpt ? escape(excerpt) : "",
    "🔗 <a href=\"" + item.link + "\">Читать источник</a>",
    "📚 BookCheef — https://kdnmgames.github.io/BookCheef/",
  ].filter(Boolean).join("\n\n").slice(0, 3900);
  const result = await telegram("sendMessage", token, { chat_id: channelId, text: post, parse_mode: "HTML", disable_web_page_preview: false }) as any;
  return { message_id: result.message_id, title: item.title };
}


async function createOneShotBookRequest(topic: string, userId: string, chatId: string, report: Record<string, unknown>) {
  const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!base || !key) throw new Error("Supabase service credentials are unavailable");
  const response = await fetch(base + "/rest/v1/bookcheef_one_shot_requests", {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ telegram_user_id: userId, telegram_chat_id: chatId, topic, status: report.providers.some((p: any) => p.provider === "OpenRouter" && p.preflight_ready && p.adapter_ready) ? "awaiting_free_provider" : "preflight_blocked", preflight_report: report })
  });
  if (!response.ok) throw new Error("Could not save book request: HTTP " + response.status + " " + (await response.text()).slice(0, 250));
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Book request was not confirmed");
  return rows[0];
}
async function getLatestOneShotBookRequest(userId: string) {
  const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!base || !key) throw new Error("Supabase service credentials are unavailable");
  const url = base + "/rest/v1/bookcheef_one_shot_requests?telegram_user_id=eq." + encodeURIComponent(userId) + "&select=id,topic,status,created_at,updated_at,preflight_report,postflight_report&order=created_at.desc&limit=1";
  const response = await fetch(url, { headers: { apikey: key, Authorization: "Bearer " + key } });
  if (!response.ok) throw new Error("Could not load book request: HTTP " + response.status);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] ?? null : null;
}
async function checkOpenRouterFreeAccess() {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY") || "";
  if (!apiKey) return {
    provider: "OpenRouter", credential_configured: false, quota: "unknown",
    free_tier_verified: false, preflight_ready: false, adapter_ready: false,
    status: "key_not_configured", note: "API-ключ не настроен."
  };
  try {
    // Read-only account metadata request: does not invoke a model or consume inference quota.
    const keyResponse = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" }
    });
    if (!keyResponse.ok) {
      return { provider: "OpenRouter", credential_configured: true, quota: "unknown",
        free_tier_verified: false, preflight_ready: false, adapter_ready: false,
        status: keyResponse.status === 401 ? "invalid_key" : "account_check_failed",
        note: "Проверка ключа завершилась HTTP " + keyResponse.status + "." };
    }
    const keyPayload = await keyResponse.json();
    const data = keyPayload?.data ?? keyPayload;
    const daily = data?.free_model_daily_requests;
    const isFreeTier = data?.is_free_tier === true;
    const remaining = Number(daily?.remaining);
    const limit = Number(daily?.limit);
    const usage = Number(daily?.used);
    // Only allow the no-purchase free tier. If tier is not explicitly confirmed,
    // the provider remains blocked to avoid accidentally using a paid account.
    const freeTierVerified = isFreeTier && Number.isFinite(remaining) && Number.isFinite(limit);
    let freeModelCount = 0;
    if (freeTierVerified && remaining > 0) {
      const modelsResponse = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: "Bearer " + apiKey }
      });
      if (modelsResponse.ok) {
        const modelPayload = await modelsResponse.json();
        freeModelCount = Array.isArray(modelPayload?.data)
          ? modelPayload.data.filter((m: any) => typeof m.id === "string" && m.id.endsWith(":free")).length
          : 0;
      }
    }
    const ready = freeTierVerified && remaining > 0 && freeModelCount > 0;
    return {
      provider: "OpenRouter", credential_configured: true,
      quota: freeTierVerified ? { used, limit, remaining } : "unknown",
      free_tier_verified: freeTierVerified, preflight_ready: ready, adapter_ready: true,
      status: ready ? "free_quota_available" : (freeTierVerified && remaining <= 0 ? "free_daily_quota_exhausted" : "free_tier_not_verified"),
      free_model_count: freeModelCount,
      note: ready
        ? "Бесплатный тариф подтверждён; генераторный адаптер Free Router готов к пошаговой работе."
        : "Бесплатный тариф не подтверждён или дневной лимит исчерпан. Генерация заблокирована."
    };
  } catch (_error) {
    return { provider: "OpenRouter", credential_configured: true, quota: "unknown",
      free_tier_verified: false, preflight_ready: false, adapter_ready: false,
      status: "account_check_failed", note: "Не удалось проверить аккаунт; провайдер заблокирован." };
  }
}

async function buildBookPreflightReport() {
  const candidates = [
    { name: "Google Gemini", env: "GEMINI_API_KEY" },
    { name: "Google AI Studio", env: "GOOGLE_API_KEY" },
    { name: "Groq", env: "GROQ_API_KEY" },
    { name: "DeepSeek", env: "DEEPSEEK_API_KEY" },
    { name: "Mistral", env: "MISTRAL_API_KEY" },
    { name: "Cerebras", env: "CEREBRAS_API_KEY" },
    { name: "Together AI", env: "TOGETHER_API_KEY" },
    { name: "Cursor", env: "CURSOR_API_KEY" },
  ];
  const providers = candidates.map((p) => ({
    provider: p.name,
    credential_configured: Boolean(Deno.env.get(p.env)),
    quota: "unknown",
    free_tier_verified: false,
    preflight_ready: false,
    adapter_ready: false,
    status: Deno.env.get(p.env) ? "key_present_quota_not_verified" : "key_not_configured",
    note: "Проверка квоты и подтверждение бесплатного тарифа ещё не реализованы."
  }));
  providers.push(await checkOpenRouterFreeAccess());
  const safeReady = providers.some((p: any) => p.preflight_ready === true);
  return {
    checked_at: new Date().toISOString(),
    policy: "free_only_no_billing_no_paid_fallback",
    providers,
    generation_started: false,
    blocking_reason: safeReady
      ? "Бесплатная квота обнаружена, но генераторный адаптер ещё не подключён. Запрос не запускается."
      : "Нет провайдеров с подтверждённой доступной бесплатной квотой. Запрос сохранён; платные маршруты не запускались."
  };
}
async function getOneShotRequestById(id: string, userId: string) {
  const baseValue = Deno.env.get("SUPABASE_URL") || "";
  const base = baseValue.endsWith("/") ? baseValue.slice(0, -1) : baseValue;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!base || !key) throw new Error("Supabase service credentials are unavailable");
  const url = base + "/rest/v1/bookcheef_one_shot_requests?id=eq." + encodeURIComponent(id) +
    "&telegram_user_id=eq." + encodeURIComponent(userId) + "&select=id,topic,status,progress,telegram_chat_id,postflight_report";
  const response = await fetch(url, { headers: { apikey: key, Authorization: "Bearer " + key } });
  if (!response.ok) throw new Error("Could not load request: HTTP " + response.status);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function saveOneShotProgress(id: string, status: string, progress: Record<string, unknown>) {
  const baseValue = Deno.env.get("SUPABASE_URL") || "";
  const base = baseValue.endsWith("/") ? baseValue.slice(0, -1) : baseValue;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!base || !key) throw new Error("Supabase service credentials are unavailable");
  const response = await fetch(base + "/rest/v1/bookcheef_one_shot_requests?id=eq." + encodeURIComponent(id), {
    method: "PATCH",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ status: status, progress: progress, updated_at: new Date().toISOString() })
  });
  if (!response.ok) throw new Error("Could not save checkpoint: HTTP " + response.status);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Checkpoint save was not confirmed");
  return rows[0];
}

async function generateOneFreeBookStep(topic: string, progress: Record<string, any>) {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY") || "";
  if (!apiKey) throw new Error("FREE_QUOTA_BLOCKED: API key missing");
  const keyResponse = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: "Bearer " + apiKey }
  });
  if (!keyResponse.ok) throw new Error("FREE_QUOTA_BLOCKED: account check failed");
  const keyPayload = await keyResponse.json();
  const account = keyPayload.data || keyPayload;
  const daily = account.free_model_daily_requests || {};
  const remaining = Number(daily.remaining);
  if (account.is_free_tier !== true || !Number.isFinite(remaining) || remaining < 1) {
    throw new Error("FREE_QUOTA_BLOCKED: free tier or remaining quota not confirmed");
  }

  const outlineMode = !progress.outline;
  const chapters = Array.isArray(progress.chapters) ? progress.chapters : [];
  const chapterNumber = chapters.length + 1;
  const chapterCount = Number(progress.outline && progress.outline.chapter_count || 10);
  if (!outlineMode && chapterNumber > chapterCount) {
    return { complete: true, progress: progress };
  }
  const systemPrompt = "Ты профессиональный автор BookCheef. Пиши оригинальный полноценный литературный текст на русском языке. Не используй заглушки, пересказы вместо прозы и комментарии о процессе. Возвращай только JSON без Markdown.";
  let userPrompt = "";
  if (outlineMode) {
    userPrompt = "Создай подробный план книги по теме: " + topic +
      ". Целевая длительность чтения около 2 часов. Определи аудиторию, жанр, аннотацию, героев и структуру из 8–12 глав. Верни JSON: audience, genre, synopsis, characters (массив), chapter_count (число 8–12), chapters (массив объектов number/title/summary), cover_prompt, illustration_prompts (3–6 описаний).";
  } else {
    userPrompt = "Напиши главу " + chapterNumber + " из " + chapterCount + " книги на тему: " + topic +
      ". План: " + JSON.stringify(progress.outline) +
      ". Цель 1600–2200 слов, полноценная художественная проза, не пересказ. Верни JSON с полями chapter_number, title, content, word_count.";
  }
  const completionResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://kdnmgames.github.io/BookCheef/",
      "X-OpenRouter-Title": "BookCheef Free Book Generator"
    },
    body: JSON.stringify({
      model: "openrouter/free",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      max_tokens: 7000,
      temperature: 0.75,
      stream: false
    })
  });
  if (!completionResponse.ok) {
    if (completionResponse.status === 402 || completionResponse.status === 429) {
      throw new Error("FREE_QUOTA_BLOCKED: HTTP " + completionResponse.status);
    }
    throw new Error("OpenRouter error: HTTP " + completionResponse.status);
  }
  const completion = await completionResponse.json();
  const content = completion.choices && completion.choices[0] && completion.choices[0].message
    ? completion.choices[0].message.content : "";
  if (typeof content !== "string" || !content.trim()) throw new Error("MODEL_OUTPUT_EMPTY");
  const cleaned = content.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
  let parsed: any;
  try { parsed = JSON.parse(cleaned); } catch { throw new Error("MODEL_OUTPUT_INVALID_JSON"); }

  if (outlineMode) {
    if (!Array.isArray(parsed.chapters) || parsed.chapters.length < 8 || !parsed.synopsis || !parsed.cover_prompt) {
      throw new Error("MODEL_OUTPUT_INVALID_OUTLINE");
    }
    return {
      complete: false,
      generated: "outline",
      progress: { outline: parsed, chapters: [], step: "chapter", updated_at: new Date().toISOString() }
    };
  }
  if (Number(parsed.chapter_number) !== chapterNumber || !parsed.title ||
      typeof parsed.content !== "string" || parsed.content.trim().length < 6500) {
    throw new Error("MODEL_OUTPUT_INVALID_CHAPTER");
  }
  const updatedChapters = chapters.concat([parsed]);
  return {
    complete: false,
    generated: "chapter",
    chapter_number: chapterNumber,
    progress: {
      outline: progress.outline,
      chapters: updatedChapters,
      step: updatedChapters.length >= chapterCount ? "editorial_review" : "chapter",
      updated_at: new Date().toISOString()
    }
  };
}

async function saveOneShotPostflight(id: string, status: string, progress: Record<string, unknown>, report: Record<string, unknown>) {
  const rawBase = Deno.env.get("SUPABASE_URL") || "";
  const base = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!base || !key) throw new Error("Supabase service credentials are unavailable");
  const response = await fetch(base + "/rest/v1/bookcheef_one_shot_requests?id=eq." + encodeURIComponent(id), {
    method: "PATCH",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ status, progress, postflight_report: report, updated_at: new Date().toISOString() })
  });
  if (!response.ok) throw new Error("Could not save postflight report: HTTP " + response.status);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Postflight save was not confirmed");
  return rows[0];
}

async function scheduleOneShotBookWorker(requestId: string, userId: string) {
  const rawBase = Deno.env.get("SUPABASE_URL") || "";
  const base = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase;
  const secret = Deno.env.get("TELEGRAM_INTERNAL_SECRET") || "";
  if (!base || !secret) throw new Error("Worker internal credentials are unavailable");
  const response = await fetch(base + "/functions/v1/telegram-bot", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-telegram-internal-secret": secret },
    body: JSON.stringify({ action: "book_worker", request_id: requestId, user_id: userId })
  });
  if (!response.ok) throw new Error("Could not schedule next book worker: HTTP " + response.status);
}

async function runOneShotBookWorker(requestId: string, userId: string) {
  const request = await getOneShotRequestById(requestId, userId);
  if (!request || !["awaiting_free_provider", "generating"].includes(request.status)) return;
  const progress = request.progress && typeof request.progress === "object" ? request.progress : {};
  const steps = Number(progress.worker_step_count || 0);
  if (steps >= 20) {
    await saveOneShotProgress(request.id, "failed", { ...progress, worker_error: "MAX_WORKER_STEPS_REACHED" });
    await sendText(Deno.env.get("TELEGRAM_BOT_TOKEN") || "", request.telegram_chat_id, "⚠️ Достигнут предел автоматических шагов. Прогресс сохранён.");
    return;
  }
  try {
    const result = await generateOneFreeBookStep(request.topic, progress);
    const nextProgress = { ...result.progress, worker_step_count: steps + 1, worker_updated_at: new Date().toISOString() };
    if (result.complete) {
      const chapters = Array.isArray(nextProgress.chapters) ? nextProgress.chapters : [];
      const fullText = chapters.map((c: any) => String(c.content || "")).join("\n\n");
      const words = fullText.trim() ? fullText.trim().split(/\s+/).length : 0;
      const expected = Number(nextProgress.outline?.chapter_count || 0);
      const report = {
        completed_at: new Date().toISOString(),
        expected_chapters: expected,
        actual_chapters: chapters.length,
        total_words: words,
        total_characters: fullText.length,
        chapters: chapters.map((c: any) => ({
          number: c.chapter_number, title: String(c.title || "").slice(0, 180),
          words: String(c.content || "").trim().split(/\s+/).filter(Boolean).length,
          characters: String(c.content || "").length
        })),
        publication: "not_published",
        illustrations: "not_generated",
        verdict: chapters.length === expected && words >= 9000
          ? "draft_complete_requires_editorial_review"
          : "draft_complete_but_below_target_requires_expansion"
      };
      await saveOneShotPostflight(request.id, "editing", nextProgress, report);
      await sendText(Deno.env.get("TELEGRAM_BOT_TOKEN") || "", request.telegram_chat_id,
        "📘 Черновик книги завершён.\nГлав: " + chapters.length + "/" + expected +
        "\nСлов: " + words + "\nПроверка: " + report.verdict +
        "\nИллюстрации ещё не созданы. Автопубликации не было. Отчёт сохранён.");
      return;
    }
    const saved = await saveOneShotProgress(request.id, "generating", nextProgress);
    const message = result.generated === "outline"
      ? "📑 План готов: " + result.progress.outline.chapter_count + " глав. Генерация продолжится автоматически."
      : "✍️ Создана глава " + result.chapter_number + "/" + result.progress.outline.chapter_count + ". Контрольная точка сохранена.";
    await sendText(Deno.env.get("TELEGRAM_BOT_TOKEN") || "", request.telegram_chat_id, message);
    EdgeRuntime.waitUntil((async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await scheduleOneShotBookWorker(saved.id, userId);
    })());
  } catch (error) {
    const message = String(error);
    if (message.includes("FREE_QUOTA_BLOCKED")) {
      const latest = await getOneShotRequestById(requestId, userId);
      if (latest) await saveOneShotProgress(latest.id, "awaiting_free_provider", latest.progress || {});
      await sendText(Deno.env.get("TELEGRAM_BOT_TOKEN") || "", request.telegram_chat_id,
        "⏸ Бесплатная квота закончилась. Автогенерация приостановлена, прогресс сохранён. Платные API не использовались. После обновления квоты: /bookresume " + requestId);
      return;
    }
    await saveOneShotProgress(request.id, "failed", { ...progress, worker_error: message.slice(0, 500) });
    await sendText(Deno.env.get("TELEGRAM_BOT_TOKEN") || "", request.telegram_chat_id,
      "❌ Генерация остановлена: " + message.slice(0, 250) + ". Контрольная точка сохранена.");
  }
}


Deno.serve(async (req: Request) => {
  if (req.method === "GET") return json({ ok: true, service: "BookCheef Telegram bot" });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  const webhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
  const internalSecret = Deno.env.get("TELEGRAM_INTERNAL_SECRET") ?? "";
  const channelId = Deno.env.get("TELEGRAM_CHANNEL_ID") ?? "@BookCheef";
  const adminIds = parseIds(Deno.env.get("TELEGRAM_ADMIN_IDS") ?? "");

  if (!token || !webhookSecret || !internalSecret) {
    return json({ error: "Telegram bot secrets are not configured" }, 503);
  }

  const suppliedWebhookSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  const suppliedInternalSecret = req.headers.get("x-telegram-internal-secret") ?? "";
  const suppliedReportToken = req.headers.get("x-bookcheef-report-token") ?? "";
  const internalCall = safeEqual(suppliedInternalSecret, internalSecret)
    || safeEqual(suppliedReportToken, token);

  if (!internalCall && !safeEqual(suppliedWebhookSecret, webhookSecret)) {
    return json({ error: "Unauthorized" }, 401);
  }

  let update: any;
  try { update = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  if (internalCall) {
    if (update.action === "admin_notification") {
      const notificationText = String(update.text ?? "").trim();
      if (!notificationText) return json({ error: "text is required" }, 400);
      if (!adminIds.size) return json({ error: "TELEGRAM_ADMIN_IDS is empty; cannot route notification" }, 503);
      const results = [];
      for (const adminId of adminIds) {
        try {
          const sent = await sendText(token, adminId, notificationText.slice(0, 3900)) as any;
          results.push({ chat_id: adminId, message_id: sent.message_id, ok: true });
        } catch (error) {
          console.error("Could not deliver admin notification", adminId, String(error));
          results.push({ chat_id: adminId, ok: false });
        }
      }
      const delivered = results.filter((x) => x.ok).length;
      return json({ ok: delivered > 0, delivered, total: results.length, results }, delivered > 0 ? 200 : 502);
    }
    if (update.action === "marketing_report") {
      const report = update.report ?? {};
      const required = ["platform", "community_name", "community_url", "post_url", "published_at", "post_text"];
      const missing = required.filter((key) => !String(report[key] ?? "").trim());
      if (missing.length) return json({ error: "Missing report fields", missing }, 400);
      if (!adminIds.size) return json({ error: "TELEGRAM_ADMIN_IDS is empty; cannot route report" }, 503);
      const safeUrl = (value: unknown) => {
        const s = String(value ?? "").trim();
        try {
          const u = new URL(s);
          return u.protocol === "https:" || u.protocol === "http:" ? s : "";
        } catch {
          return "";
        }
      };
      const lines = [
        report.status === "test" ? "🧪 ТЕСТ СВЯЗИ ОТЧЁТОВ BOOKCHEEF" : "📣 ОПУБЛИКОВАНА РЕКЛАМА BOOKCHEEF",
        "",
        "Площадка: " + String(report.platform).slice(0, 120),
        "Сообщество: " + String(report.community_name).slice(0, 180),
        "Ссылка на сообщество: " + safeUrl(report.community_url),
        "Пост: " + safeUrl(report.post_url),
        "Дата: " + String(report.published_at).slice(0, 80),
        "Куда ведёт реклама: " + String(report.destination ?? "BookCheef").slice(0, 100),
        "",
        "Текст публикации:",
        String(report.post_text).slice(0, 2200),
        "",
        "ID отчёта: " + String(report.report_id ?? "не указан").slice(0, 100)
      ];
      const messageText = lines.join("\n").slice(0, 3900);
      const results = [];
      for (const adminId of adminIds) {
        try {
          const sent = await sendText(token, adminId, messageText) as any;
          results.push({ chat_id: adminId, message_id: sent.message_id, ok: true });
        } catch (error) {
          console.error("Could not deliver marketing report to admin", adminId, String(error));
          results.push({ chat_id: adminId, ok: false });
        }
      }
      const delivered = results.filter((x) => x.ok).length;
      return json({ ok: delivered > 0, delivered, total: results.length, results }, delivered > 0 ? 200 : 502);
    }

    if (update.action === "book_worker") {
      const requestId = String(update.request_id || "");
      const userId = String(update.user_id || "");
      if (!/^[0-9a-f-]{36}$/i.test(requestId) || !/^\d{5,20}$/.test(userId)) return json({ error: "Invalid worker payload" }, 400);
      EdgeRuntime.waitUntil(runOneShotBookWorker(requestId, userId));
      return json({ ok: true, action: "book_worker_accepted" }, 202);
    }
    const text = String(update.text ?? "").trim();
    const photo = String(update.photo_url ?? "").trim();
    if (!text && !photo) return json({ error: "text or photo_url is required" }, 400);
    const chatId = String(update.chat_id ?? channelId);
    const result = photo
      ? await telegram("sendPhoto", token, {
          chat_id: chatId,
          photo,
          caption: text.slice(0, 1024),
          parse_mode: "HTML",
        })
      : await telegram("sendMessage", token, {
          chat_id: chatId,
          text: text.slice(0, 4096),
          disable_web_page_preview: false,
        });
    return json({ ok: true, message_id: result.message_id, chat_id: result.chat.id });
  }

  const message = update.message ?? update.edited_message;
  if (!message) return json({ ok: true, ignored: true });

  const chat = message.chat ?? {};
  const from = message.from ?? {};
  const senderId = String(from.id ?? "");
  const isAdmin = adminIds.has(senderId) || from.is_bot === true;
  const text = String(message.text ?? message.caption ?? "");
  const isGroup = chat.type === "group" || chat.type === "supergroup";

  let allowedUserIds = new Set(adminIds);
  if (chat.type === "private" && from.is_bot !== true) {
    try {
      allowedUserIds = await getAllowedUserIds(adminIds);
    } catch (error) {
      console.error("Could not load private bot access list:", String(error));
      if (!adminIds.has(senderId)) {
        await sendText(token, chat.id, "Временно не удалось проверить доступ. Попробуй позже.");
        return json({ ok: true, access: "check_failed" });
      }
    }
    if (!allowedUserIds.has(senderId)) {
      await sendText(token, chat.id, "🔒 BookCheef_bot закрыт. Доступ предоставляется владельцем бота.");
      return json({ ok: true, access: "denied" });
    }
  }

  if (isGroup && !isAdmin && isObviousSpam(text)) {
    try {
      await telegram("deleteMessage", token, {
        chat_id: chat.id,
        message_id: message.message_id,
      });
      return json({ ok: true, moderated: "deleted_spam" });
    } catch (error) {
      console.error("Could not delete spam message:", String(error));
      return json({ ok: true, moderated: "delete_failed" });
    }
  }

  if (chat.type === "private" && text.startsWith("/")) {
    const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

    if (command === "/book") {
      if (!adminIds.has(senderId)) {
        await sendText(token, chat.id, "Создавать книги может только администратор BookCheef.");
        return json({ ok: true, command: "book_denied" });
      }
      const topic = text.replace(/^\/book(?:@\w+)?\s*/i, "").trim();
      if (topic.length < 3) {
        await sendText(token, chat.id, "Укажи тему или ТЗ книги.\nФормат: /book <тема и пожелания>\n\nЦель — около 2 часов чтения, с обложкой и иллюстрациями.");
        return json({ ok: true, command: "book_usage" });
      }
      if (topic.length > 2000) {
        await sendText(token, chat.id, "ТЗ слишком длинное (максимум 2000 символов).");
        return json({ ok: true, command: "book_too_long" });
      }
      try {
        const report = await buildBookPreflightReport();
        const saved = await createOneShotBookRequest(topic, senderId, String(chat.id), report);
        const lines = report.providers.map((p: any) => {
          const mark = p.credential_configured ? "🔑" : "—";
          const quota = typeof p.quota === "object" && p.quota
            ? String(p.quota.remaining) + "/" + String(p.quota.limit) + " запросов сегодня"
            : "неизвестна";
          return mark + " " + p.provider + ": " + p.status + "; квота: " + quota;
        });
        await sendText(token, chat.id,
          "📊 ПРЕДВАРИТЕЛЬНЫЙ ОТЧЁТ BOOKCHEEF\n\n" +
          lines.join("\n") +
          "\n\n🛡 Режим: только бесплатные тарифы; платные запросы запрещены." +
          (saved.status === "awaiting_free_provider" ? "\n✅ OpenRouter Free Router прошёл проверку. Автоматическая генерация запущена. ID: " + saved.id : "\n⏸ Генерация заблокирована: бесплатная квота не подтверждена.") +
          "\n\nЗапрос сохранён: " + saved.id +
          "\nТема: " + topic.slice(0, 500) +
          "\nСтатус: " + saved.status
        );
        if (saved.status === "awaiting_free_provider") EdgeRuntime.waitUntil(scheduleOneShotBookWorker(saved.id, senderId));
        return json({ ok: true, command: "book", request_id: saved.id, status: saved.status, generation_started: saved.status === "awaiting_free_provider" });
      } catch (error) {
        await sendText(token, chat.id, "❌ Не удалось сохранить запрос книги: " + String(error).slice(0, 350));
        return json({ ok: false, command: "book", error: String(error).slice(0, 350) }, 502);
      }
    }


    if (command === "/bookresume") {
      if (!adminIds.has(senderId)) { await sendText(token, chat.id, "Продолжать книги может только администратор."); return json({ ok: true }); }
      const requestId = text.split(/\s+/)[1] || "";
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) { await sendText(token, chat.id, "Формат: /bookresume UUID"); return json({ ok: true }); }
      try {
        const request = await getOneShotRequestById(requestId, senderId);
        if (!request || request.status !== "awaiting_free_provider") { await sendText(token, chat.id, "Запрос не ожидает восстановления квоты."); return json({ ok: true }); }
        const report = await buildBookPreflightReport();
        const provider = report.providers.find((p: any) => p.provider === "OpenRouter");
        if (!provider || provider.preflight_ready !== true || provider.adapter_ready !== true) {
          await sendText(token, chat.id, "⏸ Бесплатная квота пока не подтверждена. Прогресс сохранён."); return json({ ok: true });
        }
        await saveOneShotProgress(request.id, "generating", request.progress || {});
        EdgeRuntime.waitUntil(scheduleOneShotBookWorker(request.id, senderId));
        await sendText(token, chat.id, "▶️ Продолжаю книгу с сохранённой контрольной точки.");
        return json({ ok: true, command: "bookresume_started" });
      } catch (error) {
        await sendText(token, chat.id, "Ошибка возобновления: " + String(error).slice(0, 250));
        return json({ ok: false }, 502);
      }
    }
    if (command === "/bookstep") {
      if (!adminIds.has(senderId)) {
        await sendText(token, chat.id, "Запуск шага книги доступен только администратору.");
        return json({ ok: true, command: "bookstep_denied" });
      }
      const requestId = text.split(/\s+/)[1] || "";
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
        await sendText(token, chat.id, "Формат: /bookstep UUID_ЗАПРОСА. Сначала создай запрос командой /book.");
        return json({ ok: true, command: "bookstep_usage" });
      }
      try {
        const request = await getOneShotRequestById(requestId, senderId);
        if (!request) {
          await sendText(token, chat.id, "Запрос не найден или принадлежит другому администратору.");
          return json({ ok: true, command: "bookstep_not_found" });
        }
        if (request.status !== "awaiting_free_provider" && request.status !== "generating") {
          await sendText(token, chat.id, "Запрос заблокирован. Статус: " + request.status + ". Повтори предварительную проверку позже.");
          return json({ ok: true, command: "bookstep_blocked" });
        }
        await sendText(token, chat.id, "⏳ Запускаю один шаг через OpenRouter Free Router. Будет использована только бесплатная модель; платные маршруты не включены.");
        const progress = request.progress && typeof request.progress === "object" ? request.progress : {};
        const result = await generateOneFreeBookStep(request.topic, progress);
        if (result.complete) {
          await saveOneShotProgress(request.id, "editing", result.progress);
          await sendText(token, chat.id, "📘 Главы книги подготовлены. Следующий этап — редактура и проверка. Публикации не было.");
          return json({ ok: true, command: "bookstep", complete: true });
        }
        const saved = await saveOneShotProgress(request.id, "generating", result.progress);
        const detail = result.generated === "outline"
          ? "План книги готов (" + result.progress.outline.chapter_count + " глав)."
          : "Сохранена глава " + result.chapter_number + " из " + result.progress.outline.chapter_count + ".";
        await sendText(token, chat.id, "✅ " + detail + "\\nКонтрольная точка сохранена. Следующий шаг: /bookstep " + saved.id);
        return json({ ok: true, command: "bookstep", generated: result.generated, status: saved.status });
      } catch (error) {
        const message = String(error);
        if (message.indexOf("FREE_QUOTA_BLOCKED") >= 0) {
          const latest = await getOneShotRequestById(requestId, senderId);
          if (latest) await saveOneShotProgress(latest.id, "awaiting_free_provider", latest.progress || {});
          await sendText(token, chat.id, "⏸ Бесплатная квота недоступна. Прогресс сохранён; платные API не запускались.");
          return json({ ok: true, command: "bookstep_quota_blocked" });
        }
        await sendText(token, chat.id, "❌ Шаг не завершён: " + message.slice(0, 300) + "\\nКонтрольная точка сохранена без изменений.");
        return json({ ok: false, command: "bookstep", error: message.slice(0, 300) }, 502);
      }
    }
    if (command === "/bookstatus") {
      if (!adminIds.has(senderId)) {
        await sendText(token, chat.id, "Статус создания книг доступен только администратору.");
        return json({ ok: true, command: "bookstatus_denied" });
      }
      try {
        const latest = await getLatestOneShotBookRequest(senderId);
        await sendText(token, chat.id, latest
          ? "📚 ПОСЛЕДНИЙ ЗАПРОС КНИГИ\\nID: " + latest.id + "\\nТема: " + latest.topic + "\\nСтатус: " + latest.status + "\\nСоздан: " + latest.created_at
          : "Пока нет запросов на создание книг.");
        return json({ ok: true, command: "bookstatus", found: Boolean(latest) });
      } catch (error) {
        await sendText(token, chat.id, "Не удалось получить статус: " + String(error).slice(0, 300));
        return json({ ok: false, command: "bookstatus" }, 502);
      }
    }

    if (command === "/allow" || command === "/deny") {
      if (!adminIds.has(senderId)) {
        await sendText(token, chat.id, "Управлять доступом может только главный администратор.");
        return json({ ok: true, command: command.slice(1) + "_denied" });
      }
      const targetId = text.split(/\s+/)[1] || "";
      if (!/^\d{5,15}$/.test(targetId)) {
        await sendText(token, chat.id, "Формат: " + command + " TELEGRAM_ID\nПример: " + command + " 123456789");
        return json({ ok: true, command: command.slice(1) + "_usage" });
      }
      if (command === "/deny" && adminIds.has(targetId)) {
        await sendText(token, chat.id, "Нельзя удалить главного администратора из списка доступа.");
        return json({ ok: true, command: "deny_protected_admin" });
      }
      try {
        await changeAllowedUser(targetId, command === "/allow");
        await sendText(token, chat.id, command === "/allow"
          ? "✅ Доступ к BookCheef_bot открыт для ID " + targetId
          : "🚫 Доступ к BookCheef_bot закрыт для ID " + targetId);
      } catch (error) {
        await sendText(token, chat.id, "Не удалось изменить доступ: " + String(error).slice(0, 350));
      }
      return json({ ok: true, command: command.slice(1) });
    }
    if (command === "/testnews") {
      if (!adminIds.has(senderId)) {
        await sendText(token, chat.id, "Тестовая отправка новостей доступна только главному администратору.");
        return json({ ok: true, command: "testnews_denied" });
      }
      try {
        const result = await sendTestNews(token, channelId);
        await sendText(token, chat.id, "✅ Тестовая новость опубликована в канале @BookCheef.\nЗаголовок: " + result.title + "\nID сообщения: " + result.message_id);
        return json({ ok: true, command: "testnews", message_id: result.message_id });
      } catch (error) {
        await sendText(token, chat.id, "❌ Не удалось отправить тестовую новость: " + String(error).slice(0, 450));
        return json({ ok: false, command: "testnews", error: String(error).slice(0, 450) }, 502);
      }
    }
    if (["/genstart", "/genstop", "/genstatus", "/genclear"].includes(command)) {
      if (!adminIds.has(senderId)) {
        await sendText(token, chat.id, "Управление генератором доступно только главному администратору.");
        return json({ ok: true, command: "generation_control_denied" });
      }
      try {
        if (command === "/genstatus") {
          const state = await getGenerationControl();
          await sendText(token, chat.id, (state.enabled ? "🟢 Генератор BookCheef ВКЛЮЧЁН." : "⏸ Генератор BookCheef ОСТАНОВЛЕН.") +
            "\nОчистка очереди: " + (state.clear_requested ? "ОЖИДАЕТСЯ" : "нет") +
            "\nОбновлено: " + state.updated_at + "\nКем: " + state.updated_by + "\n\nЗапуск: /genstart\nОстановка: /genstop\nПолная очистка: /genclear");
          return json({ ok: true, command: "genstatus", enabled: state.enabled, clear_requested: state.clear_requested });
        }
        if (command === "/genclear") {
          const confirmation = text.split(/\s+/)[1] || "";
          if (confirmation !== "CONFIRM") {
            await sendText(token, chat.id, "⚠️ Полная очистка удалит ВСЕ незавершённые книги и их метаданные: черновики, контрольные точки, отложенные задачи и ожидающие публикации. Опубликованные книги останутся. Генератор будет остановлен.\n\nДля подтверждения отправь точно: /genclear CONFIRM");
            return json({ ok: true, command: "genclear_confirmation_required" });
          }
          const state = await requestGenerationQueueClear(senderId);
          await sendText(token, chat.id, "🛑 Генератор остановлен. Запрос на полную очистку принят. Очистка выполнится в ближайшем цикле GitHub Actions (обычно до 5 минут), после завершения бот пришлёт отдельное подтверждение. Опубликованные книги не затрагиваются.");
          return json({ ok: true, command: "genclear", clear_requested: state.clear_requested });
        }
        const enabled = command === "/genstart";
        if (enabled) {
          const current = await getGenerationControl();
          if (current.clear_requested) {
            await sendText(token, chat.id, "⏳ Полная очистка очереди ещё выполняется. Запуск будет доступен после её завершения.");
            return json({ ok: true, command: "genstart_blocked_by_clear" });
          }
        }
        const state = await setGenerationControl(enabled, senderId);
        await sendText(token, chat.id, enabled
          ? "▶️ Генератор BookCheef включён. Возобновление начнётся в ближайшем цикле GitHub Actions (обычно до 5 минут). Сохранённые черновики и очередь остаются на месте."
          : "⏸ Генератор BookCheef остановлен. Новые ИИ-запросы не будут начинаться; уже выполняющийся запрос может завершиться, после чего черновик останется сохранённым. Очередь не удаляется.");
        return json({ ok: true, command: command.slice(1), enabled: state.enabled });
      } catch (error) {
        console.error("Generation control command failed:", String(error));
        await sendText(token, chat.id, "❌ Не удалось изменить состояние генератора: " + String(error).slice(0, 300));
        return json({ ok: false, command: command.slice(1) }, 502);
      }
    }
    if (command === "/status" && adminIds.has(senderId)) {
      try {
        const me = await telegram("getMe", token) as any;
        const channel = await telegram("getChat", token, { chat_id: channelId }) as any;
        const channelMember = await telegram("getChatMember", token, {
          chat_id: channelId,
          user_id: me.id,
        }) as any;
        const channelReady = channelMember.status === "administrator"
          && channelMember.can_post_messages === true;
        let groupLine = "Группа обсуждений: не привязана";
        if (channel.linked_chat_id) {
          try {
            const groupMember = await telegram("getChatMember", token, {
              chat_id: channel.linked_chat_id,
              user_id: me.id,
            }) as any;
            const groupReady = groupMember.status === "administrator"
              && groupMember.can_delete_messages === true;
            groupLine = `Группа обсуждений: привязана; удаление сообщений: ${groupReady ? "разрешено" : "НЕ разрешено"}`;
          } catch {
            groupLine = "Группа обсуждений: привязана, но бот не имеет доступа к проверке";
          }
        }
        const channelLine = `Канал ${channelId}: ${channelReady ? "администратор, публикация разрешена" : `нет прав на публикацию (статус: ${channelMember.status})`}`;
        await sendText(token, chat.id, `Проверка BookCheef 📚\n\n${channelLine}\n${groupLine}\n\nWebhook: работает (команда получена).`);
      } catch (error) {
        await sendText(token, chat.id, `Не удалось проверить настройки: ${String(error).slice(0, 500)}`);
      }
      return json({ ok: true, command: "status" });
    }
    if (command === "/status" && !adminIds.has(senderId)) {
      await sendText(token, chat.id, "Эта команда доступна только администратору BookCheef.");
      return json({ ok: true, command: "status_denied" });
    }
    if (command === "/fixpost4") {
      if (!adminIds.has(senderId)) {
        await sendText(token, chat.id, "Исправление публикации доступно только администратору BookCheef.");
        return json({ ok: true, command: "fixpost4_denied" });
      }
      const caption = [
        "📚 <b>НОВАЯ КНИГА В BOOKCHEEF</b>",
        "",
        "🔥 <b>«Последний узел станции Межа»</b>",
        "",
        "На станции «Межа» автономная система использовала личные воспоминания экипажа без их согласия.",
        "",
        "Два маршрута расследования и два финала поставят перед выбором: что важнее — непрерывность работы, безопасность или право на личную память?",
        "",
        [
          "✍️ <b>Автор:</b> Астэр Неваль",
          "🏷 <b>Жанр:</b> Интерактивная научная фантастика, этический техно-триллер",
          "📚 <b>Серия:</b> Станция «Межа»",
          "👤 <b>Возраст:</b> 16+"
        ].join("\n"),
        "",
        "🎮 <b>Интерактивная книга:</b> выбирайте маршрут расследования и влияйте на развитие истории.",
        "",
        '👇 <a href="https://kdnmgames.github.io/BookCheef/">ОТКРЫТЬ КНИГУ В BOOKCHEEF</a>'
      ].join("\n");
      try {
        await telegram("editMessageCaption", token, {
          chat_id: channelId,
          message_id: 4,
          caption,
          parse_mode: "HTML"
        });
        await sendText(token, chat.id, "Пост https://t.me/BookCheef/4 обновлён: добавил настоящие пустые строки между абзацами.");
        return json({ ok: true, command: "fixpost4", message_id: 4 });
      } catch (error) {
        await sendText(token, chat.id, "Не удалось обновить пост №4: " + String(error).slice(0, 400));
        return json({ ok: false, command: "fixpost4", error: String(error).slice(0, 400) }, 502);
      }
    }
    if (command === "/testbook") {
      if (!adminIds.has(senderId)) {
        await sendText(token, chat.id, "Тестовая публикация доступна только администратору BookCheef.");
        return json({ ok: true, command: "testbook_denied" });
      }
      const caption = [
        "📚 <b>НОВАЯ КНИГА В BOOKCHEEF</b>",
        "🔥 <b>«Последний узел станции Межа»</b>",
        "Интерактивный научно-фантастический триллер 16+ о станции, чья автономная система использовала личные воспоминания экипажа без согласия. Два маршрута расследования и два финала заставят решить, что важнее: непрерывность работы, безопасность или право на личную память.",
        [
          "✍️ <b>Автор:</b> Астэр Неваль",
          "🏷 <b>Жанр:</b> Интерактивная научная фантастика, этический техно-триллер",
          "📚 <b>Серия:</b> Станция «Межа»",
          "👤 <b>Возраст:</b> 16+"
        ].join("\n"),
        "🎮 <b>Это интерактивная книга:</b> выбирайте маршрут расследования и влияйте на развитие истории.",
        '👇 <a href="https://kdnmgames.github.io/BookCheef/">ОТКРЫТЬ КНИГУ В BOOKCHEEF</a>'
      ].join("\n\n");
      try {
        const result = await telegram("sendPhoto", token, {
          chat_id: channelId,
          photo: "https://wendffewxxmnaglfksfg.supabase.co/storage/v1/object/public/gallery/Preview_posledniy_zel_stantsii_mezha.png",
          caption,
          parse_mode: "HTML",
        }) as any;
        await sendText(token, chat.id, "Тестовый анонс опубликован в канале @BookCheef. ID сообщения: " + result.message_id);
        return json({ ok: true, command: "testbook", message_id: result.message_id });
      } catch (error) {
        await sendText(token, chat.id, "Не удалось опубликовать тестовый анонс: " + String(error).slice(0, 350));
        return json({ ok: false, command: "testbook", error: String(error).slice(0, 350) }, 502);
      }
    }

    if (command === "/help" && adminIds.has(senderId)) {
      try {
        await telegram("setMyCommands", token, {
          scope: { type: "chat", chat_id: chat.id },
          commands: [
            { command: "start", description: "Приветствие BookCheef" },
            { command: "help", description: "Список команд" },
            { command: "status", description: "Проверить состояние бота" },
            { command: "book", description: "Создать запрос на новую книгу" },
            { command: "bookstatus", description: "Статус последней книги" },
            { command: "bookstep", description: "Создать следующий шаг книги" },
            { command: "bookresume", description: "Продолжить книгу после квоты" },
            { command: "genstatus", description: "Состояние генератора книг" },
            { command: "genstart", description: "Запустить генерацию книг" },
            { command: "genstop", description: "Остановить генерацию книг" },
            { command: "genclear", description: "Полностью очистить очередь (с подтверждением)" },
            { command: "allow", description: "Разрешить доступ пользователю" },
            { command: "deny", description: "Закрыть доступ пользователю" },
            { command: "testnews", description: "Тестовая книжная новость" },
            { command: "testbook", description: "Тестовый анонс книги" }
          ]
        });
      } catch (error) {
        console.warn("Could not refresh admin command menu:", String(error));
      }
    }
    const replies: Record<string, string> = {
      "/start": "Привет! Это бот BookCheef 📚\n\nЗдесь будут новости книжной галереи, новые истории и интересные события из мира литературы.\n\nСайт: https://kdnmgames.github.io/BookCheef/\nКанал: https://t.me/BookCheef",
      "/help": "📚 BOOKCHEEF BOT — СПИСОК КОМАНД\n\nОСНОВНЫЕ КОМАНДЫ\n/start — запустить бота и получить приветствие\n/help — показать этот список команд\n/site — открыть сайт и книжную галерею BookCheef\n/channel — открыть Telegram-канал BookCheef\n\nКОМАНДЫ АДМИНИСТРАТОРА\n/status — проверить работу бота, права публикации в канале и подключение группы обсуждений\n/allow ID — разрешить пользователю доступ к приватному боту (вместо ID укажи числовой Telegram ID)\n/deny ID — закрыть пользователю доступ к приватному боту\n/testnews — отправить в канал тестовую книжную новость из RSS; публикация будет помечена как тестовая\n/testbook — опубликовать тестовый анонс книги с обложкой\n/fixpost4 — исправить текст и абзацы в публикации канала №4\n/genstatus — проверить состояние генератора\n/genstart — включить генерацию книг\n/genstop — остановить генерацию книг\n/genclear — полная очистка очереди (подтверждение: /genclear CONFIRM)\n\nПримеры управления доступом:\n/allow 123456789\n/deny 123456789\n\nПриватный бот доступен только пользователям из списка разрешённых. Команды администратора работают только у главного администратора.\n\nСайт: https://kdnmgames.github.io/BookCheef/\nКанал: https://t.me/BookCheef",
      "/site": "Книжная галерея BookCheef: https://kdnmgames.github.io/BookCheef/",
      "/channel": "Telegram-канал BookCheef: https://t.me/BookCheef",
    };
    await sendText(token, chat.id, replies[command] ?? "Не знаю такую команду. Напиши /help.");
  }

  return json({ ok: true });
});
