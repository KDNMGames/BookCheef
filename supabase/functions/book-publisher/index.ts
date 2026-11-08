import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type ImageInput = { mime_type: string; base64: string };
type IllustrationInput = ImageInput & { chapter: string | number; number: number };

const allowedMime = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const extByMime: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function safePart(value: string): string {
  const ru: Record<string, string> = {
    "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"yo","ж":"zh",
    "з":"z","и":"i","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o",
    "п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"kh","ц":"ts",
    "ч":"ch","ш":"sh","щ":"shch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya"
  };
  const transliterated = value.replace(/[А-ЯЁа-яё]/g, (letter) => ru[letter.toLowerCase()] ?? letter);
  const latin = transliterated.normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .replace(/[^A-Za-z0-9-]+/g, "_");
  return latin.replace(/^_+|_+$/g, "").slice(0, 90) || "Book";
}

function decodeImage(image: ImageInput): Uint8Array {
  if (!allowedMime.has(image.mime_type) || typeof image.base64 !== "string") {
    throw new Error("Unsupported image format");
  }
  const raw = image.base64.replace(/^data:[^;]+;base64,/, "");
  const binary = atob(raw);
  if (binary.length === 0 || binary.length > 10 * 1024 * 1024) {
    throw new Error("Image must be between 1 byte and 10 MB");
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}


async function generateCloudflareImage(prompt: string): Promise<ImageInput> {
  const accountId = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = Deno.env.get("CLOUDFLARE_API_TOKEN");
  if (!accountId || !apiToken) throw new Error("Cloudflare image generator is not configured");
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 2048) {
    throw new Error("Image prompt must contain 1-2048 characters");
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: prompt.trim(), steps: 4 }),
    },
  );

  const result = await response.json().catch(() => null);
  const image = result?.result?.image;
  if (!response.ok || result?.success !== true || typeof image !== "string" || !image) {
    throw new Error("Cloudflare image generation failed or free quota is exhausted");
  }
  return { mime_type: "image/jpeg", base64: image };
}


async function generateOvhImage(prompt: string): Promise<ImageInput> {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 2048) {
    throw new Error("Image prompt must contain 1-2048 characters");
  }
  const response = await fetch("https://stable-diffusion-xl.endpoints.kepler.ai.cloud.ovh.net/api/text2image", {
    method: "POST",
    headers: { "accept": "application/octet-stream", "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: prompt.trim(),
      negative_prompt: "extra limbs, extra fingers, duplicate body parts, malformed anatomy, deformed face, blurry, low quality, text, watermark, logo"
    }),
  });
  if (!response.ok) {
    const details = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`OVHcloud image generation failed (HTTP ${response.status}) ${details}`);
  }
  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  if (contentType.includes("application/json")) {
    const result = await response.json().catch(() => null);
    const encoded = result?.data?.[0]?.b64_json ?? result?.b64_json;
    if (typeof encoded !== "string" || !encoded) throw new Error("OVHcloud returned no image data");
    return { mime_type: "image/jpeg", base64: encoded };
  }
  const rawMime = contentType.split(";")[0].trim();
  if (!contentType.startsWith("image/") && rawMime !== "application/octet-stream") {
    throw new Error("OVHcloud returned an unsupported content type");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
    throw new Error("OVHcloud image must be between 1 byte and 10 MB");
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  const mime = rawMime === "application/octet-stream" ? "image/jpeg" : rawMime;
  if (!allowedMime.has(mime)) throw new Error("OVHcloud returned an unsupported image format");
  return { mime_type: mime, base64: btoa(binary) };
}

async function resolveImage(input: any): Promise<ImageInput> {
  if (input && typeof input.base64 === "string" && typeof input.mime_type === "string") {
    return { mime_type: input.mime_type, base64: input.base64 };
  }
  if (input && typeof input.prompt === "string") {
    return await generateCloudflareImage(input.prompt);
  }
  throw new Error("Each image must contain a prompt");
}

function replaceIllustrationTokens(value: unknown, urls: Map<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{illustration:([^:}]+):(\d+)\}\}/g, (_match, chapter, number) =>
      urls.get(`${String(chapter)}:${Number(number)}`) ?? _match
    );
  }
  if (Array.isArray(value)) return value.map((item) => replaceIllustrationTokens(item, urls));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, replaceIllustrationTokens(item, urls)]));
  }
  return value;
}


function normalizeBookContent(value: string, title: string): string {
  let result = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  result = result.replace(/^(ГЛАВА\s+\d+[^\n]*|ВСТУПЛЕНИЕ[^\n]*|ЗАКЛЮЧЕНИЕ[^\n]*|ПОСЛЕСЛОВИЕ[^\n]*)$/gim, (line) => "## " + line.charAt(0).toUpperCase() + line.slice(1));
  result = result.replace(/^## глава\s+(\d+)(.*)$/gim, (_m, n, tail) => "## Глава " + n + tail);
  result = result.replace(/\n{2,}ВОПРОСЫ(?:\s+ДЛЯ[^\n]*|\s+ПО[^\n]*|\s+К[^\n]*)?\s*\n[\s\S]*$/i, "").trim();
  const first = result.split("\n", 1)[0]?.trim() ?? "";
  const firstHeading = first.replace(/^#{1,2}\s+/, "").trim();
  if (firstHeading.toLocaleLowerCase() === title.toLocaleLowerCase()) {
    result = "# " + title + result.slice(first.length);
  } else if (!/^#{1,2}\s+/.test(first)) {
    result = "# " + title + "\n\n" + result;
  }
  return result;
}

function embedMissingIllustrations(content: string, items: IllustrationInput[], urls: Map<string, string>): string {
  let result = content;
  for (const item of items) {
    const chapter = String(item.chapter ?? "").trim();
    const url = urls.get(String(chapter) + ":" + Number(item.number));
    if (!url || result.includes(url)) continue;
    const lines = result.split("\n");
    const index = lines.findIndex((line) => line.toLocaleLowerCase().includes(chapter.toLocaleLowerCase()));
    const markdown = "![Иллюстрация к " + chapter + "](" + url + ")";
    if (index >= 0) lines.splice(index + 1, 0, "", markdown, "");
    else lines.push("", markdown);
    result = lines.join("\n").replace(/\n{4,}/g, "\n\n\n");
  }
  return result;
}

function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const configuredToken = Deno.env.get("BOOK_PUBLISHER_TOKEN");
  if (!configuredToken) return Response.json({ error: "Publisher is not configured" }, { status: 503 });
  const suppliedToken = req.headers.get("x-book-publisher-token") ?? "";
  if (!safeEqual(suppliedToken, configuredToken)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: any;
  try {
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > 24 * 1024 * 1024) return Response.json({ error: "Payload too large" }, { status: 413 });
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (payload.action === "test_image") {
    try {
      const generated = await generateCloudflareImage(
        typeof payload.prompt === "string" && payload.prompt.trim()
          ? payload.prompt
          : "A friendly colorful storybook illustration of a small red fox reading a book under a glowing tree, whimsical watercolor, no text"
      );
      const bytes = decodeImage(generated);
      return Response.json({
        ok: true,
        test: true,
        provider: "Cloudflare Workers AI",
        model: "@cf/black-forest-labs/flux-1-schnell",
        mime_type: generated.mime_type,
        image_bytes: bytes.length,
        stored: false,
        published: false
      });
    } catch (error) {
      return Response.json({
        ok: false,
        test: true,
        stored: false,
        published: false,
        error: error instanceof Error ? error.message : "Cloudflare image test failed"
      }, { status: 503 });
    }
  }

  if (payload.action === "test_gemini") {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return Response.json({ ok: false, test: true, stored: false, published: false, error: "Gemini API key is not configured" }, { status: 503 });
    }
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent", {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Ответь по-русски одним коротким предложением: почему детям полезно читать сказки?" }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 128 },
        }),
      });
      const result = await response.json().catch(() => null);
      const sample = result?.candidates?.[0]?.content?.parts
        ?.map((part: any) => typeof part.text === "string" ? part.text : "")
        .join("")
        .trim();
      if (!response.ok || !sample) {
        const providerMessage = typeof result?.error?.message === "string"
          ? result.error.message.slice(0, 500)
          : "No provider error message returned";
        return Response.json({
          ok: false,
          test: true,
          stored: false,
          published: false,
          model: "gemini-3.5-flash-lite",
          provider_http_status: response.status,
          provider_error: providerMessage,
          error: response.status === 429
            ? "Gemini free quota or rate limit is exhausted"
            : `Gemini API request failed (HTTP ${response.status})`,
        }, { status: 503 });
      }
      return Response.json({
        ok: true,
        test: true,
        provider: "Google Gemini API",
        model: "gemini-3.5-flash-lite",
        sample,
        stored: false,
        published: false,
      });
    } catch {
      return Response.json({
        ok: false,
        test: true,
        stored: false,
        published: false,
        error: "Gemini API connection failed",
      }, { status: 503 });
    }
  }

  if (payload.action === "check_publication") {
    try {
      const publicationKey = typeof payload.publication_key === "string" ? payload.publication_key.trim() : "";
      if (!publicationKey || publicationKey.length > 160) {
        return Response.json({ ok: false, error: "A valid publication_key is required" }, { status: 400 });
      }
      const url = Deno.env.get("SUPABASE_URL");
      const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
      if (!url || !secretKeysRaw) return Response.json({ ok: false, error: "Supabase server configuration is missing" }, { status: 503 });
      const secretKey = JSON.parse(secretKeysRaw).default;
      if (!secretKey) return Response.json({ ok: false, error: "Supabase server key is unavailable" }, { status: 503 });
      const supabase = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await supabase.from("books")
        .select(payload.include_content === true ? "id,title,publication_key,cover_url,created_at,book_content,interactive_content" : "id,title,publication_key,cover_url,created_at")
        .eq("publication_key", publicationKey).maybeSingle();
      if (error) throw new Error("Publication lookup failed");
      return Response.json({ ok: true, published: Boolean(data), book: data ?? null });
    } catch (error) {
      return Response.json({ ok: false, action: "check_publication", error: error instanceof Error ? error.message : "Publication lookup failed" }, { status: 500 });
    }
  }

  if (payload.action === "upload_image") {
    try {
      const path = typeof payload.path === "string" ? payload.path : "";
      if (!/^generated\/[a-z0-9-]{8,160}\/(?:cover|illustration-[1-5])\.(?:png|jpg|webp|gif)$/.test(path)) {
        return Response.json({ ok: false, error: "Invalid generated image path" }, { status: 400 });
      }
      const image = { mime_type: String(payload.mime_type ?? ""), base64: String(payload.base64 ?? "") };
      const bytes = decodeImage(image);
      const url = Deno.env.get("SUPABASE_URL");
      const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
      if (!url || !secretKeysRaw) return Response.json({ ok: false, error: "Supabase server configuration is missing" }, { status: 503 });
      const secretKey = JSON.parse(secretKeysRaw).default;
      if (!secretKey) return Response.json({ ok: false, error: "Supabase server key is unavailable" }, { status: 503 });
      const supabase = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await supabase.storage.from("gallery").upload(path, bytes, {
        contentType: image.mime_type, cacheControl: "3600", upsert: true,
      });
      if (error) throw new Error("Generated image upload failed");
      const { data } = supabase.storage.from("gallery").getPublicUrl(path);
      return Response.json({ ok: true, action: "upload_image", path, url: data.publicUrl, image_bytes: bytes.length });
    } catch (error) {
      return Response.json({ ok: false, action: "upload_image", error: error instanceof Error ? error.message : "Image upload failed" }, { status: 400 });
    }
  }

  if (payload.action === "generate_image") {
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const provider = payload.provider === "ovh" ? "ovh" : "cloudflare";
    try {
      const generated = provider === "ovh"
        ? await generateOvhImage(prompt)
        : await generateCloudflareImage(prompt);
      const bytes = decodeImage(generated);
      return Response.json({
        ok: true,
        action: "generate_image",
        provider: provider === "ovh" ? "OVHcloud AI Endpoints" : "Cloudflare Workers AI",
        model: provider === "ovh" ? "stable-diffusion-xl-base-v10" : "@cf/black-forest-labs/flux-1-schnell",
        mime_type: generated.mime_type,
        base64: generated.base64,
        image_bytes: bytes.length,
      });
    } catch (error) {
      return Response.json({
        ok: false,
        action: "generate_image",
        provider,
        error: error instanceof Error ? error.message.slice(0, 500) : "Image generation failed",
      }, { status: 503 });
    }
  }

  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const publicationKey = typeof payload.publication_key === "string" ? payload.publication_key.trim() : "";
  const content = typeof payload.book_content === "string" ? payload.book_content : "";
  if (!title || title.length > 180 || !publicationKey || publicationKey.length > 160 || !content.trim()) {
    return Response.json({ error: "title, publication_key and book_content are required" }, { status: 400 });
  }
  const illustrationItems = payload.illustrations ?? [];
  if (!payload.cover || !Array.isArray(illustrationItems) || illustrationItems.length < 1 || illustrationItems.length > 5) {
    return Response.json({ error: "A cover and between one and five illustrations are required" }, { status: 400 });
  }
  const illustrationKeys = new Set<string>();
  for (const item of illustrationItems) {
    const chapter = String(item?.chapter ?? "").trim();
    const number = Number(item?.number);
    const key = `${chapter}:${number}`;
    if (!chapter || !Number.isInteger(number) || number < 1 || number > 5 || illustrationKeys.has(key) || !(item?.prompt || item?.base64 || item?.url)) {
      return Response.json({ error: "Each illustration needs a unique chapter and a number from 1 to 5" }, { status: 400 });
    }
    illustrationKeys.add(key);
  }
  if (!Array.isArray(payload.reader_questions) || payload.reader_questions.length < 3 || payload.reader_questions.length > 5 || payload.reader_questions.some((q: any) => !String(q?.question ?? "").trim() || !String(q?.answer ?? "").trim())) {
    return Response.json({ error: "reader_questions must contain three to five question and answer pairs" }, { status: 400 });
  }
  if (payload.footnotes !== undefined && (!Array.isArray(payload.footnotes) || payload.footnotes.length > 30 || payload.footnotes.some((f: any) => !String(f?.word ?? f?.term ?? "").trim() || !String(f?.text ?? f?.note ?? "").trim()))) {
    return Response.json({ error: "footnotes must contain word and definition pairs" }, { status: 400 });
  }
  const ageValue = Number.parseInt(String(payload.age ?? "6+").replace(/[^0-9]/g, ""), 10) || 0;
  if (ageValue >= 6 && (!Array.isArray(payload.footnotes) || payload.footnotes.length < 1) && !(Array.isArray(payload.interactive_content?.footnotes) && payload.interactive_content.footnotes.length > 0)) {
    return Response.json({ error: "Books for age 6+ must include age-appropriate footnotes" }, { status: 400 });
  }

  // Check idempotency BEFORE image generation so duplicate workflow runs do not burn image quota.
  const preflightUrl = Deno.env.get("SUPABASE_URL");
  const preflightSecretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!preflightUrl || !preflightSecretKeysRaw) {
    return Response.json({ error: "Supabase server configuration is missing" }, { status: 503 });
  }

  let preflightSecretKey: string;
  try {
    preflightSecretKey = JSON.parse(preflightSecretKeysRaw).default;
  } catch {
    return Response.json({ error: "Supabase server key configuration is invalid" }, { status: 503 });
  }
  if (!preflightSecretKey) {
    return Response.json({ error: "Supabase server key is unavailable" }, { status: 503 });
  }

  const preflightSupabase = createClient(preflightUrl, preflightSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: preflightExisting, error: preflightLookupError } = await preflightSupabase
    .from("books").select("id,title").eq("publication_key", publicationKey).maybeSingle();
  if (preflightLookupError) {
    return Response.json({ error: "Could not check publication key" }, { status: 500 });
  }
  if (preflightExisting) {
    return Response.json({ ok: true, already_published: true, book: preflightExisting });
  }

  const providedCoverUrl = typeof payload.cover?.url === "string" ? payload.cover.url.trim() : "";
  if (providedCoverUrl) {
    try {
      const coverUrl = new URL(providedCoverUrl);
      if (coverUrl.hostname !== "wendffewxxmnaglfksfg.supabase.co" || !coverUrl.pathname.startsWith("/storage/v1/object/public/gallery/")) {
        return Response.json({ error: "cover.url must be an existing public image in the BookCheef gallery" }, { status: 400 });
      }
    } catch {
      return Response.json({ error: "cover.url is invalid" }, { status: 400 });
    }
  }
  if (payload.update_book_id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(payload.update_book_id))) {
    return Response.json({ error: "update_book_id must be a valid book UUID" }, { status: 400 });
  }

  // Generate requested images before touching Storage or the books table.
  // Any provider error, including exhausted free quota, skips this book entirely.
  try {
    if (!providedCoverUrl) payload.cover = await resolveImage(payload.cover);
    payload.illustrations = await Promise.all(
      (payload.illustrations ?? []).map(async (item: any) => item.url
        ? { url: String(item.url), chapter: item.chapter, number: item.number }
        : { ...(await resolveImage(item)), chapter: item.chapter, number: item.number }),
    );
  } catch {
    return Response.json({
      ok: false,
      skipped: true,
      reason: "image_generation_unavailable_or_free_quota_exhausted",
      error: "Images could not be generated. The book was not published.",
    }, { status: 503 });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!url || !secretKeysRaw) return Response.json({ error: "Supabase server configuration is missing" }, { status: 503 });

  let secretKey: string;
  try {
    secretKey = JSON.parse(secretKeysRaw).default;
  } catch {
    return Response.json({ error: "Supabase server key configuration is invalid" }, { status: 503 });
  }
  if (!secretKey) return Response.json({ error: "Supabase server key is unavailable" }, { status: 503 });

  const supabase = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: existing, error: lookupError } = await supabase
    .from("books").select("id,title").eq("publication_key", publicationKey).maybeSingle();
  if (lookupError) return Response.json({ error: "Could not check publication key" }, { status: 500 });
  if (existing) return Response.json({ ok: true, already_published: true, book: existing });

  const uploadedPaths: string[] = [];
  const titlePart = safePart(title);
  const urls = new Map<string, string>();

  async function upload(image: ImageInput, path: string): Promise<string> {
    const bytes = decodeImage(image);
    const { error } = await supabase.storage.from("gallery").upload(path, bytes, {
      contentType: image.mime_type,
      cacheControl: "3600",
      upsert: false,
    });
    if (error) throw new Error("Storage upload failed");
    uploadedPaths.push(path);
    const { data } = supabase.storage.from("gallery").getPublicUrl(path);
    return data.publicUrl;
  }

  try {
    const coverPath = `Preview_${titlePart}.${extByMime[payload.cover?.mime_type] ?? "png"}`;
    const coverUrl = providedCoverUrl || await upload(payload.cover, coverPath);

    for (const item of (payload.illustrations ?? []) as IllustrationInput[]) {
      const chapter = String(item.chapter ?? "").trim();
      const number = Number(item.number);
      if (!chapter || !Number.isInteger(number) || number < 1) throw new Error("Invalid illustration index");
      let imageUrl: string;
      if (typeof (item as any).url === "string") {
        const parsed = new URL((item as any).url);
        if (parsed.hostname !== "wendffewxxmnaglfksfg.supabase.co" || !parsed.pathname.startsWith("/storage/v1/object/public/gallery/")) {
          throw new Error("Illustration URL must point to the public BookCheef gallery");
        }
        imageUrl = parsed.toString();
      } else {
        const chapterPart = safePart(chapter);
        const path = `${titlePart}_${chapterPart}_${number}.${extByMime[item.mime_type] ?? "png"}`;
        imageUrl = await upload(item, path);
      }
      urls.set(`${chapter}:${number}`, imageUrl);
    }

    const interactiveDraft = payload.interactive_content && typeof payload.interactive_content === "object"
      ? { ...payload.interactive_content }
      : {};
    if (Array.isArray(payload.footnotes) && payload.footnotes.length) {
      interactiveDraft.footnotes = payload.footnotes;
    }
    if (payload.footnote_style && typeof payload.footnote_style === "object") {
      interactiveDraft.footnote_style = payload.footnote_style;
    }
    const interactive = Object.keys(interactiveDraft).length
      ? replaceIllustrationTokens(interactiveDraft, urls)
      : null;
    const normalizedContent = normalizeBookContent(content, title);
    const resolvedContent = replaceIllustrationTokens(normalizedContent, urls) as string;
    const bookContent = embedMissingIllustrations(resolvedContent, illustrationItems as IllustrationInput[], urls);
    const questions = Array.isArray(payload.reader_questions)
      ? payload.reader_questions.map((q: any) => ({ question: String(q.question).trim(), answer: String(q.answer).trim() }))
      : [];

    const row = {
      title,
      category: String(payload.category ?? "Без категории").slice(0, 120),
      description: String(payload.description ?? "").slice(0, 5000),
      cover_url: coverUrl,
      buy_url: "",
      author: String(payload.author ?? "BookCheef").slice(0, 180),
      age: String(payload.age ?? "6+").slice(0, 30),
      genre: String(payload.genre ?? "Сказка").slice(0, 120),
      series: String(payload.series ?? "").slice(0, 180),
      is_free: payload.is_free !== false,
      price: null,
      book_content: bookContent,
      interactive_content: interactive,
      is_interactive: payload.is_interactive === true || (Array.isArray(interactiveDraft.nodes) && interactiveDraft.nodes.length > 0),
      reader_questions: questions,
      publication_key: publicationKey,
    };

    if (payload.update_book_id) {
      const { data: updated, error: updateError } = await supabase
        .from("books").update(row).eq("id", payload.update_book_id)
        .select("id,title,cover_url,created_at").single();
      if (updateError) throw new Error("Existing book update failed");
      return Response.json({ ok: true, updated: true, already_published: false, book: updated });
    }

    const { data: inserted, error: insertError } = await supabase
      .from("books").insert(row).select("id,title,cover_url,created_at").single();
    if (insertError) throw new Error("Book database insert failed");

    // Announce only a newly inserted book. Telegram failures must not roll back publication.
    let telegramAnnouncement: { sent: boolean; error?: string } = { sent: false };
    const telegramInternalSecret = Deno.env.get("TELEGRAM_INTERNAL_SECRET");
    if (telegramInternalSecret) {
      try {
        const escapeHtml = (value: unknown) => String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
        const compact = (value: unknown, max: number) => {
          const text = String(value ?? "").replace(/\\s+/g, " ").trim();
          return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
        };
        const description = compact(payload.description, 260);
        const details = [
          "✍️ <b>Автор:</b> " + escapeHtml(compact(payload.author ?? "BookCheef", 80)),
          "🏷 <b>Жанр:</b> " + escapeHtml(compact(payload.genre ?? "Не указан", 80)),
          payload.series ? "📚 <b>Серия:</b> " + escapeHtml(compact(payload.series, 90)) : "",
          "👤 <b>Возраст:</b> " + escapeHtml(compact(payload.age ?? "6+", 20)),
        ].filter(Boolean);
        const announcement = [
          "📚 <b>НОВАЯ КНИГА В BOOKCHEEF</b>",
          "🔥 <b>«" + escapeHtml(compact(title, 110)) + "»</b>",
          description ? escapeHtml(description) : "В BookCheef появилась новая история. Загляните и откройте её для себя!",
          details.join("\n"),
          '👇 <a href="https://kdnmgames.github.io/BookCheef/book/' + encodeURIComponent(inserted.id) + '">ОТКРЫТЬ КНИГУ В BOOKCHEEF</a>'
        ].join("\n\n");
        const telegramResponse = await fetch(
          "https://wendffewxxmnaglfksfg.supabase.co/functions/v1/telegram-bot",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-telegram-internal-secret": telegramInternalSecret,
            },
            body: JSON.stringify({
              text: announcement,
              photo_url: coverUrl,
            }),
          },
        );
        const telegramResult = await telegramResponse.json().catch(() => ({}));
        if (!telegramResponse.ok || telegramResult.ok !== true) {
          throw new Error("Telegram announcement endpoint rejected the post");
        }
        telegramAnnouncement = { sent: true };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Telegram announcement failed";
        console.error("Book was published, but Telegram announcement failed:", reason);
        telegramAnnouncement = { sent: false, error: reason.slice(0, 240) };
      }
    } else {
      console.error("Book was published, but TELEGRAM_INTERNAL_SECRET is not configured");
      telegramAnnouncement = { sent: false, error: "Telegram internal secret is not configured" };
    }

    return Response.json({
      ok: true,
      already_published: false,
      book: inserted,
      telegram_announcement: telegramAnnouncement,
    });
  } catch (error) {
    if (uploadedPaths.length) await supabase.storage.from("gallery").remove(uploadedPaths);
    const message = error instanceof Error ? error.message : "Publication failed";
    return Response.json({ error: message }, { status: 400 });
  }
});