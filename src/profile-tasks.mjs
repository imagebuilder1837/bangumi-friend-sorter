// src/profile-tasks.mjs — profile field refresh tasks.
import { SORT, REMOTE_TARGET_SELECTION_KEYS } from "./choices.mjs";
import { userIdentifierFor } from "./identity.mjs";
import { successfulOutcomeValues } from "./profile-parser.mjs";
import {
  createCacheBatchLifecycle,
  createTaskProgressReporter,
  startForegroundTask,
} from "./refresh.mjs";

// 主页字段任务 deep module：拥有八个主页字段（六个完成统计范围与同步
// 率、共同喜好数两个契合指标）的字段语义、同一批次内单次可复用的主页
// 请求、任务合并扩充与字段级成功失败统计。调用方只声明当前排序需要的
// 字段，不再拼装解析、调度或缓存写入细节。
// 接口约定：唯一入口 refresh(field, mode)，声明一个当前排序需要的字段
// 并返回前台调度任务（无 HTTP adapter，或调度器已停止且无在跑任务、
// 待请求为空时返回 null）。调用顺序不限：新字段声明的待请求好友优先
// 合并进运行中的主页任务，同一好友在整个任务内最多请求一次。不变量：
// 一次响应服务全部字段，只有解析成功的字段写入缓存，缺失或无效字段
// 不覆盖旧值。错误模式：单好友请求失败只计入该次任务的失败统计，
// 不影响缓存既有记录；缓存批次生命周期由 createCacheBatchLifecycle
// 桥接，本模块不接触持久化细节。
const PROFILE_TASK_TYPE = "profile";
const PROFILE_FIELD_GROUP_LABELS = Object.freeze({
  [SORT.COMPLETION]: "完成条目数",
  [SORT.RELATION]: "喜好契合",
});

function profileFieldLabelFor(field) {
  return PROFILE_FIELD_GROUP_LABELS[field?.kind] ?? "";
}

function createProfileFieldTasks({
  applySort,
  cache,
  confirmRequest,
  friends,
  http,
  onProgress,
  scheduler,
  status,
  visitorIdentifier,
}) {
  const progressReporter = createTaskProgressReporter({
    onProgress,
    status,
    taskType: PROFILE_TASK_TYPE,
    messageFor: ({ completed, target, total }) =>
      `正在获取“${profileFieldLabelFor(target)}” ${completed}/${total}`,
  });

  // 字段形状沿用 REMOTE_TARGET_SELECTION_KEYS 的统一映射：完成统计
  // 范围按 scope 定位结果，契合指标按 metric 定位；只有契合指标按访
  // 问者隔离，缓存的新鲜度边界需要完整的访问者目标。
  function cacheTargetFor(field) {
    return REMOTE_TARGET_SELECTION_KEYS[field.kind] === "metric"
      ? { ...field, visitorIdentifier }
      : field;
  }

  // 按声明字段分别判定成功：请求失败、主页无效、该字段缺失或无效都算
  // 失败；字段解析成功则算成功，即使请求最初由另一个字段加入。
  function isFieldSuccess(record, outcome, field) {
    const selectionKey = REMOTE_TARGET_SELECTION_KEYS[field.kind];
    return (
      outcome.kind === "success" &&
      record?.fields?.[field.kind]?.[field[selectionKey]]?.kind === "success"
    );
  }

  // 一次响应服务全部字段：解析成功的字段结果交给好友缓存批次；缺失或
  // 无效的字段不写入缓存，因此不会覆盖仍有效的旧值。
  function cacheResultFor(record) {
    const result = { fetchedAt: record.fetchedAt };
    for (const [kind, outcomes] of Object.entries(record.fields)) {
      const values = successfulOutcomeValues(outcomes);
      if (Object.keys(values).length > 0) result[kind] = values;
    }
    return result;
  }

  const lifecycle = createCacheBatchLifecycle({
    applySort,
    cache,
    labelFor: profileFieldLabelFor,
    progressReporter,
    projectResult: cacheResultFor,
    status,
    taskType: PROFILE_TASK_TYPE,
    visitorIdentifier,
  });

  // 声明一个当前排序需要的主页字段：按字段判断待请求好友，合并进运行
  // 中的主页任务或创建新任务。同一好友在整个任务内最多请求一次，而一
  // 次响应解析全部八个字段，因此已排队和在途好友天然服务新增字段需求。
  function refresh(field, mode = "incremental") {
    return startForegroundTask({
      confirmRequest,
      fetch: http && ((friend) => http.fetchProfile(friend)),
      isSuccess: isFieldSuccess,
      keyFor: userIdentifierFor,
      lifecycle,
      pending: cache.friendsNeedingRefresh(friends, cacheTargetFor(field), {
        mode,
      }),
      scheduler,
      target: field,
      taskType: PROFILE_TASK_TYPE,
    });
  }

  return { refresh };
}

export { createProfileFieldTasks };
