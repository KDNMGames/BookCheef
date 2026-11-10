import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCheckpointStore } from "./book-checkpoint.mjs";
import { createBookWorkerState } from "./book-worker-state.mjs";
import { resolveBookWorkerMode } from "./book-worker-mode.mjs";
import { createProviderQuotaCoordinator } from "./provider-quota-coordinator.mjs";
import { selectDeferredTask, selectOldestDeferredTaskAcrossWorkers, shouldNotifyDeferredWait } from "./deferred-task-policy.mjs";
import { classifyOpenRouterFailure, earliestRetryAfter } from "./openrouter-failure-policy.mjs";
import { normalizeOrdinaryBookStructure } from "./ordinary-book-structure.mjs";
import { normalizeLegacyInteractivePackage } from "./legacy-interactive-book.mjs";

const ROOT = process.cwd();
const CONFIG_PATH = "book-publications/automation-config.json";
const ROTATION_PATH = "book-publications/rotation-state.json";
const INBOX = "book-publications/inbox";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CURSOR_API_KEY = process.env.CURSOR_FREE_INCLUDED === "true" ? process.env.CURSOR_API_KEY : undefined;
const GEMINI_API_KEY = process.env.GEMINI_FREE_INCLUDED === "true" ? process.env.GEMINI_API_KEY : undefined;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GROQ_API_KEY = process.env.GROQ_FREE_INCLUDED === "true" ? process.env.GROQ_API_KEY : undefined;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const TELEGRAM_REPORT_ENDPOINT = "https://wendffewxxmnaglfksfg.supabase.co/functions/v1/telegram-bot";
async function notifyBookCheefAdmins(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("Telegram report skipped: TELEGRAM_BOT_TOKEN is not configured.");
    return false;
  }
  try {
    const response = await fetch(TELEGRAM_REPORT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bookcheef-report-token": token },
      body: JSON.stringify({ action: "admin_notification", text: String(text).slice(0, 3900) }),
      signal: AbortSignal.timeout(15000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error("HTTP " + response.status + ": " + JSON.stringify(result));
    console.log("Telegram generation report delivered to " + result.delivered + "/" + result.total + " admin chats.");
    return true;
  } catch (error) {
    console.warn("Telegram report delivery failed without stopping book generation: " + error.message);
    return false;
  }
}

async function notifyProviderLimit(provider, reason, retryAfter) {
  const hasAnotherEnabledProvider =
    (OPENROUTER_API_KEY && !openRouterDisabled && provider !== "OpenRouter (бесплатные модели)") ||
    (GEMINI_API_KEY && !geminiDisabled && provider !== "Google Gemini API") ||
    (GROQ_API_KEY && !groqDisabled && provider !== "Groq API (бесплатный тариф)") ||
    (CURSOR_API_KEY && !cursorDisabled && provider !== "Cursor Agent");
  const nextStep = hasAnotherEnabledProvider
    ? "Генератор попробует другой явно разрешённый бесплатный источник."
    : "Других включённых бесплатных источников сейчас нет; генерация будет отложена, а черновик и контрольные точки сохранятся.";
  await notifyBookCheefAdmins(
    "⚠️ BookCheef: бесплатный лимит ИИ-провайдера «" + provider + "» исчерпан или временно недоступен. " +
    "Пауза до: " + retryAfter + ". " +
    "Причина: " + String(reason || "провайдер сообщил об ограничении").slice(0, 700) + ". " +
    nextStep + " Платные API не используются."
  );
}
let openRouterDisabled = false;
let cursorDisabled = process.env.CURSOR_FREE_INCLUDED !== "true";
let geminiDisabled = process.env.GEMINI_FREE_INCLUDED !== "true";
let groqDisabled = process.env.GROQ_FREE_INCLUDED !== "true" || !GROQ_API_KEY;


async function readGenerationControl() {
  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  if (!base || !key) throw new Error("Generation control cannot be checked: Supabase service credentials are missing.");
  const response = await fetch(base + "/rest/v1/bookcheef_generation_control?id=eq.true&select=enabled,updated_at,updated_by", {
    headers: { apikey: key, Authorization: "Bearer " + key },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Generation control check failed: HTTP " + response.status);
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows.length || typeof rows[0].enabled !== "boolean") {
    throw new Error("Generation control row is missing or invalid; refusing to generate.");
  }
  return rows[0];
}
async function assertGenerationEnabled() {
  const control = await readGenerationControl();
  if (!control.enabled) {
    console.log("BookCheef generation is STOPPED by Telegram admin (" + (control.updated_by || "unknown") + "). No new AI requests will be started.");
    return false;
  }
  return true;
}

const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
if (!(await assertGenerationEnabled())) { if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, 'package_path=\ncreated=false\nstopped=true\n'); process.exit(0); }
if (geminiDisabled) console.log("Gemini API is disabled unless GEMINI_FREE_INCLUDED=true confirms an included free allowance; Gemini Pro subscription alone is not treated as API credit.");
const { mode: workerMode, isolated: isolatedMode, workerType: explicitWorkerType } = resolveBookWorkerMode(process.env);
const rotation = isolatedMode ? {} : JSON.parse(await fs.readFile(ROTATION_PATH, "utf8"));
const configuredCycle = isolatedMode ? [process.env.BOOKCHEEF_WORKER_TYPE] : (config.daily_book.rotation || ["interactive", "ordinary", "ordinary"]);
const configuredPosition = isolatedMode ? 1 : (Number(rotation.cycle_position) || 1);
const scheduledWorkerType = process.env.BOOKCHEEF_WORKER_TYPE || configuredCycle[(configuredPosition - 1) % configuredCycle.length];
let oldestDeferredTask = null;
let readyDeferredTask = null;
let deferredQueueSnapshots = null;
if (!isolatedMode && !process.env.BOOKCHEEF_WORKER_TYPE) {
  const queues = {};
  for (const workerType of ["ordinary", "interactive"]) {
    try {
      queues[workerType] = JSON.parse(await fs.readFile("book-publications/workers/" + workerType + "/deferred-books.json", "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      queues[workerType] = { tasks: [] };
    }
  }
  deferredQueueSnapshots = queues;
  oldestDeferredTask = selectOldestDeferredTaskAcrossWorkers(queues);
  const now = Date.now();
  readyDeferredTask = Object.entries(queues).flatMap(([workerType, queue]) =>
    (Array.isArray(queue?.tasks) ? queue.tasks : []).map(task => ({ ...task, book_type: task?.book_type || workerType }))
  ).filter(task => {
    const retryAt = Date.parse(task.retry_after || "");
    return ["ordinary", "interactive"].includes(task.book_type) &&
      typeof task.checkpoint_path === "string" && task.checkpoint_path.length > 0 &&
      (!Number.isFinite(retryAt) || retryAt <= now);
  }).sort((a, b) => (Date.parse(a.created_at || "") || 0) - (Date.parse(b.created_at || "") || 0))[0] || null;
}
let requestedWorkerType = process.env.BOOKCHEEF_WORKER_TYPE || readyDeferredTask?.book_type || oldestDeferredTask?.book_type || scheduledWorkerType;
if (!process.env.BOOKCHEEF_WORKER_TYPE && !isolatedMode && !readyDeferredTask && oldestDeferredTask) {
  const idleWorker = ["ordinary", "interactive"].find(type =>
    !(deferredQueueSnapshots?.[type]?.tasks || []).length
  );
  if (idleWorker) {
    requestedWorkerType = idleWorker;
    console.log("The oldest saved book is waiting for a free-provider retry window. Starting one task in the idle " + idleWorker + " worker instead of stalling daily production.");
  }
}
if (!isolatedMode && !process.env.BOOKCHEEF_WORKER_TYPE && requestedWorkerType !== scheduledWorkerType) {
  const rotationIndex = configuredCycle.indexOf(requestedWorkerType);
  if (rotationIndex >= 0) {
    rotation.cycle_position = rotationIndex + 1;
    rotation.updated_at = new Date().toISOString();
    await fs.writeFile(ROTATION_PATH, JSON.stringify(rotation, null, 2) + "\n");
    console.log("Prioritizing oldest deferred " + requestedWorkerType + " book before the scheduled rotation.");
  }
}
const workerState = createBookWorkerState({ workerType: requestedWorkerType });

const quotaPolicy = config.provider_quota || {};
const sharedQuotaEnabled = process.env.BOOKCHEEF_SHARED_QUOTA_ENABLED === "true";
const providerQuota = sharedQuotaEnabled ? createProviderQuotaCoordinator({
  workerType: requestedWorkerType,
  defaultCooldownSeconds: Number(quotaPolicy.cooldown_after_rate_limit_seconds ?? 21600)
}) : null;
async function withProviderQuota(providerKey, suffix, operation) {
  if (!providerQuota) return operation();
  return providerQuota.run({
    providerKey,
    taskId: String(workerState.runId) + "-" + suffix,
    minIntervalSeconds: Number(quotaPolicy.min_interval_seconds ?? 15),
    windowSeconds: Number(quotaPolicy.window_seconds ?? 86400),
    maxRequestsPerWindow: Number(quotaPolicy.max_requests_per_window ?? 0),
    maxConcurrent: Number(quotaPolicy.max_concurrent_per_provider ?? 1),
    leaseSeconds: Number(quotaPolicy.reservation_lease_seconds ?? 1200)
  }, operation);
}

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

const pending = isolatedMode ? null : await findPendingPackage();
if (pending) {
  console.log("Found a package in the explicit pending queue; retrying it before generating another book.");
  console.log(JSON.stringify(pending));
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, "package_path=" + pending.path + "\ncreated=false\n");
  }
  await workerState.releaseLease();
  process.exit(0);
}

await workerState.acquireLease();
console.log("Using isolated " + requestedWorkerType + " worker storage at " + workerState.workerDir + ".");

const WORK_DIR = workerState.workerDir;
const WORK_PATH = workerState.checkpointPath("current");
const DEFERRED_QUEUE_PATH = path.join(workerState.workerDir, "deferred-books.json");

const COOLDOWN_PATH = path.join(workerState.workerDir, "openrouter-cooldown.json");
const CURSOR_COOLDOWN_PATH = path.join(workerState.workerDir, "cursor-cooldown.json");
const GEMINI_COOLDOWN_PATH = path.join(workerState.workerDir, "gemini-cooldown.json");
const GROQ_COOLDOWN_PATH = path.join(workerState.workerDir, "groq-cooldown.json");
// Migrate stranded legacy checkpoints to the worker type that matches their actual content.
try {
  const legacyCheckpoint = JSON.parse(await fs.readFile(WORK_PATH, "utf8"));
  if (legacyCheckpoint?.pkg?.title && legacyCheckpoint?.pkg?.book_content) {
    legacyCheckpoint.pkg = normalizeLegacyInteractivePackage(legacyCheckpoint.pkg);
    const recoveredWorkerType = legacyCheckpoint.pkg.is_interactive === true ||
      Array.isArray(legacyCheckpoint.pkg.interactive_content?.nodes)
      ? "interactive"
      : (legacyCheckpoint.book_type === "interactive" ? "interactive" : "ordinary");
    legacyCheckpoint.book_type = recoveredWorkerType;
    const stamp = Date.parse(legacyCheckpoint.updated_at || "") || Date.now();
    const targetWorker = recoveredWorkerType === requestedWorkerType
      ? workerState
      : createBookWorkerState({ workerType: recoveredWorkerType, runId: "recovery-" + stamp });
    const targetQueuePath = path.join(targetWorker.workerDir, "deferred-books.json");
    const queue = JSON.parse(await fs.readFile(targetQueuePath, "utf8").catch(error => {
      if (error.code === "ENOENT") return '{"tasks":[]}';
      throw error;
    }));
    queue.tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
    const taskId = "recovered-" + stamp + "-" + recoveredWorkerType;
    if (!queue.tasks.some(task => task.task_id === taskId)) {
      const recoveredPath = targetWorker.deferredPath(taskId);
      await targetWorker.atomicWriteJson(recoveredPath, legacyCheckpoint);
      await fs.rm(WORK_PATH, { force: true });
      queue.tasks.push({
        task_id: taskId,
        book_type: recoveredWorkerType,
        checkpoint_path: recoveredPath,
        created_at: legacyCheckpoint.updated_at || new Date(stamp).toISOString(),
        retry_after: new Date().toISOString(),
        recovered_from_legacy_checkpoint: true
      });
      queue.updated_at = new Date().toISOString();
      await fs.writeFile(targetQueuePath, JSON.stringify(queue, null, 2) + "\n");
      console.log("Recovered stranded checkpoint: " + legacyCheckpoint.pkg.title + " -> " + recoveredWorkerType + " worker.");
    } else {
      await fs.rm(WORK_PATH, { force: true });
    }
    if (recoveredWorkerType !== requestedWorkerType) {
      if (!isolatedMode) {
        const rotationIndex = configuredCycle.indexOf(recoveredWorkerType);
        if (rotationIndex >= 0) {
          rotation.cycle_position = rotationIndex + 1;
          rotation.updated_at = new Date().toISOString();
          await fs.writeFile(ROTATION_PATH, JSON.stringify(rotation, null, 2) + "\n");
        }
      }
      console.log("Checkpoint was moved to its correct worker; the next scheduled cycle will resume it.");
      await workerState.releaseLease();
      if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, "package_path=\ncreated=false\n");
      process.exit(0);
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw new Error("Legacy checkpoint recovery failed safely: " + error.message);
}

const cooldownSeconds = 21600;
try {
  const state = JSON.parse(await fs.readFile(COOLDOWN_PATH, "utf8"));
  const until = Date.parse(state.retry_after || "");
  if (Number.isFinite(until) && until > Date.now()) {
    openRouterDisabled = true;
    console.log("OpenRouter is cooling down until " + new Date(until).toISOString() + "; other AI providers remain available.");
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
try {
  const state = JSON.parse(await fs.readFile(CURSOR_COOLDOWN_PATH, "utf8"));
  const until = Date.parse(state.retry_after || "");
  if (Number.isFinite(until) && until > Date.now()) {
    cursorDisabled = true;
    console.log("Cursor Agent is cooling down until " + new Date(until).toISOString() + ".");
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
try {
  const state = JSON.parse(await fs.readFile(GEMINI_COOLDOWN_PATH, "utf8"));
  const until = Date.parse(state.retry_after || "");
  if (Number.isFinite(until) && until > Date.now()) {
    geminiDisabled = true;
    console.log("Gemini is cooling down until " + new Date(until).toISOString() + ".");
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
try {
  const state = JSON.parse(await fs.readFile(GROQ_COOLDOWN_PATH, "utf8"));
  const until = Date.parse(state.retry_after || "");
  if (Number.isFinite(until) && until > Date.now()) {
    groqDisabled = true;
    console.log("Groq is cooling down until " + new Date(until).toISOString() + ".");
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }

if (openRouterDisabled && cursorDisabled && geminiDisabled && groqDisabled) {
  console.log("All configured AI providers are in cooldown. Existing checkpoints are preserved; the next scheduled run will retry when a provider becomes available.");
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, "package_path=\ncreated=false\n");
  await workerState.releaseLease();
  process.exit(0);
}

if (!OPENROUTER_API_KEY && !CURSOR_API_KEY && !GEMINI_API_KEY && !GROQ_API_KEY) {
  throw new Error("No text AI provider credentials are configured. Add an explicitly enabled free provider key (OpenRouter, Gemini, Groq, or Cursor).");
}

async function saveGeminiCooldown(reason) {
  const retryAfter = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
  await fs.writeFile(GEMINI_COOLDOWN_PATH, JSON.stringify({
    provider: "gemini",
    detected_at: new Date().toISOString(),
    retry_after: retryAfter,
    reason: String(reason || "Gemini quota exhausted").slice(0, 700)
  }, null, 2) + "\n");
  geminiDisabled = true;
  console.warn("Gemini paused until " + retryAfter + ".");
  await notifyProviderLimit("Google Gemini API", reason, retryAfter);
}

async function saveGroqCooldown(reason) {
  const retryAfter = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
  await fs.writeFile(GROQ_COOLDOWN_PATH, JSON.stringify({
    provider: "groq",
    detected_at: new Date().toISOString(),
    retry_after: retryAfter,
    reason: String(reason || "Groq free-tier limit or temporary failure").slice(0, 700)
  }, null, 2) + "\n");
  groqDisabled = true;
  console.warn("Groq paused until " + retryAfter + ".");
  await notifyProviderLimit("Groq API (бесплатный тариф)", reason, retryAfter);
}

async function generateWithGroq(prompt, { json = false, timeout = 180000 } = {}) {
  if (!GROQ_API_KEY || groqDisabled) {
    const error = new Error(groqDisabled ? "Groq is in cooldown." : "GROQ_API_KEY is not configured.");
    error.code = groqDisabled ? "ALL_PROVIDERS_COOLDOWN" : "NO_FALLBACK_PROVIDER";
    throw error;
  }
  return await withProviderQuota("groq", "groq", async () => {
    console.log("Switching text generation to Groq free tier (" + GROQ_MODEL + ").");
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + GROQ_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: "Ты — профессиональный автор и редактор BookCheef. Следуй инструкции пользователя точно." },
          { role: "user", content: prompt }
        ],
        max_completion_tokens: 16000,
        ...(json ? { response_format: { type: "json_object" } } : {})
      }),
      signal: AbortSignal.timeout(timeout)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body.error?.message || "Groq HTTP " + response.status;
      const error = new Error(String(message).slice(0, 1000));
      error.status = response.status;
      error.retryAfterSeconds = Number(response.headers.get("retry-after")) || 0;
      if (response.status === 429 || response.status >= 500 || /rate.?limit|quota|limit reached|temporarily unavailable/i.test(message)) error.code = "RATE_LIMIT";
      throw error;
    }
    const output = body.choices?.[0]?.message?.content;
    if (typeof output !== "string" || !output.trim()) {
      const error = new Error("Groq returned an empty response.");
      error.code = "EMPTY_PROVIDER_RESPONSE";
      throw error;
    }
    return output.trim();
  });
}


async function generateWithGemini(prompt, { json = false, timeout = 180000 } = {}) {
  if (!GEMINI_API_KEY || geminiDisabled) {
    const error = new Error(geminiDisabled ? "Gemini is in cooldown." : "GEMINI_API_KEY is not configured.");
    error.code = geminiDisabled ? "ALL_PROVIDERS_COOLDOWN" : "NO_FALLBACK_PROVIDER";
    throw error;
  }
  return await withProviderQuota("gemini", "gemini", async () => {
  console.log("Switching text generation to Google Gemini (" + GEMINI_MODEL + ").");
  const generationConfig = { maxOutputTokens: 16000 };
  if (json) generationConfig.responseMimeType = "application/json";
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(GEMINI_MODEL) + ":generateContent", {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: "Ты — профессиональный автор и редактор BookCheef. Следуй инструкции пользователя точно." }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig
    }),
    signal: AbortSignal.timeout(timeout)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error?.message || "Gemini HTTP " + response.status;
    const error = new Error(message.slice(0, 1000));
    error.status = response.status;
    error.retryAfterSeconds = Number(response.headers.get("retry-after")) || 0;
    if (response.status === 429 || response.status === 503 || /quota|rate.?limit|resource exhausted|daily limit|billing/i.test(message)) {
      error.code = "RATE_LIMIT";
    }
    throw error;
  }
  const text = (body.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("\n").trim();
  if (!text) {
    const reason = body.candidates?.[0]?.finishReason || body.promptFeedback?.blockReason || "empty response";
    throw new Error("Gemini returned no text: " + reason);
  }
  return text;
  });
}

async function generateWithFallback(prompt, { json = false, timeout = 900000 } = {}) {
  if (!(await assertGenerationEnabled())) {
    const error = new Error("BookCheef generation was stopped by an administrator.");
    error.code = "GENERATION_STOPPED";
    throw error;
  }
  if (GEMINI_API_KEY && !geminiDisabled) {
    try {
      const output = await generateWithGemini(prompt, { json, timeout });
      return json ? parseModelJson(output) : output;
    } catch (error) {
      console.warn("Gemini failed; switching to the next explicitly enabled free provider: " + String(error.message || error).slice(0, 300));
      await saveGeminiCooldown(error.message || "Gemini generation failed");
    }
  }
  if (GROQ_API_KEY && !groqDisabled) {
    try {
      const output = await generateWithGroq(prompt, { json, timeout });
      return json ? parseModelJson(output) : output;
    } catch (error) {
      console.warn("Groq failed; switching to the next explicitly enabled free provider: " + String(error.message || error).slice(0, 300));
      await saveGroqCooldown(error.message || "Groq generation failed");
    }
  }
  if (CURSOR_API_KEY && !cursorDisabled) {
    try {
      const output = await runCursorAgent(prompt, { timeout });
      return json ? parseModelJson(output) : output;
    } catch (error) {
      console.warn("Cursor Agent fallback failed: " + String(error.message || error).slice(0, 300));
      throw error;
    }
  }
  const error = new Error("No other explicitly enabled free AI provider is available; paid or disabled providers will not be attempted.");
  error.code = "NO_FALLBACK_PROVIDER";
  throw error;
}

async function saveCursorCooldown(reason) {
  const retryAfter = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
  await fs.writeFile(CURSOR_COOLDOWN_PATH, JSON.stringify({
    provider: "cursor-agent",
    detected_at: new Date().toISOString(),
    retry_after: retryAfter,
    reason: String(reason || "Cursor usage limit reached").slice(0, 700)
  }, null, 2) + "\n");
  cursorDisabled = true;
  console.warn("Cursor Agent paused until " + retryAfter + ".");
  await notifyProviderLimit("Cursor Agent", reason, retryAfter);
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
  await notifyProviderLimit("OpenRouter (бесплатные модели)", reason, retryAfter);
}

async function runCursorAgent(prompt, { timeout = 600000 } = {}) {
  if (cursorDisabled) {
    const error = new Error("Cursor Agent is in cooldown.");
    error.code = "ALL_PROVIDERS_COOLDOWN";
    throw error;
  }
  if (!CURSOR_API_KEY) {
    const error = new Error("Cursor fallback is unavailable: CURSOR_API_KEY is not configured.");
    error.code = "NO_FALLBACK_PROVIDER";
    throw error;
  }
  return await withProviderQuota("cursor-agent", "cursor-agent", async () => {
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
  });
}

function parseModelJson(output) {
  const cleaned = String(output).trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Cursor Agent did not return a JSON object.");
  return JSON.parse(cleaned.slice(start, end + 1));
}
const cycle = configuredCycle;
const position = configuredPosition;
let deferredQueue = { tasks: [], updated_at: null };
try {
  deferredQueue = JSON.parse(await fs.readFile(DEFERRED_QUEUE_PATH, "utf8"));
} catch (error) { if (error.code !== "ENOENT") throw error; }
deferredQueue.tasks = Array.isArray(deferredQueue.tasks) ? deferredQueue.tasks : [];

// Rescue any checkpoint left at the legacy "current" path by earlier generator runs.
// Without this migration, a newer draft can remain stranded while an older deferred
// task is waiting, and it may never be selected by the deferred-task queue.
try {
  const legacyCheckpoint = JSON.parse(await fs.readFile(WORK_PATH, "utf8"));
  if (legacyCheckpoint?.pkg?.title && legacyCheckpoint?.pkg?.book_content) {
    const alreadyQueued = deferredQueue.tasks.some(task =>
      task?.checkpoint_path === WORK_PATH ||
      (task?.task_id && task.task_id === legacyCheckpoint.task_id)
    );
    if (!alreadyQueued) {
      const stamp = Date.parse(legacyCheckpoint.updated_at || "") || Date.now();
      const taskId = "recovered-" + stamp + "-" + requestedWorkerType;
      const recoveredPath = workerState.deferredPath(taskId);
      await fs.rename(WORK_PATH, recoveredPath);
      deferredQueue.tasks.push({
        task_id: taskId,
        book_type: legacyCheckpoint.book_type || requestedWorkerType,
        checkpoint_path: recoveredPath,
        created_at: legacyCheckpoint.updated_at || new Date(stamp).toISOString(),
        retry_after: new Date().toISOString(),
        recovered_from_legacy_checkpoint: true
      });
      deferredQueue.updated_at = new Date().toISOString();
      await fs.writeFile(DEFERRED_QUEUE_PATH, JSON.stringify(deferredQueue, null, 2) + "\n");
      console.log("Recovered an older unfinished checkpoint into the deferred queue: " + legacyCheckpoint.pkg.title);
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw new Error("Could not safely recover the legacy unfinished checkpoint: " + error.message);
}

const deferredSelection = selectDeferredTask(deferredQueue.tasks, Date.now());
if (deferredSelection.status === "wait") {
  const waitingTask = deferredSelection.task;
  const waitNow = Date.now();
  console.log("A deferred book is still waiting for its free-provider retry window: " +
    (waitingTask.task_id || "unknown") + " until " + deferredSelection.retryAfter +
    ". No new book will be started, so the queue cannot fill with unfinished drafts.");
  if (shouldNotifyDeferredWait(waitingTask, deferredSelection.retryAfter, waitNow)) {
    waitingTask.last_notified_retry_after = deferredSelection.retryAfter;
    waitingTask.last_wait_notice_at = new Date(waitNow).toISOString();
    deferredQueue.updated_at = new Date(waitNow).toISOString();
    await fs.writeFile(DEFERRED_QUEUE_PATH, JSON.stringify(deferredQueue, null, 2) + "\n");
    await notifyBookCheefAdmins("⏸ BookCheef: ранее начатая книга" +
      (waitingTask.task_id ? " (" + waitingTask.task_id + ")" : "") +
      " ждёт доступности бесплатного ИИ-провайдера. Следующая попытка после: " +
      deferredSelection.retryAfter + ". Новые книги пока не запускаются; черновик сохранён.");
  }
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, "package_path=\ncreated=false\n");
  await workerState.releaseLease();
  process.exit(0);
}
const deferredTask = deferredSelection.status === "resume" ? deferredSelection.task : null;
if (deferredTask && !deferredTask.checkpoint_path.startsWith(workerState.deferredDir + path.sep)) {
  throw new Error("Deferred task checkpoint path is outside this worker's deferred directory.");
}
const bookType = deferredTask?.book_type || cycle[(position - 1) % cycle.length];
const workPath = deferredTask?.checkpoint_path || WORK_PATH;
const { saveWork, loadWork } = createCheckpointStore({ workPath, bookType });
console.log(deferredTask
  ? "Resuming deferred " + bookType + " book task " + (deferredTask.task_id || "unknown") + "."
  : "Starting the next " + bookType + " book task; deferred tasks remain parked until their retry time.");
const authorDir = "book-publications/authors";
const authorFiles = (await fs.readdir(authorDir)).filter(x => x.endsWith(".json")).sort();
const authors = [];
for (const name of authorFiles) {
  authors.push(JSON.parse(await fs.readFile(path.join(authorDir, name), "utf8")));
}
const existingFiles = (await fs.readdir(INBOX)).filter(x => x.endsWith(".json")).sort();
const existingTitles = [...(config.daily_book.excluded_titles || [])];
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

// A verified publication earlier today must not block the next generation cycle.
 // Duplicate protection remains enforced by publication_key, the pending-publication queue,
 // the publisher's check_publication action, and verify-and-advance-book.mjs.

const systemPrompt = [
  "Ты — профессиональная редакция BookCheef. Создавай оригинальные законченные книги на русском языке.",
  "Верни только один корректный JSON-объект, без Markdown и комментариев.",
  "Не используй чужие известные миры, персонажей или узнаваемую манеру конкретного автора.",
  "Книга должна быть содержательной, с полноценным сюжетом, сценами, конфликтом и завершением; не конспектом и не синопсисом.",
  "Не используй заглушки, TODO, пустые поля и служебные комментарии.",
  "Все изображения описывай точными визуальными промптами; не вставляй URL и base64.",
  "Сначала задай визуальный паспорт по обложке: техника, линии, палитра, освещение, контраст, фактура и реализм. Используй один неизменный style anchor во всех изображениях; предпочитай окружения, архитектуру, предметы и силуэты вместо крупных планов людей. Если человек показан — естественная анатомия, одна голова, ровно две руки и две ноги, без лишних/дублированных конечностей и оторванных частей тела; избегай толпы, сложных жестов, текста, логотипов, водяных знаков и коллажей."
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
- ОБЪЁМ — ОБЯЗАТЕЛЬНОЕ ТРЕБОВАНИЕ ДЛЯ КАЖДОЙ КНИГИ И ЛЮБОГО ВОЗРАСТА: минимум 36 000 слов основного текста (ориентир не менее 3 часов чтения при темпе до 200 слов в минуту). Целевой объём — 39 000–42 000 слов. Обычная книга: ровно 12 глав, каждая с содержательным планом 150–220 слов; система допишет каждую главу отдельными последовательными фрагментами и сохранит контрольную точку после каждого фрагмента. Не пытайся уместить весь роман в один ответ. Не допускай повторов и искусственного растягивания.
- Интерактивная книга: ровно 5 узлов; каждый узел — полноценная сцена минимум 12 000 слов. Каждый из двух маршрутов scene-1 → ветка → финал должен содержать минимум 36 000 слов. Система допишет каждую сцену отдельными фрагментами и сохранит контрольную точку после каждого фрагмента. Используй граф из пяти узлов: scene-1, scene-2a, scene-2b, ending-a, ending-b. В первой сцене два выбора — к scene-2a и scene-2b. В сценах 2a и 2b предусмотрены переходы к двум различным финалам; оба финала должны быть достижимы. У двух финалов choices: []. Не менее двух действительно разных концовок. Каждому узлу соответствует ровно одна отдельная иллюстрация, всего ровно пять; chapter — точное title узла. В image_start каждого узла помести соответствующий маркер {{illustration:ТОЧНЫЙ TITLE УЗЛА:N}}. В book_content дай заголовок и короткое вступление, сам текст сцен хранится в nodes.
- В интерактивной книге choices — массив объектов {text,next}; next обязан ссылаться на существующий id.
- Вопросы reader_questions: 3–5 содержательных пар question/answer, не помещай их в book_content.
- Сноски: минимум одна для возраста 6+ и старше; слово в word должно дословно встречаться в тексте сцен/глав, текст определения соответствует возрасту.
- Для обложки и всех иллюстраций используй единый визуальный стиль. Сначала придумай visual_style_anchor — короткую фразу с материалом/техникой, палитрой, светом и характером реализма. В точности повтори эту фразу в начале каждого illustration.prompt. Никаких букв, логотипов, водяных знаков и коллажей.
- Все image prompts на английском языке, конкретные и визуальные, максимум 1800 символов.
- Не создавай серию, если история не нуждается в продолжении. Не повторяй недавние сюжеты и темы.

Верни полный JSON. Не добавляй publication_key — он будет назначен системой.`;

async function generatePackage(attempt, previousError = "") {
  const providerConfig = config.daily_book.text_provider || {};
  const modelCandidates = [providerConfig.model, ...(providerConfig.fallback_models || [])]
    .filter(Boolean)
    .filter(candidate => candidate === "openrouter/free" || candidate.endsWith(":free"));
  if (!modelCandidates.length) {
    throw new Error("Free-only policy blocked generation: no explicitly free OpenRouter models are configured.");
  }
  const modelIndex = (attempt - 1) % modelCandidates.length;
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
    return await generateWithFallback(systemPrompt + "\n\n" + userPrompt + retryInstruction +
      "\n\nОБЯЗАТЕЛЬНО: верни только один полный JSON-объект без Markdown и пояснений.", { json: true, timeout: 900000 });
  }
  try {
    return await withProviderQuota("openrouter", "openrouter", async () => {
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
      failure.status = response.status;
      failure.retryAfterSeconds = Number(response.headers.get("retry-after")) || 0;
      const failureCode = classifyOpenRouterFailure({ status: response.status, message, providerName: provider });
      if (failureCode) failure.code = failureCode;
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
      const upstreamProvider = body.provider || body.provider_name || body.choices?.[0]?.provider || "";
      const failure = new Error(("OpenRouter returned empty content" + detail +
        (upstreamProvider ? " (provider: " + upstreamProvider + ")" : "") +
        (providerError ? ": " + providerError : ".")).slice(0, 700));
      // An HTTP 200 with no message is an upstream model failure, not a book-content
      // validation error. Rotate to the next configured free model instead of retrying
      // the same model until the whole book is deferred.
      failure.code = "MODEL_PROVIDER_LIMIT";
      throw failure;
    }
    const cleaned = content.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
    return JSON.parse(cleaned);
    });
  } catch (error) {
    if (error.code === "MODEL_PROVIDER_LIMIT") {
      if (attempt < maxAttempts) {
        console.warn("OpenRouter upstream provider failed for " + model + "; the next attempt will use another free model.");
        throw error;
      }
      await saveOpenRouterCooldown(error.message);
      return await generateWithFallback(systemPrompt + "\n\n" + userPrompt + retryInstruction +
        "\n\nОБЯЗАТЕЛЬНО: верни только один полный JSON-объект без Markdown и пояснений.", { json: true, timeout: 900000 });
    }
    if (error.code === "PROVIDER_QUOTA_WAIT") {
      openRouterDisabled = true;
      console.warn("OpenRouter is temporarily unavailable under the shared quota policy; trying another provider.");
      return await generateWithFallback(systemPrompt + "\n\n" + userPrompt + retryInstruction +
        "\n\nОБЯЗАТЕЛЬНО: верни только один полный JSON-объект без Markdown и пояснений.", { json: true, timeout: 900000 });
    }
    if (error.code === "RATE_LIMIT" || /rate.?limit|quota|daily limit|credits exhausted/i.test(error.message || "")) {
      await saveOpenRouterCooldown(error.message);
      return await generateWithFallback(systemPrompt + "\n\n" + userPrompt + retryInstruction +
        "\n\nОБЯЗАТЕЛЬНО: верни только один полный JSON-объект без Markdown и пояснений.", { json: true, timeout: 900000 });
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
  const hasInteractiveStructure = Array.isArray(pkg.interactive_content?.nodes);
  if (bookType === "ordinary" && hasInteractiveStructure) {
    throw new Error("Book type mismatch: ordinary task contains interactive scene nodes; move it to the interactive worker before repair.");
  }
  if (bookType === "interactive" && !hasInteractiveStructure) {
    throw new Error("Book type mismatch: interactive task has no interactive scene nodes.");
  }
  // Repair stale boolean metadata when the actual package structure matches its worker.
  pkg.is_interactive = bookType === "interactive";
  if (pkg.series == null) pkg.series = "";
  if (bookType === "ordinary") normalizeOrdinaryBookStructure(pkg);
  return pkg;
}


function countWords(value) {
  return (String(value || "").match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu) || []).length;
}

async function expandPart({ title, age, genre, bookTitle, description, author, draft, priorContext, targetWords, minimumWords, partLabel, partIndex }) {
  const provider = config.daily_book.text_provider || {};
  const models = [provider.model, ...(provider.fallback_models || [])]
    .filter(Boolean)
    .filter(candidate => candidate === "openrouter/free" || candidate.endsWith(":free"));
  if (!models.length) throw new Error("Free-only policy blocked chapter expansion: no explicitly free OpenRouter models are configured.");
  let lastError;
  for (let retry = 0; retry < models.length; retry++) {
    const model = models[(partIndex + retry) % Math.max(1, models.length)] || "openrouter/free";
    try {
      const systemText = "Ты — профессиональный автор BookCheef. Пиши только художественный текст на русском языке, без JSON, Markdown-заголовков и комментариев. Не пересказывай события — показывай их сценами. Не повторяй уже изложенное.";
      const userText =
        "Напиши СЛЕДУЮЩИЙ ФРАГМЕНТ большой книги «" + bookTitle + "» (" + age + ", жанр: " + genre + ", авторский голос: " + author + "). " +
        "Раздел: «" + title + "». " + partLabel + ". Целевой объём — не менее " + targetWords + " слов. " +
        "Описание книги: " + description + "\nКонтекст уже написанного (это канон; не повторяй его): " + (priorContext || "Это начало истории.") +
        "\nПлан и обязательные события раздела: " + draft +
        "\nТребования: цельная художественная проза; полноценные сцены, диалоги, причинно-следственные связи, атмосфера и эмоциональное развитие. " +
        "Если это первый фрагмент — начни раздел естественно; если это продолжение — продолжай с места остановки, не пересказывай и не повторяй предыдущие сцены. " +
        "Соблюдай план, характеры, факты и хронологию; не добавляй несогласованные сюжетные линии. " +
        "Выведи только художественный текст этого фрагмента, без заголовка, пояснений и заключения всей книги. Объём должен быть не менее " + targetWords + " слов.";
      let generatedText;
      if (openRouterDisabled || !OPENROUTER_API_KEY) {
        generatedText = await generateWithFallback(systemText + "\n\n" + userText, { timeout: 900000 });
      } else {
        const response = await withProviderQuota("openrouter", "expand-" + partIndex + "-" + retry, async () =>
          await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
          })
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = body.error?.message || body.error?.metadata?.raw || "OpenRouter HTTP " + response.status;
          const providerName = body.error?.metadata?.provider_name || body.error?.provider || "";
          const failure = new Error((message + (providerName ? " (provider: " + providerName + ")" : "")).slice(0, 700));
          failure.status = response.status;
          failure.retryAfterSeconds = Number(response.headers.get("retry-after")) || 0;
          const failureCode = classifyOpenRouterFailure({ status: response.status, message, providerName });
          if (failureCode) failure.code = failureCode;
          throw failure;
        }
        const raw = body.choices?.[0]?.message?.content;
        generatedText = (typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(x => x?.text || "").join("\n") : "")
          .trim().replace(/^\x60{3}[^\n]*\n?/,"").replace(/\n?\x60{3}$/,"").trim();
        if (!generatedText) {
          const choice = body.choices?.[0];
          const detail = choice?.finish_reason ? " (finish_reason: " + choice.finish_reason + ")" : "";
          const providerName = body.provider || body.provider_name || choice?.provider || "";
          const failure = new Error(("OpenRouter returned an empty chapter fragment" + detail +
            (providerName ? " (provider: " + providerName + ")" : "")).slice(0, 700));
          // Treat HTTP 200 empty fragments like upstream model failures so the
          // worker rotates through free models and then enabled free providers.
          failure.code = "MODEL_PROVIDER_LIMIT";
          throw failure;
        }
      }
      const words = countWords(generatedText);
      if (words < (Number(minimumWords) || Math.floor(targetWords * 0.78))) throw new Error("Part too short: " + words + " words; minimum " + (Number(minimumWords) || Math.floor(targetWords * 0.78)) + ".");
      return generatedText;
    } catch (error) {
      lastError = error;
      if (error.code === "MODEL_PROVIDER_LIMIT") {
        if (retry < models.length - 1) {
          console.warn("Upstream provider failed for " + model + "; trying the next free OpenRouter model.");
          await new Promise(resolve => setTimeout(resolve, Math.max(15, Number(quotaPolicy.min_interval_seconds ?? 15)) * 1000));
          continue;
        }
        await saveOpenRouterCooldown(error.message);
        try {
          const systemText = "Ты — профессиональный автор BookCheef. Пиши только художественный текст на русском языке, без JSON, Markdown-заголовков и комментариев. Не пересказывай события — показывай их сценами. Не повторяй уже изложенное.";
          const userText = "Напиши ПОЛНОЦЕННУЮ расширенную часть книги «" + bookTitle + "» (" + age + ", жанр: " + genre + ", авторский голос: " + author + "). Раздел: «" + title + "». " + partLabel + ". Целевой объём — не менее " + targetWords + " слов. Описание: " + description + "\nКонтекст: " + (priorContext || "Начало истории.") + "\nЧерновик: " + draft + "\nСохрани события, напиши полноценную прозу, выведи только текст части.";
          const fallbackText = await generateWithFallback(systemText + "\n\n" + userText, { timeout: 900000 });
          const fallbackWords = countWords(fallbackText);
          if (fallbackWords < (Number(minimumWords) || Math.floor(targetWords * 0.78))) throw new Error("Free-provider fallback part too short: " + fallbackWords + " words.");
          return fallbackText;
        } catch (fallbackError) {
          lastError = fallbackError;
          console.warn("Free-provider fallback also failed: " + fallbackError.message);
          throw fallbackError;
        }
      }
      if (error.code === "PROVIDER_QUOTA_WAIT") throw error;
      if ((error.code === "RATE_LIMIT" || /rate.?limit|quota|daily limit|credits exhausted/i.test(error.message || "")) && !openRouterDisabled && OPENROUTER_API_KEY) {
        await saveOpenRouterCooldown(error.message);
        try {
          const systemText = "Ты — профессиональный автор BookCheef. Пиши только художественный текст на русском языке, без JSON, Markdown-заголовков и комментариев. Не пересказывай события — показывай их сценами. Не повторяй уже изложенное.";
          const userText = "Напиши ПОЛНОЦЕННУЮ расширенную часть книги «" + bookTitle + "» (" + age + ", жанр: " + genre + ", авторский голос: " + author + "). Раздел: «" + title + "». " + partLabel + ". Целевой объём — не менее " + targetWords + " слов. Описание: " + description + "\nКонтекст: " + (priorContext || "Начало истории.") + "\nЧерновик: " + draft + "\nСохрани события, напиши полноценную прозу, выведи только текст части.";
          const fallbackText = await generateWithFallback(systemText + "\n\n" + userText, { timeout: 900000 });
          const fallbackWords = countWords(fallbackText);
          if (fallbackWords < (Number(minimumWords) || Math.floor(targetWords * 0.78))) throw new Error("Cursor fallback part too short: " + fallbackWords + " words.");
          return fallbackText;
        } catch (fallbackError) {
          lastError = fallbackError;
          console.warn("Cursor fallback also failed: " + fallbackError.message);
          throw fallbackError;
        }
      }
      if (error.code === "RATE_LIMIT" || error.code === "ALL_PROVIDERS_COOLDOWN") throw error;
      console.warn("Long-form expansion retry " + (retry + 1) + " for " + title + ": " + error.message);
    }
  }
  if ((GEMINI_API_KEY && !geminiDisabled) || (CURSOR_API_KEY && !cursorDisabled)) {
    try {
      console.warn("All configured OpenRouter free models failed for " + title + "; handing this exact fragment to the next enabled free provider.");
      const fallbackText = await generateWithFallback(
        "Ты — профессиональный автор BookCheef. Продолжи книгу без повторов.\\n\\n" +
        "Напиши фрагмент раздела «" + title + "» объёмом не менее " + targetWords + " слов. " +
        "План: " + draft + "\\nКонтекст уже написанного: " + (priorContext || "Начало истории.") +
        "\\nОписание: " + description + ". Авторский голос: " + author + ". " + partLabel +
        ". Соблюдай сюжетную непрерывность. Выведи только художественный текст.",
        { timeout: 900000 }
      );
      if (countWords(fallbackText) < minimumWords) throw new Error("Fallback fragment too short: " + countWords(fallbackText) + " words.");
      return fallbackText;
    } catch (fallbackError) {
      lastError = new Error((lastError?.message || "OpenRouter free models failed") + "; secondary provider failed: " + fallbackError.message);
    }
  }
  throw new Error("Could not expand " + title + ": " + (lastError?.message || "unknown error"));
}

async function expandOrdinaryBook(pkg) {
  if (bookType !== "ordinary") return pkg;
  normalizeOrdinaryBookStructure(pkg);
  const matches = [...pkg.book_content.matchAll(/^##\\s+(.+)$/gm)];
  const age = String(pkg.age || "12+");
  if (matches.length < 10 || matches.length > 14) throw new Error("A three-hour ordinary book requires 10-14 chapters; received " + matches.length + ".");
  const targetWordsPerFragment = 1150, minimumWordsPerFragment = 900, totalMinimum = 36000;
  // Preserve older saved outlines (10-14 chapters) while guaranteeing >=36,000 words.
  const fragmentsPerChapter = Math.max(3, Math.ceil(totalMinimum / (matches.length * minimumWordsPerFragment)));
  const progress = pkg.generation_progress ||= { version: 2, ordinary: { chapters: {} } };
  progress.ordinary ||= { chapters: {} }; progress.ordinary.chapters ||= {};
  const completedParts = [];
  let previous = "";
  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : pkg.book_content.length;
    const raw = pkg.book_content.slice(start, end).trim();
    const markerPattern = /\\{\\{illustration:[^}]+\\}\\}/g;
    const markers = [...raw.matchAll(markerPattern)].map(x => x[0]);
    const outline = raw.replace(markerPattern, "").trim();
    const state = progress.ordinary.chapters[heading] ||= { outline, fragments: [] };
    if (!state.outline) state.outline = outline;
    if (!Array.isArray(state.fragments)) state.fragments = [];
    const illustration = pkg.illustrations.find(x => x.chapter === heading);
    const markerList = [...new Set([...markers, ...(illustration ? ["{{illustration:" + heading + ":" + illustration.number + "}}"] : [])])];
    for (let fragment = state.fragments.length; fragment < fragmentsPerChapter; fragment++) {
      console.log("Writing chapter " + (i + 1) + "/12, fragment " + (fragment + 1) + "/3 for " + heading + ".");
      const textPart = await expandPart({
        title: heading, age, genre: pkg.genre, bookTitle: pkg.title, description: pkg.description, author: pkg.author,
        draft: state.outline,
        priorContext: (previous.slice(-1800) + "\\n" + state.fragments.join("\\n\\n").slice(-2200)).slice(-3800),
        targetWords: targetWordsPerFragment, minimumWords: minimumWordsPerFragment,
        partLabel: "Глава " + (i + 1) + " из " + matches.length + ", фрагмент " + (fragment + 1) + " из " + fragmentsPerChapter + (fragment === 0 ? " — начало главы" : " — непрерывное продолжение предыдущего фрагмента"),
        partIndex: i * fragmentsPerChapter + fragment
      });
      state.fragments.push(textPart);
      const chapterText = "## " + heading + "\\n\\n" + (markerList.length ? markerList.join("\\n") + "\\n\\n" : "") + state.fragments.join("\\n\\n");
      const remainingOutlines = i + 1 < matches.length ? pkg.book_content.slice(matches[i + 1].index) : "";
      await saveWork({ ...pkg, book_content: [...completedParts, chapterText, remainingOutlines].filter(Boolean).join("\\n\\n") });
      console.log("Checkpoint saved after fragment " + (fragment + 1) + "/" + fragmentsPerChapter + " of chapter " + (i + 1) + ".");
    }
    const chapterText = "## " + heading + "\\n\\n" + (markerList.length ? markerList.join("\\n") + "\\n\\n" : "") + state.fragments.join("\\n\\n");
    const chapterWords = countWords(state.fragments.join(" "));
    if (chapterWords < 2700) throw new Error("Chapter " + heading + " is below its " + (fragmentsPerChapter * minimumWordsPerFragment) + "-word minimum (" + chapterWords + ").");
    completedParts.push(chapterText); previous = state.fragments.join("\\n\\n");
    const remainingOutlines = i + 1 < matches.length ? pkg.book_content.slice(matches[i + 1].index) : "";
    await saveWork({ ...pkg, book_content: [...completedParts, remainingOutlines].filter(Boolean).join("\\n\\n") });
  }
  pkg.book_content = completedParts.join("\\n\\n");
  const total = countWords(pkg.book_content);
  if (total < totalMinimum) throw new Error("Three-hour book length check failed: " + total + " words; minimum " + totalMinimum + ".");
  delete pkg.generation_progress; await saveWork(pkg);
  console.log("Three-hour ordinary book completed: " + total + " words across " + matches.length + " chapters.");
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
  const age = String(pkg.age || "12+"), nodes = pkg.interactive_content?.nodes;
  if (!Array.isArray(nodes) || nodes.length !== 5) throw new Error("Interactive three-hour book requires exactly five story nodes.");
  const fragmentsPerNode = 12, targetWordsPerFragment = 1250, minimumWordsPerFragment = 1000, minimumWordsPerRoute = 36000;
  const progress = pkg.generation_progress ||= { version: 2, interactive: { nodes: {} } };
  progress.interactive ||= { nodes: {} }; progress.interactive.nodes ||= {};
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i], state = progress.interactive.nodes[node.id] ||= { outline: String(node.text || ""), fragments: [] };
    if (!state.outline) state.outline = String(node.text || "");
    if (!Array.isArray(state.fragments)) state.fragments = [];
    for (let fragment = state.fragments.length; fragment < fragmentsPerNode; fragment++) {
      console.log("Writing interactive node " + node.id + ", fragment " + (fragment + 1) + "/10.");
      const textPart = await expandPart({
        title: node.title, age, genre: pkg.genre, bookTitle: pkg.title, description: pkg.description, author: pkg.author,
        draft: state.outline,
        priorContext: (interactiveContext(nodes, node.id) + "\\n" + state.fragments.join("\\n\\n")).slice(-4200),
        targetWords: targetWordsPerFragment, minimumWords: minimumWordsPerFragment,
        partLabel: "Сцена " + (i + 1) + " из 5, фрагмент " + (fragment + 1) + " из 10" + (fragment === 0 ? " — начало сцены" : " — непрерывное продолжение предыдущего фрагмента"),
        partIndex: i * fragmentsPerNode + fragment
      });
      state.fragments.push(textPart); node.text = state.fragments.join("\\n\\n");
      await saveWork(pkg);
      console.log("Interactive checkpoint saved: " + node.id + " fragment " + (fragment + 1) + "/10.");
    }
    node.text = state.fragments.join("\\n\\n");
    if (countWords(node.text) < 12000) throw new Error("Interactive node " + node.id + " is below its 12,000-word minimum.");
    await saveWork(pkg);
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const routeA = countWords(byId.get("scene-1").text) + countWords(byId.get("scene-2a").text) + countWords(byId.get("ending-a").text);
  const routeB = countWords(byId.get("scene-1").text) + countWords(byId.get("scene-2b").text) + countWords(byId.get("ending-b").text);
  if (routeA < minimumWordsPerRoute || routeB < minimumWordsPerRoute) throw new Error("Interactive three-hour route check failed: " + routeA + " / " + routeB + " words; each route requires 36,000.");
  delete pkg.generation_progress; await saveWork(pkg);
  console.log("Three-hour interactive routes completed: " + routeA + " and " + routeB + " words.");
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
  const qualityGuard = "Clear uncluttered composition; prefer environments, architecture, objects and silhouettes over close-up people. If a human appears: natural anatomy, one head, exactly two arms and two legs; no extra or duplicated limbs, detached body parts or malformed hands. No unintended people or objects, text, logos, watermarks or collage.";
  const normalizeVisualPrompt = (value) => {
    let body = String(value ?? "").replace(anchor, "").trim();
    if (body.endsWith(qualityGuard)) body = body.slice(0, -qualityGuard.length).trim();
    const maxBody = 1800 - anchor.length - qualityGuard.length - 2;
    if (maxBody < 80) throw new Error("Visual style anchor is too long.");
    if (body.length > maxBody) {
      body = body.slice(0, maxBody);
      const boundary = body.lastIndexOf(" ");
      if (boundary > 80) body = body.slice(0, boundary);
      body = body.trim();
    }
    return [anchor, body, qualityGuard].filter(Boolean).join(" ");
  };
  pkg.cover.prompt = normalizeVisualPrompt(pkg.cover.prompt);
  for (let i=0;i<pkg.illustrations.length;i++) {
    const item=pkg.illustrations[i];
    item.number=i+1;
    if (!item.chapter?.trim() || !item.prompt?.trim()) throw new Error("Illustration " + (i+1) + " is incomplete.");
    item.prompt = normalizeVisualPrompt(item.prompt);
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
    const ordinaryWords=countWords(pkg.book_content); const minimum=30000; if(ordinaryWords<minimum) throw new Error("Ordinary book is too short for a three-hour reading session ("+ordinaryWords+" words; minimum "+minimum+").");
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
      const ageMinimum=12000; if (!node.title?.trim() || typeof node.text!=="string" || countWords(node.text)<ageMinimum || !Array.isArray(node.choices)) throw new Error("Interactive scene is incomplete or below the 12,000-word minimum: "+node.id);
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
let currentBookTitle = pkg?.title || "";
let startReportSent = false;
if (currentBookTitle) {
  await notifyBookCheefAdmins("🛠 BookCheef: сейчас создаётся книга «" + currentBookTitle + "» (" + bookType + ").");
  startReportSent = true;
}
if (!pkg && !isolatedMode) {
  const legacyCheckpointPath = "book-publications/work-in-progress/current.json";
  try {
    const legacyState = JSON.parse(await fs.readFile(legacyCheckpointPath, "utf8"));
    if (legacyState.version === 1 && legacyState.book_type === bookType &&
        legacyState.pkg?.title && legacyState.pkg?.book_content) {
      await saveWork(legacyState.pkg);
      pkg = legacyState.pkg;
      console.log("Migrated the matching legacy checkpoint into the isolated " + bookType + " worker store; the original file was preserved.");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
if (pkg && !startReportSent) {
  currentBookTitle = pkg.title || currentBookTitle;
  await notifyBookCheefAdmins("🛠 BookCheef: сейчас создаётся книга «" + (currentBookTitle || "без названия") + "» (" + bookType + ").");
  startReportSent = true;
}
// Repair stale type flags in saved checkpoints when the actual structure is unambiguous.
if (pkg && bookType === "ordinary" && !Array.isArray(pkg.interactive_content?.nodes) && pkg.is_interactive === true) {
  pkg.is_interactive = false;
  await saveWork(pkg);
  console.log("Automatically repaired stale is_interactive=true metadata on an ordinary draft.");
} else if (pkg && bookType === "interactive" && Array.isArray(pkg.interactive_content?.nodes) && pkg.is_interactive !== true) {
  pkg.is_interactive = true;
  await saveWork(pkg);
  console.log("Automatically repaired stale is_interactive metadata on an interactive draft.");
}
const maxAttempts = Math.max(1, Number(config.daily_book.text_provider?.max_attempts) || 8);
if (pkg) {
  try {
    pkg = validate(await expandBook(pkg));
  } catch (error) {
    lastError = error;
    pkg = null;
    console.error("Resumed book expansion stopped: " + error.message);
    if (error.code === "RATE_LIMIT" || error.code === "ALL_PROVIDERS_COOLDOWN" || error.code === "PROVIDER_QUOTA_WAIT" ||
        (error.code !== "MODEL_PROVIDER_LIMIT" && /rate.?limit|quota|daily limit|usage limit|billing limit|out of credits|fetch failed|network|timed? ?out|ECONNRESET|ETIMEDOUT|502|503|504|gateway/i.test(error.message || ""))) {
      if (error.code !== "PROVIDER_QUOTA_WAIT") {
        if (openRouterDisabled || !OPENROUTER_API_KEY) {
          if (GEMINI_API_KEY && !geminiDisabled) await saveGeminiCooldown(error.message);
          else if (CURSOR_API_KEY && !cursorDisabled) await saveCursorCooldown(error.message);
        } else await saveOpenRouterCooldown(error.message);
      }
    } else if (error.code === "GENERATION_STOPPED") {
      console.log("Administrator stopped generation while resuming; the checkpoint will be preserved.");
    } else {
      console.error("Resumed book did not pass expansion/validation. Keeping the saved checkpoint and deferring it for another safe attempt: " + error.message);
    }
  }
}
if (!pkg) {
for (let attempt=1; attempt<=maxAttempts; attempt++) {
  try { const candidate=await generatePackage(attempt,lastError?.message||""); console.log("Model output fields:",Object.keys(candidate||{}).join(", ")); const normalized=normalizePackage(candidate); currentBookTitle=normalized.title || currentBookTitle; if (!startReportSent) { await notifyBookCheefAdmins("🛠 BookCheef: сейчас создаётся книга «" + currentBookTitle + "» (" + bookType + ")."); startReportSent=true; } await saveWork(normalized); pkg=validate(await expandBook(normalized)); break; }
  catch(error) {
    lastError=error;
    console.error("Generation/validation attempt "+attempt+" failed: "+error.message);
    if (error.code === "GENERATION_STOPPED") {
      console.log("Administrator stopped generation. Preserving the current checkpoint and deferred task.");
      break;
    }
    if (error.code === "RATE_LIMIT" || error.code === "ALL_PROVIDERS_COOLDOWN" || error.code === "PROVIDER_QUOTA_WAIT" ||
        (error.code !== "MODEL_PROVIDER_LIMIT" && /rate.?limit|quota|daily limit|usage limit|billing limit|out of credits|fetch failed|network|timed? ?out|ECONNRESET|ETIMEDOUT|502|503|504|gateway/i.test(error.message || ""))) {
      if (error.code !== "PROVIDER_QUOTA_WAIT") {
        if (openRouterDisabled || !OPENROUTER_API_KEY) {
          if (GEMINI_API_KEY && !geminiDisabled) await saveGeminiCooldown(error.message);
          else if (CURSOR_API_KEY && !cursorDisabled) await saveCursorCooldown(error.message);
        } else await saveOpenRouterCooldown(error.message);
      }
      if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, "package_path=\ncreated=false\n");
      console.error("No available AI provider for this attempt. The partial checkpoint, if any, is preserved for the next run.");
      break;
    }
    if (attempt<maxAttempts) await new Promise(resolve=>setTimeout(resolve, Math.max(1,Number(config.daily_book.text_provider?.retry_delay_seconds)||30)*1000));
  }
}
}
if (!pkg && lastError?.code === "GENERATION_STOPPED") {
  if (deferredTask) {
    deferredQueue.updated_at = new Date().toISOString();
    await fs.writeFile(DEFERRED_QUEUE_PATH, JSON.stringify(deferredQueue, null, 2) + "\n");
  }
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, "package_path=\ncreated=false\nstopped=true\n");
  await workerState.releaseLease();
  process.exit(0);
}
if (!pkg && lastError && lastError?.code !== "GENERATION_STOPPED") {
  const retryAfter = [COOLDOWN_PATH, CURSOR_COOLDOWN_PATH, GEMINI_COOLDOWN_PATH, GROQ_COOLDOWN_PATH]
    .map(async file => { try { return Date.parse(JSON.parse(await fs.readFile(file, "utf8")).retry_after || ""); } catch { return 0; } });
  const cooldowns = await Promise.all(retryAfter);
  const sharedRetry = lastError?.retryAfter || "";
  const nextRetry = earliestRetryAfter({
    now: Date.now(),
    retryAfterValues: [sharedRetry, ...cooldowns],
    fallbackDelayMs: 15 * 60 * 1000
  });
  let deferredEntry = deferredTask;
  if (!deferredEntry) {
    const taskId = "book-" + Date.now() + "-" + bookType;
    const deferredPath = workerState.deferredPath(taskId);
    try { await fs.rename(workPath, deferredPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    deferredEntry = { task_id: taskId, book_type: bookType, checkpoint_path: deferredPath, created_at: new Date().toISOString() };
    deferredQueue.tasks.push(deferredEntry);
    console.log("Deferred the current task in its isolated worker store. Global publication rotation is left untouched until a book is verified as published.");
  }
  deferredEntry.retry_after = nextRetry;
  deferredEntry.last_error = String(lastError?.message || "Free provider quota unavailable").slice(0, 500);
  deferredQueue.updated_at = new Date().toISOString();
  await fs.writeFile(DEFERRED_QUEUE_PATH, JSON.stringify(deferredQueue, null, 2) + "\n");
  console.log("Book task safely deferred until " + nextRetry + "; the next scheduled run will resume this same book when a free provider is available.");
  await notifyBookCheefAdmins("⏸ BookCheef: создание книги" + (currentBookTitle ? " «" + currentBookTitle + "»" : "") + " временно отложено. Причина: " + String(lastError?.message || "ошибка генерации или проверки").slice(0, 900) + ". Контрольная точка и метаданные сохранены; задача не удалена. Следующая попытка после: " + nextRetry + ". Будут использоваться только разрешённые бесплатные модели; платные API не используются.");
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, "package_path=\ncreated=false\ndeferred=true\nretry_after=" + nextRetry + "\n");
  await workerState.releaseLease();
  process.exit(0);
}
if (!pkg) {
  const failureMessage = String(lastError?.message || "unknown error").slice(0, 900);
  const failedTitle = currentBookTitle || deferredTask?.task_id || "без названия";
  const cleanupPaths = new Set([workPath]);
  if (deferredTask?.checkpoint_path) cleanupPaths.add(deferredTask.checkpoint_path);
  for (const filePath of cleanupPaths) {
    const resolved = path.resolve(filePath);
    const allowedRoots = [path.resolve(workerState.checkpointDir), path.resolve(workerState.deferredDir)];
    if (!allowedRoots.some(root => resolved.startsWith(root + path.sep))) {
      throw new Error("Refusing to delete a failed draft outside this worker's checkpoint folders: " + filePath);
    }
    await fs.rm(resolved, { force: true });
  }
  if (deferredTask?.task_id) {
    deferredQueue.tasks = deferredQueue.tasks.filter(task => task?.task_id !== deferredTask.task_id);
    deferredQueue.updated_at = new Date().toISOString();
    await fs.writeFile(DEFERRED_QUEUE_PATH, JSON.stringify(deferredQueue, null, 2) + "\n");

    // Remove duplicate queue references and their checkpoint files, but only for this exact task id.
    for (const otherType of ["ordinary", "interactive"]) {
      if (otherType === requestedWorkerType) continue;
      const otherQueuePath = path.join("book-publications/workers", otherType, "deferred-books.json");
      let otherQueue;
      try { otherQueue = JSON.parse(await fs.readFile(otherQueuePath, "utf8")); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const duplicates = (Array.isArray(otherQueue.tasks) ? otherQueue.tasks : [])
        .filter(task => task?.task_id === deferredTask.task_id);
      if (!duplicates.length) continue;
      otherQueue.tasks = otherQueue.tasks.filter(task => task?.task_id !== deferredTask.task_id);
      otherQueue.updated_at = new Date().toISOString();
      await fs.writeFile(otherQueuePath, JSON.stringify(otherQueue, null, 2) + "\n");
      const otherDeferredRoot = path.resolve("book-publications/workers", otherType, "deferred");
      for (const duplicate of duplicates) {
        if (typeof duplicate.checkpoint_path !== "string") continue;
        const duplicatePath = path.resolve(duplicate.checkpoint_path);
        if (duplicatePath.startsWith(otherDeferredRoot + path.sep)) {
          await fs.rm(duplicatePath, { force: true });
        }
      }
    }
  }
  // Clear a matching legacy checkpoint left by older generator versions.
  const legacyWorkPath = path.resolve("book-publications/work-in-progress/current.json");
  try {
    const legacy = JSON.parse(await fs.readFile(legacyWorkPath, "utf8"));
    const sameTitle = String(legacy?.pkg?.title || "").normalize("NFKC").trim().toLocaleLowerCase("ru") ===
      String(currentBookTitle || "").normalize("NFKC").trim().toLocaleLowerCase("ru");
    if (sameTitle && currentBookTitle) await fs.rm(legacyWorkPath, { force: true });
  } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  await notifyBookCheefAdmins(
    "🗑 BookCheef: черновик «" + failedTitle + "» удалён после " + maxAttempts +
    " неудачных попыток автоматического исправления. Удалены его контрольные файлы и запись из очереди. " +
    "Причина: " + failureMessage + ". Опубликованные книги и пользовательские данные не затрагивались."
  );
  console.error("Discarded unrecoverable unpublished draft after exhausting repair attempts: " + failureMessage);
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, "package_path=\ncreated=false\ndiscarded=true\n");
  await workerState.releaseLease();
  process.exit(0);
}

const outboxDir=path.join(workerState.workerDir,"outbox");
await fs.mkdir(outboxDir,{recursive:true});
const fileName=today+"-"+slugify(pkg.title)+"-"+requestedWorkerType+".json";
const filePath=path.join(outboxDir,fileName);
await fs.writeFile(filePath,JSON.stringify(pkg,null,2)+"\n",{flag:"wx"});
await fs.rm(workPath, { force: true });
await workerState.atomicWriteJson(workerState.queuePath, {
  worker_type: requestedWorkerType,
  updated_at: new Date().toISOString(),
  last_completed: { title: pkg.title, publication_key: pkg.publication_key, package_path: filePath, status: "awaiting_coordination" }
});
if (deferredTask) {
  deferredQueue.tasks = deferredQueue.tasks.filter(task => task.task_id !== deferredTask.task_id);
  deferredQueue.updated_at = new Date().toISOString();
  await fs.writeFile(DEFERRED_QUEUE_PATH, JSON.stringify(deferredQueue, null, 2) + "\n");
}
await workerState.releaseLease();
console.log("Created "+filePath+" ("+pkg.title+") and added it to the worker outbox.");
console.log("Type: "+bookType+"; rotation position remains unchanged until verified publication.");
if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(process.env.GITHUB_OUTPUT,"package_path="+filePath+"\ncreated=true\n");
}
