import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBookWorkerState } from "./book-worker-state.mjs";

test("worker types have isolated state directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookcheef-workers-"));
  try {
    const ordinary = createBookWorkerState({ workerType: "ordinary", runId: "run-a", root });
    const interactive = createBookWorkerState({ workerType: "interactive", runId: "run-b", root });
    assert.notEqual(ordinary.workerDir, interactive.workerDir);
    assert.notEqual(ordinary.queuePath, interactive.queuePath);
    assert.notEqual(ordinary.cooldownPath, interactive.cooldownPath);
    assert.notEqual(ordinary.checkpointPath("task-1"), interactive.checkpointPath("task-1"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a worker lease prevents a second active run and only its owner releases it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookcheef-leases-"));
  try {
    const first = createBookWorkerState({ workerType: "ordinary", runId: "run-a", root });
    const second = createBookWorkerState({ workerType: "ordinary", runId: "run-b", root });
    await first.acquireLease();
    await assert.rejects(() => second.acquireLease(), /already leased/);
    assert.equal(await second.releaseLease(), false);
    assert.equal(await first.releaseLease(), true);
    await second.acquireLease();
    assert.equal(await second.releaseLease(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("worker type and task ids are validated", () => {
  assert.throws(() => createBookWorkerState({ workerType: "shared" }), /Unsupported/);
  const worker = createBookWorkerState({ workerType: "novel", runId: "run-c" });
  assert.throws(() => worker.checkpointPath("../escape"), /Invalid worker task id/);
});
