import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const WORKER_TYPES = new Set(["ordinary", "interactive", "novel"]);

function assertWorkerType(value) {
  if (!WORKER_TYPES.has(value)) {
    throw new Error("Unsupported BookCheef worker type: " + String(value));
  }
}

export function createBookWorkerState({
  workerType,
  runId = process.env.GITHUB_RUN_ID || randomUUID(),
  root = "book-publications/workers",
  leaseSeconds = 4 * 60 * 60
} = {}) {
  assertWorkerType(workerType);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(String(runId))) {
    throw new Error("Invalid worker run id.");
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 24 * 60 * 60) {
    throw new Error("Worker lease must be between 60 seconds and 24 hours.");
  }

  const workerDir = path.join(root, workerType);
  const checkpointDir = path.join(workerDir, "checkpoints");
  const deferredDir = path.join(workerDir, "deferred");
  const leasePath = path.join(workerDir, "lease.json");

  async function atomicWriteJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = filePath + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function acquireLease() {
    await fs.mkdir(workerDir, { recursive: true });
    const now = Date.now();
    const lease = {
      worker_type: workerType,
      run_id: String(runId),
      acquired_at: new Date(now).toISOString(),
      expires_at: new Date(now + leaseSeconds * 1000).toISOString()
    };

    try {
      const handle = await fs.open(leasePath, "wx");
      try {
        await handle.writeFile(JSON.stringify(lease, null, 2) + "\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return lease;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    let existing;
    try {
      existing = JSON.parse(await fs.readFile(leasePath, "utf8"));
    } catch {
      throw new Error("Worker lease exists but cannot be read; refusing to steal it.");
    }
    const expiresAt = Date.parse(existing.expires_at || "");
    if (!Number.isFinite(expiresAt) || expiresAt > now) {
      throw new Error("Worker " + workerType + " is already leased by run " +
        String(existing.run_id || "unknown") + ".");
    }

    const stalePath = leasePath + ".expired-" + randomUUID();
    try {
      await fs.rename(leasePath, stalePath);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EEXIST") {
        throw new Error("Worker lease changed during stale-lease recovery; retry safely.");
      }
      throw error;
    }
    await fs.rm(stalePath, { force: true });
    return acquireLease();
  }

  async function releaseLease() {
    let existing;
    try {
      existing = JSON.parse(await fs.readFile(leasePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (String(existing.run_id) !== String(runId)) return false;
    await fs.rm(leasePath, { force: true });
    return true;
  }

  function checkpointPath(taskId) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(taskId))) {
      throw new Error("Invalid worker task id.");
    }
    return path.join(checkpointDir, String(taskId) + ".json");
  }

  function deferredPath(taskId) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(taskId))) {
      throw new Error("Invalid worker task id.");
    }
    return path.join(deferredDir, String(taskId) + ".json");
  }

  return {
    workerType,
    runId: String(runId),
    workerDir,
    checkpointDir,
    deferredDir,
    leasePath,
    cooldownPath: path.join(workerDir, "provider-cooldowns.json"),
    queuePath: path.join(workerDir, "queue.json"),
    acquireLease,
    releaseLease,
    checkpointPath,
    deferredPath,
    atomicWriteJson
  };
}
