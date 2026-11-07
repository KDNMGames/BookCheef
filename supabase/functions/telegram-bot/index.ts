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
  const internalCall = safeEqual(suppliedInternalSecret, internalSecret);

  if (!internalCall && !safeEqual(suppliedWebhookSecret, webhookSecret)) {
    return json({ error: "Unauthorized" }, 401);
  }

  let update: any;
  try { update = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  if (internalCall) {
    const text = String(update.text ?? "").trim();
    const photo = String(update.photo_url ?? "").trim();
    if (!text && !photo) return json({ error: "text or photo_url is required" }, 400);
    const chatId = String(update.chat_id ?? channelId);
    const result = photo
      ? await telegram("sendPhoto", token, {
          chat_id: chatId,
          photo,
          caption: text.slice(0, 1024),
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
    const replies: Record<string, string> = {
      "/start": "Привет! Это бот BookCheef 📚\n\nЗдесь будут новости книжной галереи, новые истории и интересные события из мира литературы.\n\nСайт: https://kdnmgames.github.io/BookCheef/\nКанал: https://t.me/BookCheef",
      "/help": "Команды BookCheef:\n/start — приветствие\n/help — помощь\n/site — открыть книжную галерею\n/channel — открыть Telegram-канал",
      "/site": "Книжная галерея BookCheef: https://kdnmgames.github.io/BookCheef/",
      "/channel": "Telegram-канал BookCheef: https://t.me/BookCheef",
    };
    await sendText(token, chat.id, replies[command] ?? "Не знаю такую команду. Напиши /help.");
  }

  return json({ ok: true });
});
