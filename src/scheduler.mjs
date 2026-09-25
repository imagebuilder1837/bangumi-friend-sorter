// src/scheduler.mjs — bounded concurrent page-task scheduling.

function needsLargeRequestConfirmation(count) {
  return count > 400;
}

function nextBatchState(state, outcome) {
  if (state.stopped) return state;
  if (outcome.kind === "http-error" && outcome.status === 429) {
    return { ...state, stopped: true };
  }
  if (
    outcome.kind === "http-error" &&
    (outcome.status === 403 || outcome.status >= 500)
  ) {
    const consecutiveServerFailures = state.consecutiveServerFailures + 1;
    return {
      consecutiveServerFailures,
      stopped: consecutiveServerFailures >= 5,
    };
  }
  return { consecutiveServerFailures: 0, stopped: false };
}

function createTaskScheduler({ concurrency = 4 } = {}) {
  const maxConcurrency = Math.max(1, Math.floor(concurrency));
  const tasks = new Map();
  let foregroundType = null;
  let inFlight = 0;
  let globallyStopped = false;

  function isRateLimited(outcome) {
    return outcome?.kind === "http-error" && outcome.status === 429;
  }

  function normalizedOutcome(outcome) {
    return outcome && typeof outcome === "object"
      ? outcome
      : { kind: "network-error" };
  }

  function runnableTask() {
    const foreground = foregroundType && tasks.get(foregroundType);
    if (foreground?.canSchedule()) return foreground;
    if (foreground?.hasInFlight()) return null;
    return [...tasks.values()].find((task) => task.canSchedule()) || null;
  }

  function pump() {
    while (!globallyStopped && inFlight < maxConcurrency) {
      const task = runnableTask();
      if (!task) return;

      const item = task.take();
      if (!item) continue;
      inFlight += 1;
      task.begin();
      let request;
      try {
        request = task.fetch(item);
      } catch {
        request = { kind: "network-error" };
      }
      Promise.resolve(request)
        .catch(() => ({ kind: "network-error" }))
        .then((outcome) => {
          inFlight -= 1;
          task.complete(item, normalizedOutcome(outcome));
          pump();
        });
    }
  }

  function stopAll() {
    if (globallyStopped) return;
    globallyStopped = true;
    for (const task of [...tasks.values()]) task.stop();
  }

  function createTask(type, options) {
    // startForegroundTask is the only production caller and always
    // supplies keyFor, confirmMessage, target and isSuccess; no
    // defaults here.
    const keyFor = options.keyFor;
    const confirmMessage = options.confirmMessage;
    const isSuccess = options.isSuccess;
    const lifecycle = options.lifecycle;
    const queue = [];
    const queuedKeys = new Set();
    const results = new Map();
    let completed = 0;
    let total = 0;
    let inFlightForTask = 0;
    let target = options.target;
    let batchState = { consecutiveServerFailures: 0, stopped: false };
    let started = false;
    let finished = false;

    // One progress snapshot shape shared by onFetching/onProgress/onQueue:
    // the task's counters and its reported target travel together.
    function progress() {
      return { completed, target, total };
    }

    function finishIfIdle() {
      if (finished || inFlightForTask > 0 || queue.length > 0) return;
      finished = true;
      let failures = 0;
      for (const result of results.values()) {
        if (!isSuccess(result.record, result.outcome, target)) {
          failures += 1;
        }
      }
      if (tasks.get(type) === task) tasks.delete(type);
      lifecycle.onFinished?.({
        completed,
        failures,
        globallyStopped,
        stopped: batchState.stopped || globallyStopped,
        target,
        total,
      });
    }

    const task = {
      begin() {
        inFlightForTask += 1;
        if (!started) {
          started = true;
          lifecycle.onFetching?.(progress());
        }
      },
      canSchedule() {
        return !finished && !batchState.stopped && queue.length > 0;
      },
      hasInFlight() {
        return !batchState.stopped && inFlightForTask > 0;
      },
      complete(item, outcome) {
        inFlightForTask -= 1;
        completed += 1;
        const record = outcome.kind === "success" ? outcome.record : null;
        if (outcome.kind === "success") {
          lifecycle.onSuccess?.(item, outcome.record);
        }
        results.set(keyFor(item), { item, outcome, record });
        batchState = nextBatchState(batchState, outcome);
        lifecycle.onProgress?.(progress());
        if (isRateLimited(outcome)) {
          const shouldNotify = !globallyStopped;
          stopAll();
          if (shouldNotify) lifecycle.onRateLimited?.();
        }
        if (batchState.stopped) task.stop();
        finishIfIdle();
      },
      enqueue(items, nextTarget) {
        const candidateKeys = new Set(queuedKeys);
        const newItems = [];
        for (const item of items) {
          const key = keyFor(item);
          if (candidateKeys.has(key)) continue;
          candidateKeys.add(key);
          newItems.push(item);
        }
        // Switching the reported target is not a hidden side effect of a
        // rejected expansion: keep serving the previous target (story 50).
        if (
          needsLargeRequestConfirmation(newItems.length) &&
          options.confirmRequest &&
          !options.confirmRequest(confirmMessage(newItems.length))
        ) {
          return { added: 0, accepted: false };
        }
        target = nextTarget;
        for (const item of newItems) {
          queuedKeys.add(keyFor(item));
          queue.push(item);
        }
        total += newItems.length;
        if (started) {
          lifecycle.onQueue?.(progress());
        }
        return { added: newItems.length, accepted: true };
      },
      fetch: options.fetch,
      getState() {
        return progress();
      },
      isStopped() {
        return batchState.stopped;
      },
      stop() {
        if (finished) return;
        batchState = { ...batchState, stopped: true };
        const unattempted = queue.splice(0);
        if (unattempted.length > 0) {
          for (const item of unattempted) {
            results.set(keyFor(item), {
              item,
              outcome: { kind: "unattempted" },
              record: null,
            });
          }
          completed += unattempted.length;
          lifecycle.onProgress?.(progress());
        }
        finishIfIdle();
      },
      take() {
        return queue.shift() || null;
      },
    };
    return task;
  }

  function enqueue(type, items, options, { foreground = false } = {}) {
    if (globallyStopped) return { added: 0, task: null };
    let task = tasks.get(type);
    if (task?.isStopped()) return { added: 0, task: null };
    if (!task) {
      task = createTask(type, options);
      tasks.set(type, task);
    }
    const { added, accepted } = task.enqueue(items, options.target);
    if (added === 0 && task.getState().total === 0) {
      if (tasks.get(type) === task) tasks.delete(type);
      pump();
      return { added: 0, task: null };
    }
    if (foreground && accepted) {
      foregroundType = type;
    }
    pump();
    return { added, task };
  }

  return {
    enqueue,
    getInFlightCount: () => inFlight,
    getForegroundType: () =>
      foregroundType && tasks.has(foregroundType) ? foregroundType : null,
    getTask: (type) => tasks.get(type) || null,
    isGloballyStopped: () => globallyStopped,
    stopAll,
  };
}

export { createTaskScheduler };
