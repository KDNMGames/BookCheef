const DEFAULTS = {
  minIntervalSeconds: 15,
  windowSeconds: 86400,
  maxRequestsPerWindow: 0,
  maxConcurrent: 1,
  leaseSeconds: 1200
};

function assertInteger(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(name + " must be an integer from " + min + " to " + max + ".");
  }
}

function normalizeRow(value) {
  if (Array.isArray(value)) return value[0] || {};
  return value || {};
}

export class ProviderQuotaWaitError extends Error {
  constructor(result) {
    const retry = result.retry_after ? new Date(result.retry_after).toISOString() : "later";
    super("Provider quota is reserved or cooling down until " + retry + " (" + (result.reason || "shared quota policy") + ").");
    this.name = "ProviderQuotaWaitError";
    this.code = "PROVIDER_QUOTA_WAIT";
    this.retryAfter = result.retry_after || null;
    this.provider = result.provider_key || null;
    this.reason = result.reason || "shared_quota_policy";
  }
}

export function createProviderQuotaCoordinator({
  supabaseUrl = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  workerType = process.env.BOOKCHEEF_WORKER_TYPE || "ordinary",
  defaultCooldownSeconds = 21600,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Shared provider quota is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY (or the legacy SUPABASE_SERVICE_ROLE_KEY) in GitHub Actions secrets.");
  }
  if (!["ordinary", "interactive", "novel"].includes(workerType)) {
    throw new Error("Invalid BookCheef worker type for quota coordinator.");
  }
  const baseUrl = String(supabaseUrl).replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(baseUrl)) {
    throw new Error("SUPABASE_URL must be the HTTPS URL of the BookCheef Supabase project.");
  }
  assertInteger("defaultCooldownSeconds", defaultCooldownSeconds, 60, 2592000);
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  async function rpc(name, body) {
    const response = await fetchImpl(baseUrl + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const raw = await response.text();
    if (!response.ok) {
      const error = new Error("Supabase provider quota RPC " + name + " failed (HTTP " + response.status + "): " + raw.slice(0, 500));
      error.code = "PROVIDER_QUOTA_BACKEND_ERROR";
      error.status = response.status;
      throw error;
    }
    if (!raw) return {};
    try { return normalizeRow(JSON.parse(raw)); }
    catch {
      const error = new Error("Supabase provider quota RPC returned invalid JSON.");
      error.code = "PROVIDER_QUOTA_BACKEND_ERROR";
      throw error;
    }
  }

  async function acquire({
    providerKey,
    taskId,
    minIntervalSeconds = DEFAULTS.minIntervalSeconds,
    windowSeconds = DEFAULTS.windowSeconds,
    maxRequestsPerWindow = DEFAULTS.maxRequestsPerWindow,
    maxConcurrent = DEFAULTS.maxConcurrent,
    leaseSeconds = DEFAULTS.leaseSeconds
  } = {}) {
    if (!/^[a-z0-9][a-z0-9._:-]{1,79}$/.test(String(providerKey || ""))) {
      throw new Error("Invalid providerKey.");
    }
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(taskId || ""))) {
      throw new Error("Invalid taskId.");
    }
    assertInteger("minIntervalSeconds", minIntervalSeconds, 0, 3600);
    assertInteger("windowSeconds", windowSeconds, 60, 2592000);
    assertInteger("maxRequestsPerWindow", maxRequestsPerWindow, 0, 1000000);
    assertInteger("maxConcurrent", maxConcurrent, 1, 100);
    assertInteger("leaseSeconds", leaseSeconds, 30, 3600);

    const result = await rpc("bookcheef_reserve_provider_request", {
      p_provider_key: providerKey,
      p_worker_type: workerType,
      p_task_id: taskId,
      p_min_interval_seconds: minIntervalSeconds,
      p_window_seconds: windowSeconds,
      p_max_requests_per_window: maxRequestsPerWindow,
      p_max_concurrent: maxConcurrent,
      p_lease_seconds: leaseSeconds
    });
    if (result.allowed !== true || !result.reservation_id) {
      throw new ProviderQuotaWaitError({ ...result, provider_key: providerKey });
    }
    return {
      id: result.reservation_id,
      providerKey,
      retryAfter: result.retry_after || null,
      requestsInWindow: Number(result.requests_in_window) || 0,
      activeReservations: Number(result.active_reservations) || 0
    };
  }

  async function complete(reservation, { outcome = "success", cooldownSeconds = 0, reason = "" } = {}) {
    if (!reservation?.id) throw new Error("A valid provider reservation is required.");
    if (!["success", "failed", "rate_limited"].includes(outcome)) throw new Error("Invalid provider reservation outcome.");
    assertInteger("cooldownSeconds", cooldownSeconds, 0, 2592000);
    return rpc("bookcheef_finish_provider_request", {
      p_reservation_id: reservation.id,
      p_outcome: outcome,
      p_cooldown_seconds: cooldownSeconds,
      p_reason: String(reason || "").slice(0, 700)
    });
  }

  async function run(providerOptions, operation) {
    if (typeof operation !== "function") throw new Error("Provider operation must be a function.");
    const reservation = await acquire(providerOptions);
    let outcome = "success";
    let cooldownSeconds = 0;
    let reason = "";
    try {
      return await operation();
    } catch (error) {
      const status = Number(error?.status || error?.statusCode || 0);
      const message = String(error?.message || error || "");
      const modelSpecificLimit = error?.code === "MODEL_PROVIDER_LIMIT";
      const limited = !modelSpecificLimit && (error?.code === "RATE_LIMIT" || status === 429 || status === 503 ||
        /rate.?limit|quota|resource exhausted|daily limit|usage limit|billing limit|out of credits/i.test(message));
      if (limited) {
        outcome = "rate_limited";
        const retrySeconds = Number(error?.retryAfterSeconds || 0);
        cooldownSeconds = Math.max(60, Math.min(2592000, retrySeconds || defaultCooldownSeconds));
      } else {
        outcome = "failed";
      }
      reason = message;
      throw error;
    } finally {
      await complete(reservation, { outcome, cooldownSeconds, reason });
    }
  }

  return { acquire, complete, run, workerType };
}
