// src/refresh.mjs — refresh task lifecycle bridges.
import { REFRESH_STATUS } from "./choices.mjs";
import { userIdentifierFor } from "./identity.mjs";

function createRefreshLifecycle({
  applySort,
  labelFor,
  progressReporter,
  status,
  taskType,
}) {
  return {
    onFetching: progressReporter,
    onProgress: progressReporter,
    onQueue: progressReporter,
    onRateLimited: status.showRateLimit,
    onFinished({ failures, globallyStopped, target }) {
      status.clearProgress(taskType);
      applySort();
      if (globallyStopped) {
        status.showRateLimit();
        return;
      }
      const label = labelFor(target);
      status.set(
        REFRESH_STATUS.COMPLETED,
        failures
          ? `“${label}”获取完成，${failures} 人失败`
          : `“${label}”获取完成`,
        5_000,
      );
    },
  };
}

function createTaskProgressReporter({
  onProgress,
  status,
  taskType,
  messageFor,
}) {
  return ({ completed, target, total }) => {
    status.setProgress(taskType, messageFor({ completed, target, total }));
    onProgress?.(completed, total);
  };
}

// Bridges one page task's lifecycle to a friend-cache refresh batch: the
// batch opens when the task starts fetching, accepts each friend's result
// and commits once when the task finishes. Callers never touch persistence.
function createCacheBatchLifecycle({
  applySort,
  cache,
  labelFor,
  progressReporter,
  projectResult,
  status,
  taskType,
  visitorIdentifier,
}) {
  const base = createRefreshLifecycle({
    applySort,
    labelFor,
    progressReporter,
    status,
    taskType,
  });
  let batch = null;
  return {
    ...base,
    onFetching(progress) {
      batch = cache.beginRefresh({ visitorIdentifier });
      base.onFetching?.(progress);
    },
    onFinished(result) {
      batch?.complete();
      batch = null;
      base.onFinished?.(result);
    },
    onSuccess(friend, record) {
      batch?.accept(userIdentifierFor(friend), projectResult(record));
    },
  };
}

// Starts a foreground scheduler task for one refresh; guarded so a
// stopped scheduler or missing fetch adapter never enqueue work.
function startForegroundTask({
  confirmRequest,
  fetch,
  isSuccess = (_record, outcome) => outcome.kind === "success",
  keyFor,
  lifecycle = {},
  pending,
  scheduler,
  target,
  taskType,
}) {
  if (scheduler.isGloballyStopped() || !fetch) return null;
  if (pending.length === 0 && !scheduler.getTask(taskType)) return null;
  const { task } = scheduler.enqueue(
    taskType,
    pending,
    {
      confirmMessage: (count) =>
        `本次新增获取的好友数量过多（${count} 人），是否继续？`,
      confirmRequest,
      fetch,
      isSuccess,
      keyFor,
      lifecycle,
      target,
    },
    { foreground: true },
  );
  return task;
}

export {
  createCacheBatchLifecycle,
  createTaskProgressReporter,
  startForegroundTask,
};
