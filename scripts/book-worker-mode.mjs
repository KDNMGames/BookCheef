export function resolveBookWorkerMode(env = process.env) {
  const mode = env.BOOKCHEEF_WORKER_MODE || "coordinated";
  if (!["coordinated", "isolated"].includes(mode)) {
    throw new Error("Unsupported BOOKCHEEF_WORKER_MODE: " + mode);
  }
  const workerType = env.BOOKCHEEF_WORKER_TYPE || "";
  if (mode === "isolated" && !["ordinary", "interactive"].includes(workerType)) {
    throw new Error("Isolated mode requires BOOKCHEEF_WORKER_TYPE=ordinary or interactive.");
  }
  return { mode, isolated: mode === "isolated", workerType };
}
