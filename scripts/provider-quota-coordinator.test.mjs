import test from "node:test";
import assert from "node:assert/strict";
import { createProviderQuotaCoordinator, ProviderQuotaWaitError } from "./provider-quota-coordinator.mjs";

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

test("acquires a provider reservation through the private Supabase RPC", async () => {
  let call;
  const quota = createProviderQuotaCoordinator({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role",
    workerType: "interactive",
    fetchImpl: async (url, options) => {
      call = { url, options };
      return response([{
        allowed: true,
        reservation_id: "00000000-0000-4000-8000-000000000001",
        requests_in_window: 4,
        active_reservations: 1
      }]);
    }
  });
  const reservation = await quota.acquire({ providerKey: "gemini", taskId: "book-123" });
  assert.equal(reservation.id, "00000000-0000-4000-8000-000000000001");
  assert.equal(call.url, "https://example.supabase.co/rest/v1/rpc/bookcheef_reserve_provider_request");
  assert.equal(call.options.headers.apikey, "test-service-role");
  assert.equal(call.options.headers.Authorization, undefined);
  const body = JSON.parse(call.options.body);
  assert.equal(body.p_provider_key, "gemini");
  assert.equal(body.p_worker_type, "interactive");
  assert.equal(body.p_max_concurrent, 1);
});

test("refuses work while another worker owns the provider slot", async () => {
  const quota = createProviderQuotaCoordinator({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "secret",
    fetchImpl: async () => response([{
      allowed: false,
      retry_after: "2026-11-09T15:00:00.000Z",
      reason: "concurrency_limit",
      requests_in_window: 3,
      active_reservations: 1
    }])
  });
  await assert.rejects(
    quota.acquire({ providerKey: "openrouter", taskId: "task-1" }),
    error => error instanceof ProviderQuotaWaitError &&
      error.code === "PROVIDER_QUOTA_WAIT" &&
      error.retryAfter === "2026-11-09T15:00:00.000Z"
  );
});

test("completes a successful reservation after the operation", async () => {
  const calls = [];
  const quota = createProviderQuotaCoordinator({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith("bookcheef_reserve_provider_request")) {
        return response([{ allowed: true, reservation_id: "00000000-0000-4000-8000-000000000002" }]);
      }
      return response(true);
    }
  });
  const result = await quota.run({ providerKey: "gemini", taskId: "novel-7" }, async () => "generated");
  assert.equal(result, "generated");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.p_outcome, "success");
});

test("records provider cooldown after a quota error", async () => {
  const calls = [];
  const quota = createProviderQuotaCoordinator({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith("bookcheef_reserve_provider_request")) {
        return response([{ allowed: true, reservation_id: "00000000-0000-4000-8000-000000000003" }]);
      }
      return response(true);
    }
  });
  await assert.rejects(
    quota.run({ providerKey: "gemini", taskId: "book-429" }, async () => {
      const error = new Error("Gemini HTTP 429: quota exceeded");
      error.status = 429;
      error.retryAfterSeconds = 120;
      throw error;
    }),
    /quota exceeded/
  );
  assert.equal(calls[1].body.p_outcome, "rate_limited");
  assert.equal(calls[1].body.p_cooldown_seconds, 120);
});

test("fails closed when shared quota credentials are missing or provider identity is invalid", async () => {
  assert.throws(() => createProviderQuotaCoordinator({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: ""
  }), /SUPABASE_URL and SUPABASE_SECRET_KEY/);
  const quota = createProviderQuotaCoordinator({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "secret",
    fetchImpl: async () => response([])
  });
  await assert.rejects(quota.acquire({ providerKey: "Bad Provider", taskId: "task-1" }), /Invalid providerKey/);
  assert.throws(() => createProviderQuotaCoordinator({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "secret",
    defaultCooldownSeconds: 10
  }), /defaultCooldownSeconds/);
});
