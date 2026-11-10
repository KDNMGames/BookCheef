import test from "node:test";
import assert from "node:assert/strict";
import { selectDeferredTask, selectOldestDeferredTaskAcrossWorkers, shouldNotifyDeferredWait } from "./deferred-task-policy.mjs";

const task = (id, created, retry, type = "ordinary") => ({
  task_id: id,
  book_type: type,
  checkpoint_path: "book-publications/workers/" + type + "/deferred/" + id + ".json",
  created_at: created,
  retry_after: retry
});

test("does not start a new book while the oldest deferred task is cooling down", () => {
  const tasks = [
    task("older", "2026-11-10T01:00:00Z", "2026-11-10T04:00:00Z"),
    task("newer", "2026-11-10T02:00:00Z", "2026-11-10T02:30:00Z")
  ];
  const result = selectDeferredTask(tasks, Date.parse("2026-11-10T03:00:00Z"));
  assert.equal(result.status, "wait");
  assert.equal(result.task.task_id, "older");
  assert.equal(result.retryAfter, "2026-11-10T04:00:00.000Z");
});

test("resumes the oldest deferred task when its retry time has arrived", () => {
  const tasks = [
    task("older", "2026-11-10T01:00:00Z", "2026-11-10T02:00:00Z"),
    task("newer", "2026-11-10T02:00:00Z", "2026-11-10T02:30:00Z")
  ];
  const result = selectDeferredTask(tasks, Date.parse("2026-11-10T03:00:00Z"));
  assert.equal(result.status, "resume");
  assert.equal(result.task.task_id, "older");
});

test("returns none for an empty queue and rejects malformed queued work", () => {
  assert.deepEqual(selectDeferredTask([], 0), { status: "none", task: null });
  assert.throws(() => selectDeferredTask([{ task_id: "broken" }], 0), /without a valid checkpoint path/);
});

test("selects the oldest deferred task across ordinary and interactive workers", () => {
  const selected = selectOldestDeferredTaskAcrossWorkers({
    ordinary: { tasks: [task("ordinary-newer", "2026-11-10T02:00:00Z", "2026-11-10T04:00:00Z")] },
    interactive: { tasks: [task("interactive-older", "2026-11-10T01:00:00Z", "2026-11-10T05:00:00Z", "interactive")] }
  });
  assert.equal(selected.task_id, "interactive-older");
  assert.equal(selected.book_type, "interactive");
});

test("throttles repeated wait notifications but announces a changed retry time", () => {
  const task = {
    last_notified_retry_after: "2026-11-10T04:04:20.000Z",
    last_wait_notice_at: "2026-11-10T00:00:00.000Z"
  };
  const retry = "2026-11-10T04:04:20.000Z";
  assert.equal(shouldNotifyDeferredWait(task, retry, Date.parse("2026-11-10T00:30:00Z")), false);
  assert.equal(shouldNotifyDeferredWait(task, retry, Date.parse("2026-11-10T01:00:00Z")), true);
  assert.equal(shouldNotifyDeferredWait(task, "2026-11-10T05:00:00Z", Date.parse("2026-11-10T00:30:00Z")), true);
});
