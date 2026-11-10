import test from "node:test";
import assert from "node:assert/strict";
import { classifyOpenRouterFailure, earliestRetryAfter } from "./openrouter-failure-policy.mjs";

test("distinguishes an upstream model provider limit from an account-wide limit", () => {
  assert.equal(classifyOpenRouterFailure({
    status: 429, message: "Provider returned error", providerName: "Google AI Studio"
  }), "MODEL_PROVIDER_LIMIT");
  assert.equal(classifyOpenRouterFailure({
    status: 429, message: "Account rate limit exceeded"
  }), "RATE_LIMIT");
  assert.equal(classifyOpenRouterFailure({
    status: 400, message: "Invalid request"
  }), null);
});

test("uses the first provider retry time rather than waiting for every provider", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  const result = earliestRetryAfter({
    now,
    retryAfterValues: [
      "2026-11-10T04:04:20.920Z",
      "2026-11-10T02:30:00.000Z"
    ]
  });
  assert.equal(result, "2026-11-10T02:30:00.000Z");
});

test("uses a safe fallback when no future retry time is known", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  assert.equal(earliestRetryAfter({ now, retryAfterValues: [] }), "2026-11-10T00:15:00.000Z");
});
