export function classifyOpenRouterFailure({ status, message = "", providerName = "" } = {}) {
  const code = Number(status) || 0;
  const detail = String(message || "");
  const hasProvider = Boolean(String(providerName || "").trim());
  const limited = code === 429 || code === 503 || (hasProvider && code >= 500) ||
    /rate.?limit|quota|resource exhausted|daily limit|credits exhausted|temporarily unavailable/i.test(detail);
  if (!limited) return null;
  return hasProvider ? "MODEL_PROVIDER_LIMIT" : "RATE_LIMIT";
}

export function earliestRetryAfter({
  now = Date.now(),
  retryAfterValues = [],
  fallbackDelayMs = 15 * 60 * 1000
} = {}) {
  const candidates = retryAfterValues
    .map(value => typeof value === "number" ? value : Date.parse(value || ""))
    .filter(value => Number.isFinite(value) && value > now);
  const next = candidates.length ? Math.min(...candidates) : now + fallbackDelayMs;
  return new Date(next).toISOString();
}
