// src/tietie-tasks.mjs — categorized reaction refresh tasks.
import { SORT, REFRESH_STATUS } from "./choices.mjs";
import { TIETIE_CATEGORIES } from "./tietie-parser.mjs";
import { createTaskProgressReporter } from "./refresh.mjs";

const TIETIE_MAX_PAGES = 5;
const TIETIE_TASK_TYPE = "tietie";
function tietieIdentityDescriptorsFor(content) {
  const descriptors = [];
  for (const [kind, field] of [
    ["content", "contentKey"],
    ["dynamic", "dynamicIdentifier"],
    ["reaction", "reactionContainerIdentifier"],
  ]) {
    const value = content?.[field];
    if (typeof value === "string" && value.trim()) {
      descriptors.push({ kind, value: value.trim() });
    }
  }
  return descriptors;
}

function tietieIdentityToken({ kind, value }) {
  return JSON.stringify([kind, value]);
}

// The content link has priority over the dynamic and reaction-container
// identifiers. Fallback identifiers are registered as aliases, so a later
// item that lacks a higher-priority identifier can still join the same
// record. A disclosed higher-priority identifier is never bypassed to use
// a lower-priority alias.
function createTietieContentAccumulator() {
  const records = [];
  const index = new Map();

  function recordsFor(descriptor) {
    return index.get(tietieIdentityToken(descriptor)) || [];
  }

  function register(record, descriptor) {
    const token = tietieIdentityToken(descriptor);
    const matches = index.get(token) || [];
    if (!matches.includes(record)) matches.push(record);
    index.set(token, matches);
  }

  function registerAll(record, content) {
    for (const descriptor of tietieIdentityDescriptorsFor(content)) {
      register(record, descriptor);
    }
  }

  function candidateFor(descriptors) {
    const [primary] = descriptors;
    if (!primary) return null;

    const exact = recordsFor(primary);
    if (exact.length === 1) return exact[0];
    return null;
  }

  function mergeMetadata(record, content) {
    for (const field of [
      "contentKey",
      "dynamicIdentifier",
      "reactionContainerIdentifier",
    ]) {
      if (!record[field] && content?.[field]) record[field] = content[field];
    }
    registerAll(record, content);
  }

  function add(content) {
    const descriptors = tietieIdentityDescriptorsFor(content);
    let record = candidateFor(descriptors);
    if (!record) {
      record = {
        contentKey: content?.contentKey || null,
        dynamicIdentifier: content?.dynamicIdentifier || null,
        reactionContainerIdentifier:
          content?.reactionContainerIdentifier || null,
        reactorIdentifiers: new Set(),
      };
      records.push(record);
    }
    mergeMetadata(record, content);

    const addedReactors = [];
    for (const identifier of content?.reactorIdentifiers || []) {
      if (record.reactorIdentifiers.has(identifier)) continue;
      record.reactorIdentifiers.add(identifier);
      addedReactors.push(identifier);
    }
    return addedReactors;
  }

  return { add };
}

// 和我贴贴任务按分类和页排队，而不是按好友排队。每个成功页面只在
// 页面明确提供下一页时追加同一分类的下一页，最多读取前五页；两分类
// 的页面结果先在批次内按内容链接、动态编号或表情容器标识逐级去重，
// 无可用标识的动态直接累计。全部必要页面成功后才交给会话发布；
// 失败批次不会触碰旧的完整结果。
function createTietieTasks({
  applySort,
  cache,
  http,
  now,
  onProgress,
  publishResult,
  scheduler,
  status,
  visitorIdentifier,
}) {
  const progressReporter = createTaskProgressReporter({
    onProgress,
    status,
    taskType: TIETIE_TASK_TYPE,
    messageFor: ({ completed, total }) =>
      `正在获取“和我贴贴” ${completed}/${total}`,
  });
  let batch = null;
  let enqueueNextPage = null;

  function mergePage(record) {
    for (const content of record.contents || []) {
      for (const identifier of batch.contents.add(content)) {
        batch.counts.set(identifier, (batch.counts.get(identifier) || 0) + 1);
      }
    }
  }

  const lifecycle = {
    onFetching: progressReporter,
    onProgress: progressReporter,
    onQueue: progressReporter,
    onRateLimited: status.showRateLimit,
    onSuccess(item, record) {
      mergePage(record);
      if (record.hasNextPage && item.page < TIETIE_MAX_PAGES) {
        enqueueNextPage?.({ category: item.category, page: item.page + 1 });
      }
    },
    onFinished({ failures, globallyStopped }) {
      status.clearProgress(TIETIE_TASK_TYPE);
      const completedBatch = batch;
      batch = null;
      if (globallyStopped) {
        status.showRateLimit();
        return;
      }
      if (failures === 0) {
        const result = {
          complete: true,
          counts: completedBatch.counts,
          fetchedAt: now(),
        };
        cache.replaceTietie(visitorIdentifier, result);
        publishResult(result);
        applySort();
        status.set(REFRESH_STATUS.COMPLETED, "“和我贴贴”获取完成", 5_000);
        return;
      }
      status.set(
        REFRESH_STATUS.COMPLETED,
        "“和我贴贴”获取失败，本次结果未更新",
        5_000,
      );
    },
  };

  const taskOptions = {
    fetch: (item) =>
      http.fetchTietiePage(visitorIdentifier, item.category, item.page),
    isSuccess: (record) =>
      record?.kind === "success" || record?.kind === "empty",
    keyFor: (item) => `${item.category}:${item.page}`,
    lifecycle,
    target: { kind: SORT.TIETIE },
  };

  enqueueNextPage = (item) => {
    scheduler.enqueue(TIETIE_TASK_TYPE, [item], taskOptions);
  };

  function refresh(mode = "incremental") {
    if (!http?.fetchTietiePage || !visitorIdentifier) return null;
    const existingTask = scheduler.getTask(TIETIE_TASK_TYPE);
    if (existingTask) {
      // Re-selecting the target while its pages are already being fetched
      // only brings that task back to the foreground. It must not restart
      // the batch or add duplicate category/page requests.
      scheduler.enqueue(TIETIE_TASK_TYPE, [], taskOptions, {
        foreground: true,
      });
      return existingTask;
    }
    if (mode !== "full" && !cache.tietieNeedsRefresh(visitorIdentifier)) {
      return null;
    }

    batch = {
      contents: createTietieContentAccumulator(),
      counts: new Map(),
    };
    const { task } = scheduler.enqueue(
      TIETIE_TASK_TYPE,
      TIETIE_CATEGORIES.map((category) => ({ category, page: 1 })),
      taskOptions,
      { foreground: true },
    );
    return task;
  }

  return {
    refresh,
  };
}

export { createTietieTasks };
