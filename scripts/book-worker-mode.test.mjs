import test from "node:test";
import assert from "node:assert/strict";
import { resolveBookWorkerMode } from "./book-worker-mode.mjs";

test("defaults to coordinated mode for legacy workflow compatibility", () => {
  assert.deepEqual(resolveBookWorkerMode({}), { mode: "coordinated", isolated: false, workerType: "" });
});

test("isolated mode requires an explicit ordinary or interactive worker", () => {
  assert.throws(() => resolveBookWorkerMode({ BOOKCHEEF_WORKER_MODE: "isolated" }), /requires BOOKCHEEF_WORKER_TYPE/);
  assert.throws(() => resolveBookWorkerMode({ BOOKCHEEF_WORKER_MODE: "isolated", BOOKCHEEF_WORKER_TYPE: "novel" }), /requires BOOKCHEEF_WORKER_TYPE/);
});

test("accepts each supported isolated worker type", () => {
  for (const workerType of ["ordinary", "interactive"]) {
    assert.deepEqual(resolveBookWorkerMode({ BOOKCHEEF_WORKER_MODE: "isolated", BOOKCHEEF_WORKER_TYPE: workerType }), {
      mode: "isolated", isolated: true, workerType
    });
  }
});

test("rejects unknown execution modes", () => {
  assert.throws(() => resolveBookWorkerMode({ BOOKCHEEF_WORKER_MODE: "parallel-everything" }), /Unsupported BOOKCHEEF_WORKER_MODE/);
});
