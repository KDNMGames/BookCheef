import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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

function splitBook(markdown: string, bookTitle: string, interactiveContent?: any) {
  const nodes = Array.isArray(interactiveContent?.nodes) ? interactiveContent.nodes : [];
  if (nodes.length) {
    return nodes.map((node: any, index: number) => {
      const choices = Array.isArray(node?.choices) ? node.choices.map((choice: any) => String(choice?.label ?? "").trim()).filter(Boolean) : [];
      const text = [String(node?.text ?? "").trim(), choices.length ? `Варианты выбора: ${choices.join(". ")}.` : ""].filter(Boolean).join("\n\n");
      return { title: String(node?.title ?? `Сцена ${index + 1}`), text };
    }).filter((chapter: any) => chapter.text);
  }
  const source = String(markdown ?? "").replace(/\r\n?/g, "\n").trim();
  const headings = [...source.matchAll(/^##\s+(.+)$/gm)];
  if (!headings.length) {
    const cleaned = source.replace(/^#\s+[^\n]+\n*/, "").trim();
    return cleaned ? [{ title: bookTitle || "Полная книга", text: cleaned }] : [];
  }

  const chapters: { title: string; text: string }[] = [];
  const first = headings[0].index ?? 0;
  const intro = source.slice(0, first).replace(/^#\s+[^\n]+\n*/, "").trim();
  if (intro.length > 80) chapters.push({ title: "Вступление", text: intro });

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const start = (heading.index ?? 0) + heading[0].length;
    const end = i + 1 < headings.length ? (headings[i + 1].index ?? source.length) : source.length;
    const text = source.slice(start, end).trim();
    if (text) chapters.push({ title: heading[1].trim(), text });
  }
  return chapters;
}

function cleanForSpeech(markdown: string) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[\^?\d+\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitText(text: string, maxChars = 6200) {
  const paragraphs = text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) { chunks.push(current); current = ""; }
      let rest = paragraph;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(". ", maxChars);
        if (cut < maxChars * 0.55) cut = rest.lastIndexOf(" ", maxChars);
        if (cut < 1) cut = maxChars;
        chunks.push(rest.slice(0, cut + (rest[cut] === "." ? 1 : 0)).trim());
        rest = rest.slice(cut + (rest[cut] === "." ? 1 : 0)).trim();
      }
      if (rest) current = rest;
      continue;
    }
    if (!current) current = paragraph;
    else if (current.length + paragraph.length + 2 <= maxChars) current += "\n\n" + paragraph;
    else { chunks.push(current); current = paragraph; }
  }
  if (current) chunks.push(current);
  return chunks;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function extractPcm(bytes: Uint8Array) {
  if (bytes.length >= 44 &&
      String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE") {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const name = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
      const start = offset + 8;
      if (name === "data") return bytes.slice(start, Math.min(start + size, bytes.length));
      offset = start + size + (size % 2);
    }
    throw new Error("Gemini вернул WAV без аудиоданных");
  }
  return bytes;
}

function makeWav(pcm: Uint8Array) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.length, true);
  const output = new Uint8Array(44 + pcm.length);
  output.set(new Uint8Array(header), 0);
  output.set(pcm, 44);
  return output;
}

async function callTts(model: string, text: string, apiKey: string) {
  const isNew = model === "gemini-3.8-flash-tts";
  const part: Record<string, unknown> = {
    text,
    ...(isNew ? {
      speechMetadata: {
        style: "Русская художественная аудиокнига. Естественная, выразительная, тёплая и уверенная дикторская подача; ясная артикуляция, плавный темп, точные паузы, деликатная эмоциональная окраска без театрального переигрывания."
      }
    } : {}),
  };
  const speechConfig = isNew
    ? { voiceConfig: { voice: "Charon" }, languageCode: "ru-RU" }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } }, languageCode: "ru-RU" };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [part] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig },
      }),
    },
  );
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const message = String(result?.error?.message ?? `HTTP ${response.status}`).slice(0, 350);
    throw new Error(`${model}: ${message}`);
  }
  const encoded = result?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data)?.inlineData?.data;
  if (typeof encoded !== "string" || !encoded) throw new Error(`${model}: модель не вернула аудио`);
  return decodeBase64(encoded);
}

async function generateChunk(text: string, apiKey: string) {
  try {
    return { bytes: await callTts("gemini-3.8-flash-tts", text, apiKey), model: "gemini-3.8-flash-tts" };
  } catch (primaryError) {
    // The fallback is also on Google's Gemini API free tier; no paid provider is called.
    try {
      return { bytes: await callTts("gemini-2.5-flash-preview-tts", text, apiKey), model: "gemini-2.5-flash-preview-tts" };
    } catch (fallbackError) {
      throw new Error(`Не удалось создать аудио ни основной, ни резервной бесплатной моделью. ${String(primaryError).slice(0, 180)}; ${String(fallbackError).slice(0, 180)}`);
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Некорректный JSON" }, 400); }

  const url = Deno.env.get("SUPABASE_URL");
  const secretRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!url || !secretRaw || !apiKey) return json({ error: "Серверная конфигурация озвучки не завершена" }, 503);

  let secretKey = "";
  try { secretKey = JSON.parse(secretRaw).default ?? ""; }
  catch { return json({ error: "Не удалось прочитать серверный ключ Supabase" }, 503); }
  if (!secretKey) return json({ error: "Серверный ключ Supabase недоступен" }, 503);

  const configuredPublisherToken = Deno.env.get("BOOK_PUBLISHER_TOKEN") ?? "";
  const suppliedPublisherToken = req.headers.get("x-book-audio-publisher-token") ?? "";
  const internalCall = !!configuredPublisherToken && safeEqual(suppliedPublisherToken, configuredPublisherToken);
  const auth = req.headers.get("Authorization") ?? "";
  const accessToken = auth.replace(/^Bearer\s+/i, "");
  if (!internalCall && !accessToken) return json({ error: "Требуется авторизация" }, 401);

  const adminDb = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  if (!internalCall) {
    const { data: userResult, error: userError } = await adminDb.auth.getUser(accessToken);
    if (userError || !userResult?.user) return json({ error: "Сессия недействительна. Войди в аккаунт заново." }, 401);
    const { data: adminRecord, error: adminError } = await adminDb
      .from("admins").select("user_id").eq("user_id", userResult.user.id).maybeSingle();
    if (adminError || !adminRecord) return json({ error: "Создавать аудиокниги может только администратор BookCheef" }, 403);
  }

  if (payload.action === "process_next") {
    if (!internalCall) return json({ error: "Недостаточно прав для фоновой обработки" }, 403);
    const { data: books, error: booksError } = await adminDb.from("books")
      .select("id,title,book_content,interactive_content,is_interactive,created_at")
      .order("created_at", { ascending: true })
      .limit(1000);
    if (booksError) return json({ error: "Не удалось получить список книг для озвучки" }, 500);
    const { data: audioRows, error: audioError } = await adminDb.from("book_audio_chapters")
      .select("book_id,chapter_index,content_hash,updated_at");
    if (audioError) return json({ error: "Не удалось проверить уже созданные аудиоглавы" }, 500);

    const rowsByBook = new Map<string, any[]>();
    for (const row of audioRows ?? []) {
      const list = rowsByBook.get(row.book_id) ?? [];
      list.push(row);
      rowsByBook.set(row.book_id, list);
    }
    const candidates: any[] = [];
    for (const book of books ?? []) {
      const chapters = splitBook(book.book_content, book.title, book.interactive_content);
      if (!chapters.length) continue;
      const existingRows = rowsByBook.get(book.id) ?? [];
      let pendingIndex = -1;
      for (let i = 0; i < chapters.length; i++) {
        const spoken = cleanForSpeech(chapters[i].text);
        if (!spoken) continue;
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(spoken));
        const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        const existing = existingRows.find((row) => row.chapter_index === i + 1);
        if (existing?.content_hash !== hash) { pendingIndex = i + 1; break; }
      }
      if (pendingIndex < 0) continue;
      const lastAudioAt = existingRows.reduce((latest, row) => {
        const stamp = Date.parse(row.updated_at ?? "");
        return Number.isFinite(stamp) ? Math.max(latest, stamp) : latest;
      }, 0);
      candidates.push({ book_id: book.id, chapter_index: pendingIndex, lastAudioAt, createdAt: Date.parse(book.created_at ?? "") || 0 });
    }
    candidates.sort((a, b) => a.lastAudioAt - b.lastAudioAt || a.createdAt - b.createdAt);
    if (!candidates.length) return json({ ok: true, empty: true, message: "Все обычные книги уже озвучены" });
    payload.book_id = candidates[0].book_id;
    payload.chapter_index = candidates[0].chapter_index;
  }

  const bookId = String(payload.book_id ?? "");
  const chapterIndex = Number(payload.chapter_index);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bookId) ||
      !Number.isInteger(chapterIndex) || chapterIndex < 1 || chapterIndex > 300) {
    return json({ error: "Некорректная книга или номер главы" }, 400);
  }

  const { data: book, error: bookError } = await adminDb
    .from("books").select("id,title,book_content,interactive_content,is_interactive,is_free").eq("id", bookId).single();
  if (bookError || !book) return json({ error: "Книга не найдена" }, 404);
  const chapters = splitBook(book.book_content, book.title, book.interactive_content);
  if (!chapters.length) return json({ error: "Для озвучки нужен текст книги или заполненные сцены интерактивной книги; вложенные PDF/DOCX пока не поддерживаются" }, 400);
  const chapter = chapters[chapterIndex - 1];
  if (!chapter) return json({ error: "Глава с таким номером не найдена" }, 404);

  const spokenText = cleanForSpeech(chapter.text);
  if (!spokenText) return json({ error: "В этой главе нет текста для озвучки" }, 400);
  if (spokenText.length > 50000) return json({ error: "Глава слишком большая для одной операции. Раздели её на несколько глав (до 50 000 символов)." }, 413);

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(spokenText));
  const contentHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const voiceName = "Charon";
  const { data: existing } = await adminDb.from("book_audio_chapters")
    .select("id,content_hash,storage_path,model,duration_seconds")
    .eq("book_id", bookId).eq("chapter_index", chapterIndex).maybeSingle();

  if (existing?.content_hash === contentHash && payload.force !== true) {
    return json({ ok: true, skipped: true, reason: "already_current", chapter_index: chapterIndex, chapter_title: chapter.title, audio: existing });
  }

  const chunks = splitText(spokenText);
  const pcmParts: Uint8Array[] = [];
  let selectedModel = "gemini-3.8-flash-tts";
  try {
    for (const chunk of chunks) {
      const generated = await generateChunk(chunk, apiKey);
      selectedModel = generated.model;
      pcmParts.push(extractPcm(generated.bytes));
    }
  } catch (generationError) {
    const message = String(generationError instanceof Error ? generationError.message : generationError).slice(0, 900);
    const rateLimited = /429|RESOURCE_EXHAUSTED|quota|rate.?limit|exhausted/i.test(message);
    return json({ error: message, rate_limited: rateLimited, retry_later: true }, rateLimited ? 429 : 503);
  }
  const totalLength = pcmParts.reduce((sum, part) => sum + part.length, 0);
  const pcm = new Uint8Array(totalLength);
  let cursor = 0;
  for (const part of pcmParts) { pcm.set(part, cursor); cursor += part.length; }
  const wav = makeWav(pcm);
  const storagePath = `books/${bookId}/chapter-${String(chapterIndex).padStart(3, "0")}.wav`;

  const { error: uploadError } = await adminDb.storage.from("book-audio").upload(storagePath, wav, {
    contentType: "audio/wav",
    cacheControl: "31536000",
    upsert: true,
  });
  if (uploadError) return json({ error: "Не удалось сохранить аудиофайл в Supabase Storage" }, 500);

  const duration = Math.round((pcm.length / 48000) * 100) / 100;
  const { data: saved, error: saveError } = await adminDb.from("book_audio_chapters").upsert({
    book_id: bookId,
    chapter_index: chapterIndex,
    chapter_title: chapter.title,
    storage_path: storagePath,
    duration_seconds: duration,
    voice_name: voiceName,
    model: selectedModel,
    content_hash: contentHash,
    status: "ready",
    updated_at: new Date().toISOString(),
  }, { onConflict: "book_id,chapter_index" }).select("*").single();
  if (saveError) return json({ error: "Аудио сохранено, но метаданные не удалось обновить" }, 500);

  return json({
    ok: true,
    chapter_index: chapterIndex,
    chapter_title: chapter.title,
    audio: saved,
    model: selectedModel,
    voice_name: voiceName,
    chunks: chunks.length,
    bytes: wav.length,
  });
});
