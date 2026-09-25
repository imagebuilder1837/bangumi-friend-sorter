// src/session.mjs — sort session orchestration.
import {
  SORT,
  DIRECTION,
  COMPLETION_SCOPE,
  SORT_CHOICES,
  RELATION_CHOICES,
  COMPLETION_CHOICES,
  REFRESH_STATUS,
} from "./choices.mjs";
import { SORT_CONFIG, defaultDirectionFor, sortFriends } from "./sorting.mjs";
import { userIdentifierFor } from "./identity.mjs";
import {
  remoteTargetFor,
  sameRemoteTarget,
  nextRemoteSelectionAction,
} from "./remote-selection.mjs";
import { createTaskScheduler } from "./scheduler.mjs";
import { createStatusController } from "./status.mjs";
import {
  createCacheBatchLifecycle,
  createTaskProgressReporter,
  startForegroundTask,
} from "./refresh.mjs";
import { createProfileFieldTasks } from "./profile-tasks.mjs";
import { createTietieTasks } from "./tietie-tasks.mjs";

// 远程排序会话 deep module：页面初始化后的最高层业务边界。会话只通过
// start、choose 与 changeDirection 接收外部命令；内部私有状态机与任务
// 登记表共同拥有当前排序目标、子选项、方向记忆、增量刷新、连续两次选
// 择触发的全量刷新、登录前置条件、请求先后关系与提示优先级，并编排好
// 友缓存、活跃任务、主页字段任务、排序函数与排序栏。任务登记表、状态
// 机与排序栏内部节点均不向外暴露。
// 接口约定：start 必须最先调用且恰好一次（重复启动抛错），它按网页
// 默认顺序完成首次呈现；此后 choose 与 changeDirection 是仅有的排序
// 命令入口，未知目标、子选项或方向立即抛错（programmer error），不
// 修改任何状态。不变量：展示顺序只在排序输入（目标、方向、子选项）
// 或条件重排后变化，状态提示等纯呈现更新复用上一次排序结果；任务
// 结束后只有目标仍是当前目标时才重排，迟到结果不覆盖已切换的选择。
// 错误模式：远程目标缺少登录访客标识时不抛错，转入登录前置提示；
// 调度器已停止或无待请求好友的刷新静默忽略，返回 null。
function choiceLabelFor(choices, value) {
  return choices.find(([choiceValue]) => choiceValue === value)?.[1] || value;
}

function createFriendSortSession({
  cache,
  collator,
  friends,
  http,
  now,
  pageWindow,
  runtime,
  sortBar,
  visitorIdentifier,
}) {
  // ---- 私有任务登记表：调度器、状态提示与两类页面任务的生命周期。 ----
  const ACTIVITY_TASK_TYPE = "activity";
  const scheduler = createTaskScheduler({ concurrency: 4 });
  const status = createStatusController({
    clearTimeout: runtime.clearTimeout ?? globalThis.clearTimeout,
    now,
    present: presentStatus,
    scheduler,
    setTimeout: runtime.setTimeout ?? globalThis.setTimeout,
  });
  const confirmRequest =
    runtime.confirm ?? pageWindow.confirm?.bind(pageWindow) ?? (() => false);
  let tietieResult = null;

  const showActivityProgress = createTaskProgressReporter({
    onProgress: runtime.onProgress,
    status,
    taskType: ACTIVITY_TASK_TYPE,
    messageFor: ({ completed, total }) =>
      `正在获取“上次活跃” ${completed}/${total}`,
  });

  // 刷新任务结束后只在相关目标仍是当前目标时重排：旧任务的迟到结果不
  // 覆盖切换后的排序选择。
  function applyActivitySort() {
    if (currentCriterion === SORT.ACTIVITY) applyCurrentSort();
  }

  function applyProfileSort() {
    if (
      currentCriterion === SORT.RELATION ||
      currentCriterion === SORT.COMPLETION
    ) {
      applyCurrentSort();
    }
  }

  const activityLifecycle = createCacheBatchLifecycle({
    applySort: applyActivitySort,
    cache,
    labelFor: () => "上次活跃",
    progressReporter: showActivityProgress,
    projectResult: (activity) => ({ activity }),
    status,
    taskType: ACTIVITY_TASK_TYPE,
  });

  const profileFields = createProfileFieldTasks({
    applySort: applyProfileSort,
    cache,
    confirmRequest,
    friends,
    http,
    onProgress: runtime.onProgress,
    scheduler,
    status,
    visitorIdentifier,
  });

  function applyTietieSort() {
    if (currentCriterion === SORT.TIETIE) applyCurrentSort();
  }

  const tietieTasks = createTietieTasks({
    applySort: applyTietieSort,
    cache,
    http,
    now,
    onProgress: runtime.onProgress,
    publishResult: (result) => {
      tietieResult = result;
    },
    scheduler,
    status,
    visitorIdentifier,
  });

  function startActivity(target, mode) {
    return startForegroundTask({
      confirmRequest,
      fetch: http && ((friend) => http.fetchActivity(friend)),
      keyFor: userIdentifierFor,
      lifecycle: activityLifecycle,
      pending: cache.friendsNeedingRefresh(
        friends,
        { kind: SORT.ACTIVITY },
        { mode },
      ),
      scheduler,
      target,
      taskType: ACTIVITY_TASK_TYPE,
    });
  }

  // ---- 私有选择状态机：当前目标、子选项、方向与展示顺序。 ----
  let currentCriterion = SORT.ADDED;
  let completionScope = COMPLETION_SCOPE.ALL;
  let relationMetric = RELATION_CHOICES[0][0];
  let statusMessage = "";
  let started = false;
  const directionByCriterion = new Map(
    [
      ...SORT_CHOICES.map(([criterion]) => criterion),
      SORT.COMPLETION,
      SORT.RELATION,
    ].map((criterion) => [criterion, defaultDirectionFor(criterion)]),
  );

  // 展示顺序只在排序输入（目标、方向、子选项）或条件重排后变化：
  // 状态提示等纯呈现变化复用上一次结果，避免每次提示都重排好友列表。
  let lastSortKey = null;
  // 每次重排都以紧邻此前的展示顺序为输入；首次输入就是网页默认顺序。
  let lastOrderedFriends = [...friends];

  function selectionFor(criterion) {
    if (criterion === SORT.RELATION) return relationMetric;
    if (criterion === SORT.COMPLETION) return completionScope;
    return COMPLETION_SCOPE.ALL;
  }

  function currentOrder() {
    const direction = directionByCriterion.get(currentCriterion);
    const key = `${currentCriterion}|${direction}|${completionScope}|${relationMetric}`;
    if (lastSortKey !== key) {
      lastSortKey = key;
      lastOrderedFriends = sortFriends(lastOrderedFriends, {
        criterion: currentCriterion,
        friendCache: cache,
        collator,
        direction,
        completionScope,
        relationSelection: {
          metric: relationMetric,
          visitorIdentifier,
        },
        tietieResult,
      });
    }
    return lastOrderedFriends;
  }

  // 唯一的渲染过程：重排结果与当前呈现状态一次性交给排序栏投影。
  function render() {
    sortBar.render({
      criterion: currentCriterion,
      direction: directionByCriterion.get(currentCriterion),
      orderedFriends: currentOrder(),
      selection: selectionFor(currentCriterion),
      statusMessage,
    });
  }

  // 排序输入或缓存结果变化后的重排入口：强制重新计算展示顺序。
  function applyCurrentSort() {
    lastSortKey = null;
    render();
  }

  // 刷新任务的最终提示文本从这里进入同一渲染过程。
  function presentStatus(message) {
    if (message === statusMessage) return;
    statusMessage = message;
    render();
  }

  function showLoginRequiredStatus(label) {
    if (status.getKind() === REFRESH_STATUS.LOGIN_REQUIRED) return;
    status.set(
      REFRESH_STATUS.LOGIN_REQUIRED,
      `请登录后使用${label}排序`,
      5_000,
    );
  }

  function cachedTietieResult() {
    const cached = cache.tietieFor(visitorIdentifier);
    return cached ? { complete: true, ...cached } : null;
  }

  const remoteTargetConfigurations = {
    [SORT.ACTIVITY]: {
      armMessageFor: () => "上次活跃",
      requiresVisitor: false,
      startRefresh: (target, mode) => startActivity(target, mode),
    },
    [SORT.RELATION]: {
      armMessageFor: (selection) => choiceLabelFor(RELATION_CHOICES, selection),
      defaultSelection: RELATION_CHOICES[0][0],
      loginLabel: "喜好契合",
      requiresVisitor: true,
      selections: RELATION_CHOICES.map(([value]) => value),
      setSelection: (selection) => {
        relationMetric = selection;
      },
      startRefresh: (target, mode) => profileFields.refresh(target, mode),
    },
    [SORT.TIETIE]: {
      armMessageFor: () => "和我贴贴",
      loginLabel: "和我贴贴",
      requiresVisitor: true,
      startRefresh: (_target, mode) => tietieTasks.refresh(mode),
    },
    [SORT.COMPLETION]: {
      armMessageFor: (selection) =>
        choiceLabelFor(COMPLETION_CHOICES, selection),
      defaultSelection: COMPLETION_SCOPE.ALL,
      requiresVisitor: false,
      selections: COMPLETION_CHOICES.map(([value]) => value),
      setSelection: (selection) => {
        completionScope = selection;
      },
      startRefresh: (target, mode) => profileFields.refresh(target, mode),
    },
  };

  function selectRemoteCriterion(
    criterion,
    configuration,
    requestedSubcriterion,
  ) {
    // Only dropdown criteria (relation/completion) carry a selection;
    // activity's target shape drops it, so no placeholder fallback here.
    const selection = requestedSubcriterion ?? configuration.defaultSelection;
    const currentTarget = remoteTargetFor(
      currentCriterion,
      selectionFor(currentCriterion),
    );
    const requestedTarget = remoteTargetFor(criterion, selection);
    if (
      configuration.requiresVisitor &&
      sameRemoteTarget(currentTarget, requestedTarget) &&
      !visitorIdentifier
    ) {
      showLoginRequiredStatus(
        configuration.loginLabel ?? configuration.armMessageFor(selection),
      );
      return;
    }

    const action = nextRemoteSelectionAction(
      currentTarget,
      requestedTarget,
      status.getKind(),
    );
    if (action.kind === "ignore") return;
    if (action.clearPrompt) status.clear();
    if (action.kind === "arm") {
      status.set(
        REFRESH_STATUS.AWAITING_FULL_REFRESH,
        `5 秒内再次点击“${configuration.armMessageFor(selection)}”以全量刷新`,
        5_000,
      );
      return;
    }

    configuration.setSelection?.(selection);
    currentCriterion = criterion;
    if (criterion === SORT.TIETIE) {
      tietieResult = visitorIdentifier ? cachedTietieResult() : null;
    }
    applyCurrentSort();

    if (!action.refreshMode) return;
    if (configuration.requiresVisitor && !visitorIdentifier) {
      showLoginRequiredStatus(
        configuration.loginLabel ?? configuration.armMessageFor(selection),
      );
      return;
    }
    configuration.startRefresh(requestedTarget, action.refreshMode);
  }

  function selectLocalCriterion(criterion) {
    // 本地标准（加好友时间/名称）没有远程目标，不走刷新状态机；
    // 切换时只需清掉可能挂起的全量刷新提示。
    if (status.getKind() === REFRESH_STATUS.AWAITING_FULL_REFRESH)
      status.clear();

    currentCriterion = criterion;
    applyCurrentSort();
  }

  // 会话唯一的排序选择入口：本地目标只更新选择并重排，远程目标按既有
  // 状态优先级决定增量刷新、全量待命、全量刷新或忽略。
  function choose(criterion, requestedSubcriterion) {
    if (!SORT_CONFIG[criterion]) {
      throw new Error(`未知的排序目标：${criterion}`);
    }
    const configuration = remoteTargetConfigurations[criterion];
    if (configuration) {
      if (
        requestedSubcriterion != null &&
        (!configuration.selections ||
          !configuration.selections.includes(requestedSubcriterion))
      ) {
        throw new Error(`未知的排序子选项：${requestedSubcriterion}`);
      }
      selectRemoteCriterion(criterion, configuration, requestedSubcriterion);
      return;
    }
    selectLocalCriterion(criterion);
  }

  function changeDirection(direction) {
    if (
      direction !== DIRECTION.ASCENDING &&
      direction !== DIRECTION.DESCENDING
    ) {
      throw new Error(`未知的排序方向：${direction}`);
    }
    if (directionByCriterion.get(currentCriterion) === direction) return;

    directionByCriterion.set(currentCriterion, direction);
    applyCurrentSort();
  }

  // 启动会话：按网页默认顺序呈现首个名次；重复启动是 programmer error。
  function start() {
    if (started) throw new Error("远程排序会话只能启动一次");
    started = true;
    render();
  }

  return { start, choose, changeDirection };
}

export { createFriendSortSession };
