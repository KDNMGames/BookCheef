export function selectDeferredTask(tasks, now = Date.now()) {
  if (!Array.isArray(tasks) || tasks.length === 0) return { status: "none", task: null };

  const ordered = tasks
    .filter(task => task && ["interactive", "ordinary"].includes(task.book_type) &&
      typeof task.checkpoint_path === "string" && task.checkpoint_path.length > 0)
    .slice()
    .sort((a, b) => {
      const left = Date.parse(a.created_at || "") || 0;
      const right = Date.parse(b.created_at || "") || 0;
      return left - right;
    });

  if (!ordered.length) {
    throw new Error("Deferred queue contains tasks without a valid checkpoint path; refusing to start another book.");
  }

  const ready = ordered.filter(candidate => {
    const retryAt = Date.parse(candidate.retry_after || "");
    return !Number.isFinite(retryAt) || retryAt <= now;
  });
  if (ready.length) return { status: "resume", task: ready[0] };
  const task = ordered[0];
  const retryAt = Date.parse(task.retry_after || "");
  return { status: "wait", task, retryAfter: new Date(retryAt).toISOString() };
}

export function selectOldestDeferredTaskAcrossWorkers(queues) {
  const tasks = Object.entries(queues || {}).flatMap(([workerType, queue]) =>
    (Array.isArray(queue?.tasks) ? queue.tasks : []).map(task => ({
      ...task,
      book_type: task?.book_type || workerType
    }))
  ).filter(task => task && ["interactive", "ordinary"].includes(task.book_type) &&
    typeof task.checkpoint_path === "string" && task.checkpoint_path.length > 0);

  tasks.sort((a, b) => {
    const left = Date.parse(a.created_at || "") || 0;
    const right = Date.parse(b.created_at || "") || 0;
    return left - right;
  });
  return tasks[0] || null;
}

export function shouldNotifyDeferredWait(task, retryAfter, now = Date.now(), minIntervalMs = 60 * 60 * 1000) {
  if (!task || task.last_notified_retry_after !== retryAfter) return true;
  const lastNotice = Date.parse(task.last_wait_notice_at || "");
  return !Number.isFinite(lastNotice) || now - lastNotice >= minIntervalMs;
}

export function releaseDeferredTasksWhenProviderReady(tasks, providersReady, now = Date.now()) {
  if (!Array.isArray(tasks) || !providersReady) return { released: 0, tasks };
  const retryAfter = new Date(now).toISOString();
  let released = 0;
  const updated = tasks.map(task => {
    if (!task || !task.checkpoint_path) return task;
    const retryAt = Date.parse(task.retry_after || "");
    if (Number.isFinite(retryAt) && retryAt > now) {
      released += 1;
      return { ...task, retry_after: retryAfter, provider_retry_recheck_at: retryAfter };
    }
    return task;
  });
  return { released, tasks: updated };
}
