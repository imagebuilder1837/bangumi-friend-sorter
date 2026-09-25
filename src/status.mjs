// src/status.mjs — status priority and lifetime.
import { REFRESH_STATUS } from "./choices.mjs";

function createStatusController({
  clearTimeout: clearStatusTimeout = globalThis.clearTimeout,
  now = Date.now,
  // 最终提示的呈现出口：状态控制器只计算既有优先级下的最终文本，
  // 由调用方把文本并入唯一的渲染过程。
  present,
  scheduler,
  setTimeout: setStatusTimeout = globalThis.setTimeout,
}) {
  let statusTimer = null;
  let statusKind = REFRESH_STATUS.IDLE;
  let transientStatus = null;
  let loginStatus = null;
  let completionTimer = null;
  const completionStatuses = [];
  const progressStatuses = new Map();
  let progressSequence = 0;
  let rateLimitStatusShown = false;

  function pruneCompletionStatuses(currentTime = now()) {
    while (completionStatuses.length > 0) {
      const next = completionStatuses[0];
      if (next.expiresAt === null) {
        next.expiresAt = currentTime + next.durationMs;
      }
      if (next.expiresAt > currentTime) break;
      completionStatuses.shift();
    }
  }

  function scheduleCompletionExpiry(currentTime = now()) {
    clearStatusTimeout(completionTimer);
    completionTimer = null;
    const next = completionStatuses[0];
    if (!next) return;
    const scheduled = next;
    completionTimer = setStatusTimeout(
      () => {
        completionTimer = null;
        if (completionStatuses[0] === scheduled) completionStatuses.shift();
        render();
      },
      Math.max(0, next.expiresAt - currentTime),
    );
  }

  function currentProgressStatus() {
    const foregroundType = scheduler.getForegroundType();
    const foregroundProgress = foregroundType
      ? progressStatuses.get(foregroundType)
      : null;
    if (foregroundProgress) return foregroundProgress;
    return [...progressStatuses.values()].sort(
      (left, right) => right.sequence - left.sequence,
    )[0];
  }

  function render(currentTime) {
    if (completionStatuses.length > 0) {
      const statusTime = currentTime ?? now();
      pruneCompletionStatuses(statusTime);
      scheduleCompletionExpiry(statusTime);
    } else {
      clearStatusTimeout(completionTimer);
      completionTimer = null;
    }

    if (loginStatus) {
      statusKind = REFRESH_STATUS.LOGIN_REQUIRED;
      present(loginStatus.message);
      return;
    }

    const completion = completionStatuses[0];
    if (completion) {
      statusKind = REFRESH_STATUS.COMPLETED;
      present(completion.message);
      return;
    }

    if (transientStatus) {
      statusKind = transientStatus.kind;
      present(transientStatus.message);
      return;
    }

    const progress = currentProgressStatus();
    if (progress) {
      statusKind = REFRESH_STATUS.FETCHING;
      present(progress.message);
      return;
    }

    statusKind = REFRESH_STATUS.IDLE;
    present("");
  }

  function clearArmedStatus() {
    if (transientStatus?.kind !== REFRESH_STATUS.AWAITING_FULL_REFRESH) return;
    clearStatusTimeout(statusTimer);
    statusTimer = null;
    transientStatus = null;
  }

  function clearCompletionStatuses() {
    completionStatuses.length = 0;
    clearStatusTimeout(completionTimer);
    completionTimer = null;
  }

  function clear() {
    clearStatusTimeout(statusTimer);
    statusTimer = null;
    transientStatus = null;
    loginStatus = null;
    render();
  }

  function set(kind, message, clearAfterMs = 0) {
    if (kind === REFRESH_STATUS.COMPLETED) {
      clearArmedStatus();
      const completedAt = now();
      completionStatuses.push({
        durationMs: Math.max(0, clearAfterMs),
        expiresAt: null,
        message,
      });
      render(completedAt);
      return;
    }

    if (kind !== REFRESH_STATUS.LOGIN_REQUIRED && loginStatus) return;
    clearStatusTimeout(statusTimer);
    statusTimer = null;
    if (kind === REFRESH_STATUS.LOGIN_REQUIRED) {
      transientStatus = null;
      loginStatus = { message };
    } else {
      loginStatus = null;
      transientStatus = { kind, message };
    }
    render();
    if (clearAfterMs > 0) {
      statusTimer = setStatusTimeout(() => {
        statusTimer = null;
        transientStatus = null;
        loginStatus = null;
        render();
      }, clearAfterMs);
    }
  }

  function setProgress(taskType, message) {
    clearArmedStatus();
    progressStatuses.set(taskType, {
      message,
      sequence: ++progressSequence,
    });
    render();
  }

  function clearProgress(taskType) {
    progressStatuses.delete(taskType);
    render();
  }

  function showRateLimit() {
    if (rateLimitStatusShown) return;
    rateLimitStatusShown = true;
    clearCompletionStatuses();
    clearStatusTimeout(statusTimer);
    statusTimer = null;
    transientStatus = null;
    loginStatus = null;
    set(REFRESH_STATUS.COMPLETED, "请求受限，已停止全部获取", 5_000);
  }

  return {
    clear,
    clearProgress,
    getKind: () => statusKind,
    set,
    setProgress,
    showRateLimit,
  };
}

export { createStatusController };
