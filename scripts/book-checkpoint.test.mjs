import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCheckpointStore } from "./book-checkpoint.mjs";

test("checkpoint survives a process restart and restores the exact partial book", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookcheef-checkpoint-"));
  try {
    const workPath = path.join(dir, "work", "current.json");
    const partial = {
      title: "Проверка восстановления",
      book_content: "## Глава 1\n\nУже расширенная глава.\n\n## Глава 2\n\nЧерновик следующей главы.",
      chapters_completed: 1
    };
    const firstProcess = createCheckpointStore({ workPath, bookType: "ordinary", logger: { log() {} } });
    await firstProcess.saveWork(partial);

    // A new store instance represents a fresh GitHub Actions runner/process.
    const restartedProcess = createCheckpointStore({ workPath, bookType: "ordinary", logger: { log() {} } });
    assert.deepEqual(await restartedProcess.loadWork(), partial);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("checkpoint cannot be resumed under a different rotation type", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookcheef-checkpoint-"));
  try {
    const workPath = path.join(dir, "current.json");
    const store = createCheckpointStore({ workPath, bookType: "ordinary" });
    await store.saveWork({ title: "Тест", book_content: "Текст" });
    const wrongRotation = createCheckpointStore({ workPath, bookType: "interactive" });
    await assert.rejects(() => wrongRotation.loadWork(), /does not match/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("missing checkpoint is a normal first-run state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookcheef-checkpoint-"));
  try {
    const store = createCheckpointStore({ workPath: path.join(dir, "missing.json"), bookType: "ordinary" });
    assert.equal(await store.loadWork(), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
