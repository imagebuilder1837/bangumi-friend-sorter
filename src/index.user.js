// ==UserScript==
// @name         Bangumi 好友排序
// @namespace    https://github.com/imagebuilder1837/bangumi-friend-sorter
// @version      0.1.5
// @description  为好友/反向好友页增加多种排序方式。
// @author       imagebuilder1837
// @match        https://bgm.tv/user/*/friends
// @match        https://bgm.tv/user/*/rev_friends
// @match        https://bangumi.tv/user/*/friends
// @match        https://bangumi.tv/user/*/rev_friends
// @match        https://chii.in/user/*/friends
// @match        https://chii.in/user/*/rev_friends
// @run-at       document-end
// @grant        none
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/imagebuilder1837/bangumi-friend-sorter/refs/heads/main/src/index.user.js
// @updateURL    https://raw.githubusercontent.com/imagebuilder1837/bangumi-friend-sorter/refs/heads/main/src/index.user.js
// ==/UserScript==

(function () {
  "use strict";

  const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
  // Completion counts and relation metrics both come from profile pages and
  // share one validity window, so the TTL is named after the source.
  const PROFILE_CACHE_TTL_MS = 72 * 60 * 60 * 1_000;
  const PAGE_REQUEST_TIMEOUT_MS = 15_000;
  const SITE_OFFSET_SECONDS = 8 * 60 * 60;
  // The v3 store holds activity, visitor-nested relation and completion
  // fields, but the storage key keeps its historical "activity-cache" name:
  // renaming it would strand every existing visitor's v3 payload.
  const FRIEND_CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v3";
  const PREVIOUS_CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v2";
  const LEGACY_CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v1";
  const SORT = Object.freeze({
    ACTIVITY: "activity",
    ADDED: "added",
    COMPLETION: "completion",
    NAME: "name",
    RELATION: "relation",
  });
  const COMPLETION_SCOPE = Object.freeze({
    ALL: "all",
    ANIMATION: "2",
    BOOK: "1",
    MUSIC: "3",
    GAME: "4",
    REAL_LIFE: "6",
  });
  const DIRECTION = Object.freeze({
    ASCENDING: "asc",
    DESCENDING: "desc",
  });
  const REFRESH_STATUS = Object.freeze({
    COMPLETED: "completed",
    FETCHING: "fetching",
    IDLE: "idle",
    // 两阶段全量刷新的待命状态：提示再次点击以全量刷新，5 秒后自动清除。
    AWAITING_FULL_REFRESH: "armed",
    LOGIN_REQUIRED: "login",
  });
  const SORT_CHOICES = [
    [SORT.ADDED, "加好友时间"],
    [SORT.NAME, "名称"],
    [SORT.ACTIVITY, "上次活跃"],
  ];
  const COMPLETION_CHOICES = [
    [COMPLETION_SCOPE.ALL, "全部"],
    [COMPLETION_SCOPE.ANIMATION, "动画"],
    [COMPLETION_SCOPE.BOOK, "书籍"],
    [COMPLETION_SCOPE.MUSIC, "音乐"],
    [COMPLETION_SCOPE.GAME, "游戏"],
    [COMPLETION_SCOPE.REAL_LIFE, "三次元"],
  ];
  const COMPLETION_CACHE_FIELD_PREFIX = "completion_";

  // Normalizes a friend record to its stable cache and sort identity:
  // only a non-empty string identifier counts (see CONTEXT.md, 用户标识).
  function userIdentifierFor(friend) {
    const identifier = friend?.userIdentifier;
    return typeof identifier === "string" && identifier ? identifier : null;
  }

  const RELATION_CHOICES = [
    ["syncRate", "同步率"],
    ["commonLikes", "共同喜好数"],
  ];
  const RELATION_METRICS = new Set(RELATION_CHOICES.map(([metric]) => metric));

  function isRelationMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    return Object.values(value).every((metrics) =>
      Object.entries(metrics || {}).every(
        ([metric, record]) =>
          RELATION_METRICS.has(metric) && isRelationRecord(record, metric),
      ),
    );
  }

  function isActivityRecord(value) {
    if (!value || !Number.isFinite(value.fetchedAt)) return false;
    if (value.kind === "empty") return true;
    return value.kind === "active" && Number.isInteger(value.activityAtSeconds);
  }

  function completionFieldFor(scope) {
    return `${COMPLETION_CACHE_FIELD_PREFIX}${scope}`;
  }

  function isCompletionRecord(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      Number.isSafeInteger(value.value) &&
      value.value >= 0 &&
      Number.isFinite(value.fetchedAt),
    );
  }

  // The record envelope (finite value + fetch time) is shared; each 契合指标
  // only constrains its own value, so the metric branch lives in this table.
  const RELATION_VALUE_VALIDATORS = Object.freeze({
    commonLikes: (value) => Number.isInteger(value) && value >= 0,
    syncRate: Number.isFinite,
  });

  function isRelationRecord(value, metric) {
    return Boolean(
      value &&
      typeof value === "object" &&
      Number.isFinite(value.fetchedAt) &&
      RELATION_VALUE_VALIDATORS[metric]?.(value.value),
    );
  }

  // The fields this cache persists are fixed (activity, visitor-nested
  // relation, per-scope completion), so the validators are built in rather
  // than taken from callers.
  function completionCacheFieldValidators() {
    return Object.fromEntries(
      COMPLETION_CHOICES.map(([scope]) => [
        completionFieldFor(scope),
        isCompletionRecord,
      ]),
    );
  }

  function compareReliableNumbers(
    left,
    right,
    { isAscending, leftValue, rightValue },
  ) {
    const leftHasValue = Number.isFinite(leftValue);
    const rightHasValue = Number.isFinite(rightValue);

    if (leftHasValue && rightHasValue) {
      const valueComparison =
        leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      return (
        valueComparison * (isAscending ? 1 : -1) ||
        left.originalIndex - right.originalIndex
      );
    }
    if (leftHasValue) return -1;
    if (rightHasValue) return 1;
    return left.originalIndex - right.originalIndex;
  }

  // 上次活跃, 完成条目数 and 喜好契合 all rank by a reliable numeric value:
  // each sort only declares how to read one side's value.
  function numericValueCompare(readValue) {
    return (left, right, context) =>
      compareReliableNumbers(left, right, {
        isAscending: context.isAscending,
        leftValue: readValue(left, context),
        rightValue: readValue(right, context),
      });
  }

  const SORT_CONFIG = Object.freeze({
    [SORT.ADDED]: {
      defaultDirection: DIRECTION.ASCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "从旧到新",
        [DIRECTION.DESCENDING]: "从新到旧",
      }),
      compare(left, right, { isAscending }) {
        return (
          (left.originalIndex - right.originalIndex) * (isAscending ? 1 : -1)
        );
      },
    },
    [SORT.NAME]: {
      defaultDirection: DIRECTION.ASCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "升序",
        [DIRECTION.DESCENDING]: "降序",
      }),
      compare(left, right, { collator, isAscending }) {
        return (
          (isAscending ? 1 : -1) *
          (collator.compare(left.displayName, right.displayName) ||
            collator.compare(userIdentifierFor(left), userIdentifierFor(right)))
        );
      },
    },
    [SORT.ACTIVITY]: {
      defaultDirection: DIRECTION.DESCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "从旧到新",
        [DIRECTION.DESCENDING]: "从新到旧",
      }),
      compare: numericValueCompare((friend, { friendCache }) => {
        const activity = friendCache.getField(
          userIdentifierFor(friend),
          "activity",
        );
        return activity?.kind === "active" ? activity.activityAtSeconds : null;
      }),
    },
    [SORT.COMPLETION]: {
      defaultDirection: DIRECTION.DESCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "从低到高",
        [DIRECTION.DESCENDING]: "从高到低",
      }),
      compare: numericValueCompare(
        (friend, { completionScope, friendCache }) => {
          const completion = friendCache.getField(
            userIdentifierFor(friend),
            completionFieldFor(completionScope),
          );
          return isCompletionRecord(completion) ? completion.value : null;
        },
      ),
    },
    [SORT.RELATION]: {
      defaultDirection: DIRECTION.DESCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "从低到高",
        [DIRECTION.DESCENDING]: "从高到低",
      }),
      compare: numericValueCompare(
        (friend, { relationSelection, friendCache }) => {
          const relation = friendCache.getRelationField(
            userIdentifierFor(friend),
            relationSelection,
          );
          return isRelationRecord(relation, relationSelection.metric)
            ? relation.value
            : null;
        },
      ),
    },
  });
  // SORT is a closed enum: every criterion above declares a config, so these
  // readers index directly and an unknown criterion surfaces immediately.
  function directionLabelsFor(criterion) {
    return { ...SORT_CONFIG[criterion].directionLabels };
  }

  function defaultDirectionFor(criterion) {
    return SORT_CONFIG[criterion].defaultDirection;
  }

  function isAscendingDirection(direction, criterion) {
    const effectiveDirection = direction || defaultDirectionFor(criterion);
    return effectiveDirection === DIRECTION.ASCENDING;
  }

  function createFriendCache(storage, { now = Date.now } = {}) {
    const records = new Map();
    const validators = new Map([
      ["activity", isActivityRecord],
      ["relation", isRelationMap],
      ...Object.entries(completionCacheFieldValidators()),
    ]);

    function read(key) {
      try {
        const value = storage?.getItem?.(key);
        return JSON.parse(value || "null");
      } catch {
        return null;
      }
    }

    function remove(key) {
      try {
        storage?.removeItem?.(key);
      } catch {
        // Removing obsolete data is best effort.
      }
    }

    function validatorFor(field) {
      return validators.get(field) || null;
    }

    function validateFields(value) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return {};

      const fields = {};
      for (const [field, fieldValue] of Object.entries(value)) {
        const validator = validatorFor(field);
        if (typeof validator === "function" && validator(fieldValue)) {
          fields[field] = fieldValue;
        }
      }
      return fields;
    }

    function loadFields(saved) {
      if (
        saved?.version !== 3 ||
        !saved.records ||
        typeof saved.records !== "object" ||
        Array.isArray(saved.records)
      ) {
        return false;
      }

      for (const [userIdentifier, value] of Object.entries(saved.records)) {
        const fields = validateFields(value);
        if (Object.keys(fields).length > 0) records.set(userIdentifier, fields);
      }
      return true;
    }

    function persist() {
      try {
        if (!storage?.setItem) return false;
        storage.setItem(
          FRIEND_CACHE_STORAGE_KEY,
          JSON.stringify({ version: 3, records: Object.fromEntries(records) }),
        );
        return true;
      } catch {
        // Keep newly written records in memory when persistence is unavailable.
        return false;
      }
    }

    const hasCurrentCache = loadFields(read(FRIEND_CACHE_STORAGE_KEY));
    const previous = read(PREVIOUS_CACHE_STORAGE_KEY);
    if (
      previous?.version === 2 &&
      previous.records &&
      typeof previous.records === "object" &&
      !Array.isArray(previous.records)
    ) {
      const migrationNow = now();
      let migrated = false;
      for (const [userIdentifier, record] of Object.entries(previous.records)) {
        if (
          validators.get("activity")?.(record) &&
          Number.isFinite(migrationNow) &&
          migrationNow - record.fetchedAt <= CACHE_TTL_MS &&
          !records.get(userIdentifier)?.activity
        ) {
          records.set(userIdentifier, {
            ...records.get(userIdentifier),
            activity: record,
          });
          migrated = true;
        }
      }
      if (migrated) {
        if (persist()) remove(PREVIOUS_CACHE_STORAGE_KEY);
      } else if (hasCurrentCache) {
        remove(PREVIOUS_CACHE_STORAGE_KEY);
      } else if (persist()) {
        remove(PREVIOUS_CACHE_STORAGE_KEY);
      }
    }

    remove(LEGACY_CACHE_STORAGE_KEY);

    return {
      entries: () => records.entries(),
      get: (userIdentifier) => records.get(userIdentifier),
      getField(userIdentifier, field) {
        return records.get(userIdentifier)?.[field];
      },
      getRelationField(userIdentifier, relationSelection) {
        const { metric, visitorIdentifier } = relationSelection ?? {};
        return records.get(userIdentifier)?.relation?.[visitorIdentifier]?.[
          metric
        ];
      },
      persist,
      // Task batches pass { persist: false } per field and persist once
      // when the task finishes; direct writers keep the persisting default.
      setField(
        userIdentifier,
        field,
        value,
        { persist: shouldPersist = true } = {},
      ) {
        const validator = validatorFor(field);
        if (typeof validator !== "function" || !validator(value)) {
          return this;
        }
        const fields = records.get(userIdentifier) || {};
        fields[field] = value;
        records.set(userIdentifier, fields);
        if (shouldPersist) persist();
        return this;
      },
      setRelationField(
        userIdentifier,
        visitorIdentifier,
        metric,
        value,
        { persist: shouldPersist = true } = {},
      ) {
        if (!visitorIdentifier || !isRelationRecord(value, metric)) {
          return this;
        }
        const fields = records.get(userIdentifier) || {};
        records.set(userIdentifier, {
          ...fields,
          relation: {
            ...fields.relation,
            [visitorIdentifier]: {
              ...fields.relation?.[visitorIdentifier],
              [metric]: value,
            },
          },
        });
        if (shouldPersist) persist();
        return this;
      },
    };
  }

  function relationSelectionFor(relationSelection) {
    return { metric: RELATION_CHOICES[0][0], ...relationSelection };
  }

  function sortFriends(
    friends,
    {
      criterion,
      // Required for the remote sorts (activity/completion/relation); local
      // sorts (added/name) never touch the friend cache.
      friendCache,
      collator = new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: "base",
      }),
      direction,
      completionScope = COMPLETION_SCOPE.ALL,
      relationSelection,
    } = {},
  ) {
    const sorted = [...friends];
    const isAscending = isAscendingDirection(direction, criterion);

    const sortConfig = SORT_CONFIG[criterion];
    if (sortConfig?.compare) {
      // Each compare destructures only the context slice it sorts by; the
      // visitor-scoped relation parts travel together as one selection.
      sorted.sort((left, right) =>
        sortConfig.compare(left, right, {
          collator,
          completionScope,
          isAscending,
          relationSelection: relationSelectionFor(relationSelection),
          friendCache,
        }),
      );
    }

    return sorted;
  }

  // 增量刷新的统一判据：字段缺失，或距上次获取已超过其来源的有效期。
  function findFriendsNeedingField(friends, getField, ttlMs, now) {
    return friends.filter((friend) => {
      const field = getField(userIdentifierFor(friend));
      return !field || now - field.fetchedAt > ttlMs;
    });
  }

  function findFriendsNeedingActivity(friends, activityByUser, now) {
    return findFriendsNeedingField(
      friends,
      (userIdentifier) => activityByUser.getField(userIdentifier, "activity"),
      CACHE_TTL_MS,
      now,
    );
  }

  // Remote targets are one shape apart from a single selection field:
  // completion carries a 统计范围 `scope`, relation a 契合指标 `metric`,
  // and activity carries none. remoteTargetFor and sameRemoteTarget both
  // read this mapping so the target shape lives in one place.
  const REMOTE_TARGET_SELECTION_KEYS = Object.freeze({
    [SORT.ACTIVITY]: null,
    [SORT.COMPLETION]: "scope",
    [SORT.RELATION]: "metric",
  });

  function remoteTargetFor(criterion, selection) {
    const selectionKey = REMOTE_TARGET_SELECTION_KEYS[criterion];
    if (selectionKey === undefined) return null;
    return {
      kind: criterion,
      ...(selectionKey ? { [selectionKey]: selection } : {}),
    };
  }

  function sameRemoteTarget(left, right) {
    if (left === right) return true;
    if (!left || !right || left.kind !== right.kind) return false;
    const selectionKey = REMOTE_TARGET_SELECTION_KEYS[left.kind];
    return !selectionKey || left[selectionKey] === right[selectionKey];
  }

  function nextRemoteSelectionAction(
    currentTarget,
    requestedTarget,
    statusKind,
  ) {
    const clearPrompt = statusKind === REFRESH_STATUS.AWAITING_FULL_REFRESH;
    const selectAction = (refreshMode = null) => ({
      kind: "select",
      clearPrompt,
      refreshMode,
    });

    if (requestedTarget === null) return selectAction();
    if (!sameRemoteTarget(currentTarget, requestedTarget)) {
      return selectAction("incremental");
    }
    if (statusKind === REFRESH_STATUS.IDLE) {
      return { kind: "arm", clearPrompt: false, refreshMode: null };
    }
    if (statusKind === REFRESH_STATUS.AWAITING_FULL_REFRESH) {
      return {
        kind: "refresh",
        clearPrompt: true,
        refreshMode: "full",
      };
    }
    // The caller bails out on "ignore" without reading any other field.
    return { kind: "ignore" };
  }

  function siteDateFromEpochSeconds(epochSeconds) {
    return new Date((epochSeconds + SITE_OFFSET_SECONDS) * 1_000);
  }

  function parseSiteTimestampParts(value) {
    const match =
      /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
        value || "",
      );
    if (!match) return null;

    const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
      match;
    const [year, month, day, hour, minute] = [
      yearText,
      monthText,
      dayText,
      hourText,
      minuteText,
    ].map(Number);
    const second = secondText === undefined ? 0 : Number(secondText);
    const parsedSeconds =
      Date.UTC(year, month - 1, day, hour, minute, second) / 1_000 -
      SITE_OFFSET_SECONDS;
    const parsed = siteDateFromEpochSeconds(parsedSeconds);
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day ||
      parsed.getUTCHours() !== hour ||
      parsed.getUTCMinutes() !== minute ||
      parsed.getUTCSeconds() !== second
    ) {
      return null;
    }
    return {
      day,
      epochSeconds: parsedSeconds,
      hasExplicitSeconds: secondText !== undefined,
      hour,
      minute,
      month,
      second,
      year,
    };
  }

  function parseRelativeTime(value) {
    const text = (value || "").trim();
    if (text === "刚刚") return { totalSeconds: 0 };
    if (!text.endsWith("前")) return null;

    const body = text.slice(0, -1);
    const unitRanks = { 年: 5, 月: 4, 天: 3, 小时: 2, 分: 1, 分钟: 1, 秒: 0 };
    const tokens = [];
    const tokenPattern = /(\d+)(年|月|天|小时|分(?:钟)?|秒)/g;
    let cursor = 0;
    let match;
    while ((match = tokenPattern.exec(body))) {
      if (match.index !== cursor) return null;
      tokens.push({
        amount: Number(match[1]),
        rank: unitRanks[match[2]],
        // 分钟 and 分 are the same relative unit; normalize so the
        // second-recovery checks below only need the canonical names.
        unit: match[2] === "分钟" ? "分" : match[2],
      });
      cursor = tokenPattern.lastIndex;
    }
    if (cursor !== body.length || tokens.length < 1 || tokens.length > 2)
      return null;
    if (tokens.length === 2 && tokens[1].rank !== tokens[0].rank - 1)
      return null;

    const hasExplicitSeconds = tokens.some(({ unit }) => unit === "秒");
    const totalSeconds =
      hasExplicitSeconds &&
      tokens.every(({ unit }) => unit === "分" || unit === "秒")
        ? tokens.reduce(
            (total, token) =>
              total + token.amount * (token.unit === "分" ? 60 : 1),
            0,
          )
        : null;
    return { totalSeconds };
  }

  function matchesSiteMinute(epochSeconds, timestampParts) {
    const siteDate = siteDateFromEpochSeconds(epochSeconds);
    return (
      siteDate.getUTCFullYear() === timestampParts.year &&
      siteDate.getUTCMonth() === timestampParts.month - 1 &&
      siteDate.getUTCDate() === timestampParts.day &&
      siteDate.getUTCHours() === timestampParts.hour &&
      siteDate.getUTCMinutes() === timestampParts.minute
    );
  }

  function parseTimelineDocument(document, referenceAtSeconds) {
    const tabs = document.querySelector("#timelineTabs");
    const timeline = document.querySelector("#tmlContent > #timeline");
    if (!tabs || !timeline) return { kind: "invalid" };

    const firstItem = timeline?.querySelector(".tml_item");
    if (!firstItem) {
      return timeline.textContent.trim() === ""
        ? { kind: "empty" }
        : { kind: "invalid" };
    }

    const timestampNode = firstItem?.querySelector(
      ".post_actions .titleTip[title]",
    );
    const timestamp = timestampNode?.getAttribute("title");
    const timestampParts = parseSiteTimestampParts(timestamp);
    let activityAtSeconds = timestampParts?.epochSeconds ?? null;

    if (
      activityAtSeconds !== null &&
      !timestampParts.hasExplicitSeconds &&
      Number.isFinite(referenceAtSeconds)
    ) {
      const relative = parseRelativeTime(timestampNode.textContent);
      if (
        relative?.totalSeconds !== null &&
        relative?.totalSeconds !== undefined
      ) {
        const inferred = Math.trunc(referenceAtSeconds) - relative.totalSeconds;
        if (matchesSiteMinute(inferred, timestampParts))
          activityAtSeconds = inferred;
      }
    }

    return activityAtSeconds === null
      ? { kind: "invalid" }
      : { kind: "active", activityAtSeconds };
  }

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
    // True once the designated foreground task has queued work: set when a
    // foreground enqueue is accepted, or when setForeground designates a task
    // that already exists. A designated foreground task without queued work
    // yet keeps background tasks idle so they cannot start before the
    // foreground task does.
    let foregroundHasQueuedWork = false;
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
      // Foreground task ended or not yet created, and the designated
      // foreground task has not queued work yet: hold background tasks back.
      if (foregroundType && !foreground && !foregroundHasQueuedWork) {
        return null;
      }
      return [...tasks.values()].find((task) => task.canSchedule()) || null;
    }

    function pump() {
      while (!globallyStopped && inFlight < maxConcurrency) {
        const task = runnableTask();
        if (!task) return;

        const item = task.take();
        if (!item) continue;
        inFlight += 1;
        task.begin(item);
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
      const keyFor = options.keyFor ?? ((item) => item);
      const confirmMessage = options.confirmMessage ?? (() => "");
      const isSuccess =
        options.isSuccess ?? ((record, outcome) => outcome.kind === "success");
      const lifecycle = options.lifecycle;
      const queue = [];
      const queuedKeys = new Set();
      const results = new Map();
      let completed = 0;
      let total = 0;
      let inFlightForTask = 0;
      let target = options.target ?? null;
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
        begin(item) {
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
            lifecycle.onSuccess?.(item, outcome.record, outcome);
          }
          results.set(keyFor(item), { item, outcome, record });
          batchState = nextBatchState(batchState, outcome);
          lifecycle.onProgress?.(progress());
          if (isRateLimited(outcome)) {
            const shouldNotify = !globallyStopped;
            stopAll();
            if (shouldNotify) lifecycle.onRateLimited?.({ item, target });
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
            !options.confirmRequest(confirmMessage(newItems.length, nextTarget))
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
            lifecycle.onQueue?.({ added: newItems.length, ...progress() });
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
        foregroundHasQueuedWork = true;
      } else if (added > 0 && type === foregroundType) {
        foregroundHasQueuedWork = true;
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
      setForeground(type) {
        foregroundType = type || null;
        foregroundHasQueuedWork = Boolean(
          foregroundType && tasks.has(foregroundType),
        );
        pump();
      },
      stopAll,
    };
  }

  function parseCompletionCount(block) {
    const descriptions = [...(block?.querySelectorAll?.(".desc") || [])];
    const completionDescriptions = descriptions.filter(
      (node) => node.textContent.trim() === "完成",
    );
    if (completionDescriptions.length !== 1) return null;
    const description = completionDescriptions[0];

    let card = description;
    while (card && card !== block) {
      const numberNodes = [...(card.querySelectorAll?.(".num") || [])];
      if (numberNodes.length > 1) return null;
      const numberNode = numberNodes[0];
      if (numberNode) {
        const text = numberNode.textContent.trim().replace(/,/g, "");
        if (!/^\d+$/.test(text)) return null;
        const value = Number(text);
        return Number.isSafeInteger(value) ? value : null;
      }
      card = card.parentElement;
    }
    return null;
  }

  // Reading a 完成统计范围 block is a three-way outcome: exactly one block,
  // no block at all, or an ambiguous duplicate set.
  function statsBlockFor(container, scope) {
    const blocks = [
      ...(container?.querySelectorAll?.(`#userStats_${scope}`) || []),
    ];
    if (blocks.length > 1) return { kind: "ambiguous" };
    return blocks[0]
      ? { block: blocks[0], kind: "found" }
      : { kind: "missing" };
  }

  function parseSyncRate(value) {
    const text = value?.textContent?.trim() || "";
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*%?$/.test(text)) {
      return null;
    }
    const parsed = Number(text.replace(/%\s*$/, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseCommonLikes(value) {
    const match = /(^|[^\d])([+-]?\d[\d,]*(?:\.\d+)?)\s*个共同喜好/.exec(
      value?.textContent || "",
    );
    if (!match) return null;
    const parsed = Number(match[2].replace(/,/g, ""));
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  function parseRelationValues(document) {
    const synchronize = document?.querySelector?.(".userSynchronize");
    if (!synchronize) return null;

    const values = {};
    const syncRate = parseSyncRate(
      synchronize.querySelector?.(".percent_text"),
    );
    if (syncRate !== null) values.syncRate = syncRate;
    const commonLikes = parseCommonLikes(synchronize);
    if (commonLikes !== null) values.commonLikes = commonLikes;
    return values;
  }

  function parseCompletionValues(document) {
    const container = document?.querySelector?.("#userStatsContainers");
    if (!container) return null;

    const childCount = container.children?.length ?? 0;
    if (childCount === 0 && container.textContent.trim() === "") {
      return Object.fromEntries(
        COMPLETION_CHOICES.map(([scope]) => [scope, 0]),
      );
    }

    const aggregate = statsBlockFor(container, COMPLETION_SCOPE.ALL);
    if (aggregate.kind !== "found") {
      return null;
    }
    const aggregateValue = parseCompletionCount(aggregate.block);
    if (aggregateValue === null) return null;

    const completionValues = { [COMPLETION_SCOPE.ALL]: aggregateValue };
    for (const [scope] of COMPLETION_CHOICES.slice(1)) {
      const stats = statsBlockFor(container, scope);
      if (stats.kind === "ambiguous") return null;
      if (stats.kind === "missing") {
        completionValues[scope] = 0;
        continue;
      }
      const value = parseCompletionCount(stats.block);
      if (value !== null) completionValues[scope] = value;
    }

    return completionValues;
  }

  function parseProfileDocument(document) {
    const completionValues = parseCompletionValues(document);
    const relation = parseRelationValues(document);
    if (!completionValues && relation === null) return { kind: "invalid" };

    const parsed = { kind: "success" };
    if (completionValues) parsed.completion = completionValues;
    if (relation !== null) parsed.parsedRelation = relation;
    return parsed;
  }

  function findFriendsNeedingCompletion(
    friends,
    completionByUser,
    scope = COMPLETION_SCOPE.ALL,
    now = Date.now(),
  ) {
    return findFriendsNeedingField(
      friends,
      (userIdentifier) =>
        completionByUser.getField(userIdentifier, completionFieldFor(scope)),
      PROFILE_CACHE_TTL_MS,
      now,
    );
  }

  function findFriendsNeedingRelation(
    friends,
    relationCache,
    relationSelection,
    now = Date.now(),
  ) {
    const selection = relationSelectionFor(relationSelection);
    return findFriendsNeedingField(
      friends,
      (userIdentifier) =>
        relationCache.getRelationField(userIdentifier, selection),
      PROFILE_CACHE_TTL_MS,
      now,
    );
  }

  const PROFILE_TARGET_POLICIES = Object.freeze({
    [SORT.COMPLETION]: Object.freeze({
      label: "完成条目数",
      hasTarget: (record, target) => {
        const value = record?.completion?.[target.scope];
        return Number.isSafeInteger(value) && value >= 0;
      },
      findPending: ({ cache, friends, now, target }) =>
        findFriendsNeedingCompletion(friends, cache, target.scope, now),
    }),
    [SORT.RELATION]: Object.freeze({
      label: "喜好契合",
      hasTarget: (record, target) => {
        const value = record?.parsedRelation?.[target.metric];
        return isRelationRecord(
          { value, fetchedAt: record?.fetchedAt },
          target.metric,
        );
      },
      findPending: ({ cache, friends, now, target, visitorIdentifier }) =>
        findFriendsNeedingRelation(
          friends,
          cache,
          { metric: target.metric, visitorIdentifier },
          now,
        ),
    }),
  });

  function profileTargetPolicyFor(target) {
    return PROFILE_TARGET_POLICIES[target?.kind] || null;
  }

  function positiveIntegerIdentifier(value) {
    const text = String(value ?? "").trim();
    if (!/^[1-9]\d*$/.test(text)) return null;
    return text;
  }

  function userIdentifierFromHref(href, baseUrl) {
    try {
      const pathname = new URL(href, baseUrl).pathname;
      const match = /^\/user\/([^/]+)\/?$/.exec(pathname);
      return match ? decodeURIComponent(match[1]) || null : null;
    } catch {
      return null;
    }
  }

  function currentVisitorIdentifier(pageDocument, pageWindow) {
    const uid = positiveIntegerIdentifier(pageWindow?.CHOBITS_UID);
    if (uid) return uid;

    const visitorIdentifierCandidate = pageWindow?.CHOBITS_USERNAME;
    if (
      typeof visitorIdentifierCandidate === "string" &&
      visitorIdentifierCandidate.trim()
    ) {
      return visitorIdentifierCandidate.trim();
    }

    const selectors = [
      "#headerNeue2 .idBadgerNeue a.avatar[href*='/user/']",
      "#headerNeue2 a.avatar[href*='/user/']",
      ".idBadgerNeue a.avatar[href*='/user/']",
    ];
    for (const selector of selectors) {
      let avatar;
      try {
        avatar = pageDocument?.querySelector?.(selector);
      } catch {
        continue;
      }
      const identifier = userIdentifierFromHref(
        avatar?.getAttribute?.("href"),
        pageWindow?.location?.href,
      );
      if (identifier) return identifier;
    }
    return null;
  }

  async function fetchPageWithTimeout(url, fetchImpl, parseResponse) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PAGE_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetchImpl(url, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) return { kind: "http-error", status: response.status };

      return await parseResponse(response);
    } catch {
      return { kind: "network-error" };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchProfile(friend, fetchImpl, domParser, now) {
    return fetchPageWithTimeout(
      `/user/${encodeURIComponent(userIdentifierFor(friend))}`,
      fetchImpl,
      async (response) => {
        const html = await response.text();
        const fetchedAt = now();
        const document = domParser.parseFromString(html, "text/html");
        const parsed = parseProfileDocument(document);
        if (parsed.kind === "invalid") return { kind: "parse-error" };
        const record = { fetchedAt };
        if (parsed.completion) record.completion = parsed.completion;
        if (parsed.parsedRelation) {
          record.parsedRelation = parsed.parsedRelation;
        }
        return { kind: "success", record };
      },
    );
  }

  // The parsed profile record's relation part is flat ({metric: value}); the
  // cache's relation field is nested by visitor. `parsedRelation` keeps the
  // two shapes apart.
  function saveProfileRecord(cache, visitorIdentifier, friend, record) {
    for (const [scope, value] of Object.entries(record.completion || {})) {
      cache.setField(
        userIdentifierFor(friend),
        completionFieldFor(scope),
        { value, fetchedAt: record.fetchedAt },
        { persist: false },
      );
    }
    if (!visitorIdentifier) return;
    for (const [metric, value] of Object.entries(record.parsedRelation || {})) {
      cache.setRelationField(
        userIdentifierFor(friend),
        visitorIdentifier,
        metric,
        { value, fetchedAt: record.fetchedAt },
        { persist: false },
      );
    }
  }

  function readFriends(list, baseUrl = window.location.href) {
    const elements = [...list.children];
    const friends = elements.map((element, originalIndex) => {
      const anchor = element.querySelector('a.avatar[href*="/user/"]');
      if (!anchor) return null;

      const userIdentifier = userIdentifierFromHref(
        anchor.getAttribute("href"),
        baseUrl,
      );
      if (!userIdentifier) return null;

      const displayName = anchor.textContent.trim();
      return { displayName, element, originalIndex, userIdentifier };
    });

    return friends.every(Boolean) ? friends : [];
  }

  function applyFriendSort({ list, friends, ...sortOptions }) {
    for (const friend of sortFriends(friends, sortOptions)) {
      list.append(friend.element);
    }
  }

  function installStyles(document) {
    const style = document.createElement("style");
    // The site styles #browserTools itself, but its filter rules target links.
    // These button rules mirror them; aria-current remains semantic only.
    // See docs/spec.md, "原站样式基线", for the verified source and selectors.
    style.textContent = `
      #bangumi-friend-sorter.filters {
        align-items: baseline;
        display: flex;
        flex-wrap: wrap;
      }
      #bangumi-friend-sorter .bangumi-friend-sorter-sort-options,
      #bangumi-friend-sorter .bangumi-friend-sorter-direction-options {
        align-items: baseline;
        display: flex;
        flex-wrap: wrap;
      }
      #bangumi-friend-sorter .bangumi-friend-sorter-direction-options {
        margin-left: auto;
      }
      #browserTools.bangumi-friend-sorter-bar {
        box-sizing: border-box;
        width: 100%;
      }
      #bangumi-friend-sorter .bangumi-friend-sorter-dropdown {
        display: inline-block;
        position: relative;
      }
      #bangumi-friend-sorter .bangumi-friend-sorter-dropdown-menu {
        -webkit-backdrop-filter: blur(5px);
        backdrop-filter: blur(5px);
        background-color: rgba(254, 254, 254, .9);
        border-radius: 15px;
        box-shadow: inset 0 1px 1px hsla(0, 100%, 100%, .3),
          inset 0 -1px 0 hsla(0, 100%, 100%, .1),
          0 3px 15px hsla(214, 100%, 0%, .2);
        display: flex;
        flex-direction: column;
        left: -5px;
        opacity: 0;
        padding: 0;
        pointer-events: none;
        position: absolute;
        top: 100%;
        transform: translateY(-4px);
        transition: opacity .15s ease, transform .15s ease, visibility .15s;
        visibility: hidden;
        width: max-content;
        z-index: 10;
      }
      #bangumi-friend-sorter .bangumi-friend-sorter-dropdown[data-open="true"]
        .bangumi-friend-sorter-dropdown-menu,
      #bangumi-friend-sorter .bangumi-friend-sorter-dropdown:hover
        .bangumi-friend-sorter-dropdown-menu,
      #bangumi-friend-sorter .bangumi-friend-sorter-dropdown:focus-within
        .bangumi-friend-sorter-dropdown-menu {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0);
        visibility: visible;
      }
      #bangumi-friend-sorter .bangumi-friend-sorter-dropdown-menu button.l {
        border-radius: 100px;
        box-sizing: border-box;
        margin: 5px;
        padding: 5px 15px;
        text-align: left;
        transition: all .2s ease-in-out;
      }
      #bangumi-friend-sorter .bangumi-friend-sorter-dropdown-menu button.l:hover,
      #bangumi-friend-sorter
        .bangumi-friend-sorter-dropdown-menu button.l:focus-visible {
        background: #369cf8;
        color: #fff;
      }
      html[data-theme="dark"] #bangumi-friend-sorter
        .bangumi-friend-sorter-dropdown-menu {
        background-color: rgba(80, 80, 80, .7);
      }
      html[data-theme="dark"] #bangumi-friend-sorter
        .bangumi-friend-sorter-dropdown-menu button.l {
        color: #fff;
      }
      /* CSS has no // comments: one would be absorbed into the next
         selector, silently dropping the whole rule. */
      /* Keep a one-space gap between the fixed "按"/"排序" labels and the
         adjacent buttons so hover/focus backgrounds never touch the text. */
      #bangumi-friend-sorter .bangumi-friend-sorter-prefix {
        margin-right: .25em;
      }
      #bangumi-friend-sorter .bangumi-friend-sorter-suffix {
        margin-left: .25em;
      }
      #bangumi-friend-sorter button.l {
        appearance: none;
        background: none;
        border: 0;
        border-radius: 15px;
        color: #0084b4;
        cursor: pointer;
        font: inherit;
        margin: 0;
        padding: 2px 8px;
      }
      html[data-theme="dark"] #bangumi-friend-sorter button.l {
        color: #2ea6ff;
      }
      #bangumi-friend-sorter button.l:hover,
      #bangumi-friend-sorter button.l:focus-visible {
        background: var(--primary-color, #f09199);
        color: #fff;
        text-decoration: none;
      }
      #bangumi-friend-sorter-status {
        color: #999;
        margin-left: .6em;
      }
    `;
    document.head.append(style);
  }

  function setAriaCurrent(button, isCurrent) {
    if (isCurrent) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }

  function createSortBar(document, onSelect, onDirectionSelect = () => {}) {
    const bar = document.createElement("div");
    // Reuse the site's #browserTools frame, including its horizontal borders.
    bar.id = "browserTools";
    bar.className = "clearit bangumi-friend-sorter-bar";
    bar.dataset.friendSorter = "";
    bar.setAttribute("aria-label", "好友排序");

    const filters = document.createElement("div");
    filters.className = "filters";
    filters.id = "bangumi-friend-sorter";

    const sortOptions = document.createElement("span");
    sortOptions.className = "bangumi-friend-sorter-sort-options";
    // Bare text nodes are anonymous flex items and cannot carry margins, so
    // the fixed labels get wrapper spans for the breathing-room gaps.
    const prefix = document.createElement("span");
    prefix.className = "bangumi-friend-sorter-prefix";
    prefix.textContent = "按";
    sortOptions.append(prefix);

    const buttons = new Map();
    for (const [criterion, label] of SORT_CHOICES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "l";
      button.textContent = label;
      button.addEventListener("click", () => onSelect(criterion));
      sortOptions.append(button);
      buttons.set(criterion, button);
    }

    function createDropdown({
      id,
      label,
      choices,
      onDefaultSelect,
      onSelect: onChoiceSelect,
    }) {
      const dropdown = document.createElement("span");
      dropdown.className = "bangumi-friend-sorter-dropdown";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "l bangumi-friend-sorter-dropdown-toggle";
      toggle.textContent = label;
      toggle.setAttribute("aria-haspopup", "true");
      toggle.setAttribute("aria-controls", id);
      toggle.addEventListener("click", () => {
        onDefaultSelect();
        toggle.focus?.();
      });

      const menu = document.createElement("span");
      menu.id = id;
      menu.className = "bangumi-friend-sorter-dropdown-menu";
      menu.setAttribute("role", "menu");
      const buttons = new Map();
      for (const [value, choiceLabel] of choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "l";
        button.textContent = choiceLabel;
        button.setAttribute("role", "menuitem");
        button.addEventListener("click", () => onChoiceSelect(value));
        menu.append(button);
        buttons.set(value, button);
      }

      function setMenuOpen(isOpen) {
        dropdown.dataset.open = String(isOpen);
        toggle.setAttribute("aria-expanded", String(isOpen));
      }

      function isInsideDropdown(node) {
        return Boolean(dropdown.contains?.(node));
      }

      function keepMenuOpenOnFocus(button) {
        button.addEventListener("focus", () => setMenuOpen(true));
        button.addEventListener("focusout", (event) => {
          if (!isInsideDropdown(event.relatedTarget)) setMenuOpen(false);
        });
        button.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault?.();
          button.click();
        });
      }

      dropdown.addEventListener("pointerenter", () => setMenuOpen(true));
      dropdown.addEventListener("pointerleave", () => {
        if (!isInsideDropdown(document.activeElement)) setMenuOpen(false);
      });
      keepMenuOpenOnFocus(toggle);
      for (const button of buttons.values()) keepMenuOpenOnFocus(button);
      setMenuOpen(false);

      dropdown.append(toggle, menu);
      return { dropdown, button: toggle, menu, buttons };
    }

    const completionControl = createDropdown({
      id: "bangumi-friend-sorter-completion-menu",
      label: "完成条目数",
      choices: COMPLETION_CHOICES,
      onDefaultSelect: () => onSelect(SORT.COMPLETION, COMPLETION_SCOPE.ALL),
      onSelect: (scope) => onSelect(SORT.COMPLETION, scope),
    });
    const completionDropdown = completionControl.dropdown;

    const relationControl = createDropdown({
      id: "bangumi-friend-sorter-relation-menu",
      label: "喜好契合",
      choices: RELATION_CHOICES,
      onDefaultSelect: () => onSelect(SORT.RELATION, RELATION_CHOICES[0][0]),
      onSelect: (metric) => onSelect(SORT.RELATION, metric),
    });
    const relationDropdown = relationControl.dropdown;

    sortOptions.append(relationDropdown);
    sortOptions.append(completionDropdown);

    const suffix = document.createElement("span");
    suffix.className = "bangumi-friend-sorter-suffix";
    suffix.textContent = "排序";
    sortOptions.append(suffix);
    const status = document.createElement("span");
    status.id = "bangumi-friend-sorter-status";
    status.setAttribute("aria-live", "polite");
    sortOptions.append(status);

    const directionOptions = document.createElement("span");
    directionOptions.className = "bangumi-friend-sorter-direction-options";
    const directionButtons = new Map();
    const initialDirectionLabels = directionLabelsFor(SORT.ADDED);
    for (const direction of [DIRECTION.ASCENDING, DIRECTION.DESCENDING]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "l";
      button.textContent = initialDirectionLabels[direction];
      button.addEventListener("click", () => onDirectionSelect(direction));
      directionOptions.append(button);
      directionButtons.set(direction, button);
    }

    filters.append(sortOptions, directionOptions);
    bar.append(filters);

    return {
      bar,
      setCurrent(
        criterion,
        direction = defaultDirectionFor(criterion),
        selection = COMPLETION_SCOPE.ALL,
      ) {
        for (const [value, button] of buttons) {
          setAriaCurrent(button, value === criterion);
        }
        setAriaCurrent(completionControl.button, criterion === SORT.COMPLETION);
        setAriaCurrent(relationControl.button, criterion === SORT.RELATION);
        for (const [scope, button] of completionControl.buttons) {
          setAriaCurrent(
            button,
            criterion === SORT.COMPLETION && scope === selection,
          );
        }
        for (const [metric, button] of relationControl.buttons) {
          setAriaCurrent(
            button,
            criterion === SORT.RELATION && metric === selection,
          );
        }
        const labels = directionLabelsFor(criterion);
        for (const [value, button] of directionButtons) {
          button.textContent = labels[value];
          setAriaCurrent(button, value === direction);
        }
      },
      status,
    };
  }

  async function fetchActivity(friend, fetchImpl, domParser, now) {
    return fetchPageWithTimeout(
      `/user/${encodeURIComponent(userIdentifierFor(friend))}/timeline`,
      fetchImpl,
      async (response) => {
        const html = await response.text();
        const fetchedAt = now();
        const responseAt = Date.parse(response.headers?.get("date") || "");
        const document = domParser.parseFromString(html, "text/html");
        const parsed = parseTimelineDocument(
          document,
          Math.trunc(
            (Number.isFinite(responseAt) ? responseAt : fetchedAt) / 1_000,
          ),
        );
        if (parsed.kind === "invalid") return { kind: "parse-error" };
        return { kind: "success", record: { ...parsed, fetchedAt } };
      },
    );
  }

  function profileRecordHasTarget(record, target) {
    return profileTargetPolicyFor(target)?.hasTarget(record, target) ?? false;
  }

  function browserStorage(pageWindow = window) {
    try {
      return pageWindow.localStorage;
    } catch {
      return null;
    }
  }

  function mountSortBar(pageDocument, list, bar) {
    const canWalkAncestors = typeof list.closest === "function";
    let mainWrapper = canWalkAncestors ? list.closest(".mainWrapper") : null;
    if (!mainWrapper && !canWalkAncestors) {
      try {
        mainWrapper = pageDocument.querySelector?.(".mainWrapper");
      } catch {
        // Lightweight test doubles may only implement the list selector.
      }
    }
    const columns = mainWrapper?.querySelector?.(".columns");
    if (
      mainWrapper &&
      columns &&
      typeof mainWrapper.insertBefore === "function"
    ) {
      mainWrapper.insertBefore(bar, columns);
      return true;
    }
    if (!canWalkAncestors) {
      list.before(bar);
      return true;
    }
    return false;
  }

  function pageFetchDependencies(runtime, pageWindow) {
    const domParser =
      runtime.domParser ??
      (typeof DOMParser === "function" ? new DOMParser() : null);
    const fetchImpl =
      runtime.fetchImpl ??
      (typeof pageWindow.fetch === "function"
        ? pageWindow.fetch.bind(pageWindow)
        : null);
    return domParser && fetchImpl ? { domParser, fetchImpl } : null;
  }

  function createStatusController({
    clearTimeout: clearStatusTimeout = globalThis.clearTimeout,
    now = Date.now,
    scheduler,
    statusElement,
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
        statusElement.textContent = loginStatus.message;
        return;
      }

      const completion = completionStatuses[0];
      if (completion) {
        statusKind = REFRESH_STATUS.COMPLETED;
        statusElement.textContent = completion.message;
        return;
      }

      if (transientStatus) {
        statusKind = transientStatus.kind;
        statusElement.textContent = transientStatus.message;
        return;
      }

      const progress = currentProgressStatus();
      if (progress) {
        statusKind = REFRESH_STATUS.FETCHING;
        statusElement.textContent = progress.message;
        return;
      }

      statusKind = REFRESH_STATUS.IDLE;
      statusElement.textContent = "";
    }

    function clearArmedStatus() {
      if (transientStatus?.kind !== REFRESH_STATUS.AWAITING_FULL_REFRESH)
        return;
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

  function createRefreshLifecycle({
    applySort,
    labelFor,
    persist,
    progressReporter,
    status,
    taskType,
    onSuccess,
  }) {
    return {
      onFetching: progressReporter,
      onProgress: progressReporter,
      onQueue: progressReporter,
      onRateLimited: status.showRateLimit,
      onSuccess,
      onFinished({ failures, globallyStopped, target }) {
        status.clearProgress(taskType);
        applySort();
        persist?.();
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

  function choiceLabelFor(choices, value) {
    return choices.find(([choiceValue]) => choiceValue === value)?.[1] || value;
  }

  // Owns the refresh orchestration half of the sorter: scheduler, status
  // rendering, task lifecycles and the activity/profile refresh starters.
  // The selection/UI state machine only talks to it through `status`,
  // `startActivity` and `startProfile`.
  function createFriendRefreshTasks({
    applyActivitySort,
    applyProfileSort,
    cache,
    friends,
    now,
    pageWindow,
    runtime,
    statusElement,
    visitorIdentifier,
  }) {
    const scheduler = createTaskScheduler({ concurrency: 4 });
    const status = createStatusController({
      clearTimeout: runtime.clearTimeout ?? globalThis.clearTimeout,
      now,
      scheduler,
      statusElement,
      setTimeout: runtime.setTimeout ?? globalThis.setTimeout,
    });
    const confirmRequest =
      runtime.confirm ?? pageWindow.confirm?.bind(pageWindow) ?? (() => false);
    const getDependencies = () => pageFetchDependencies(runtime, pageWindow);

    function profileLabelFor(target) {
      return profileTargetPolicyFor(target)?.label ?? target?.kind ?? "";
    }

    const showActivityProgress = createTaskProgressReporter({
      onProgress: runtime.onProgress,
      status,
      taskType: "activity",
      messageFor: ({ completed, total }) =>
        `正在获取“上次活跃” ${completed}/${total}`,
    });
    const showProfileProgress = createTaskProgressReporter({
      onProgress: runtime.onProgress,
      status,
      taskType: "profile",
      messageFor: ({ completed, target, total }) =>
        `正在获取“${profileLabelFor(target)}” ${completed}/${total}`,
    });

    const activityLifecycle = createRefreshLifecycle({
      applySort: applyActivitySort,
      labelFor: () => "上次活跃",
      persist: () => cache.persist(),
      progressReporter: showActivityProgress,
      status,
      taskType: "activity",
      onSuccess: (friend, record) =>
        cache.setField(userIdentifierFor(friend), "activity", record, {
          persist: false,
        }),
    });

    // The profile task persists the cache in onFinished and saves
    // completion/relation fields in onSuccess via saveProfileRecord.
    const profileBaseLifecycle = createRefreshLifecycle({
      applySort: applyProfileSort,
      labelFor: profileLabelFor,
      progressReporter: showProfileProgress,
      status,
      taskType: "profile",
    });
    const profileLifecycle = {
      ...profileBaseLifecycle,
      onFinished(result) {
        cache.persist();
        profileBaseLifecycle.onFinished?.(result);
      },
      onSuccess(friend, record) {
        saveProfileRecord(cache, visitorIdentifier, friend, record);
      },
    };

    // Starts a foreground scheduler task for one refresh mode; guarded so a
    // stopped scheduler or missing fetch dependencies never enqueue work.
    function startRefresh({
      fetchItem,
      getPending,
      isSuccess = (record, outcome) => outcome.kind === "success",
      keyFor,
      lifecycle = {},
      target,
      taskType,
    }) {
      if (scheduler.isGloballyStopped() || !getDependencies()) return null;

      const pending = getPending();
      if (pending.length === 0 && !scheduler.getTask(taskType)) return null;
      const { task } = scheduler.enqueue(
        taskType,
        pending,
        {
          confirmMessage: (count) =>
            `本次新增获取的好友数量过多（${count} 人），是否继续？`,
          confirmRequest,
          fetch: (item) => {
            const dependencies = getDependencies();
            if (!dependencies) return { kind: "network-error" };
            return fetchItem(item, dependencies);
          },
          isSuccess,
          keyFor,
          lifecycle,
          target,
        },
        { foreground: true },
      );
      return task;
    }

    function startActivity(mode) {
      return startRefresh({
        fetchItem: (friend, dependencies) =>
          fetchActivity(
            friend,
            dependencies.fetchImpl,
            dependencies.domParser,
            now,
          ),
        getPending: () =>
          mode === "full"
            ? friends
            : findFriendsNeedingActivity(friends, cache, now()),
        keyFor: userIdentifierFor,
        lifecycle: activityLifecycle,
        target: mode,
        taskType: "activity",
      });
    }

    function startProfile(target, mode = "incremental") {
      return startRefresh({
        fetchItem: (friend, dependencies) =>
          fetchProfile(
            friend,
            dependencies.fetchImpl,
            dependencies.domParser,
            now,
          ),
        getPending: () =>
          mode === "full"
            ? friends
            : profileTargetPolicyFor(target).findPending({
                cache,
                friends,
                now: now(),
                target,
                visitorIdentifier,
              }),
        isSuccess: (record, outcome, nextTarget) =>
          outcome.kind === "success" &&
          profileRecordHasTarget(record, nextTarget),
        keyFor: userIdentifierFor,
        lifecycle: profileLifecycle,
        target,
        taskType: "profile",
      });
    }

    return { startActivity, startProfile, status };
  }

  function createFriendSortController({
    cache,
    collator,
    controls,
    friends,
    list,
    now,
    pageWindow,
    runtime,
    visitorIdentifier,
  }) {
    let currentCriterion = SORT.ADDED;
    let completionScope = COMPLETION_SCOPE.ALL;
    let relationMetric = RELATION_CHOICES[0][0];
    const directionByCriterion = new Map(
      [
        ...SORT_CHOICES.map(([criterion]) => criterion),
        SORT.COMPLETION,
        SORT.RELATION,
      ].map((criterion) => [criterion, defaultDirectionFor(criterion)]),
    );

    function selectionFor(criterion) {
      if (criterion === SORT.RELATION) return relationMetric;
      if (criterion === SORT.COMPLETION) return completionScope;
      return COMPLETION_SCOPE.ALL;
    }

    function applyCurrentSort() {
      applyFriendSort({
        list,
        friends,
        criterion: currentCriterion,
        friendCache: cache,
        collator,
        direction: directionByCriterion.get(currentCriterion),
        completionScope,
        relationSelection: {
          metric: relationMetric,
          visitorIdentifier,
        },
      });
    }

    const refresh = createFriendRefreshTasks({
      applyActivitySort: () => {
        if (currentCriterion === SORT.ACTIVITY) applyCurrentSort();
      },
      applyProfileSort: () => {
        if (
          currentCriterion === SORT.RELATION ||
          currentCriterion === SORT.COMPLETION
        ) {
          applyCurrentSort();
        }
      },
      cache,
      friends,
      now,
      pageWindow,
      runtime,
      statusElement: controls.status,
      visitorIdentifier,
    });
    const { status } = refresh;

    function showLoginRequiredStatus() {
      if (status.getKind() === REFRESH_STATUS.LOGIN_REQUIRED) return;
      status.set(
        REFRESH_STATUS.LOGIN_REQUIRED,
        "请登录后使用喜好契合排序",
        5_000,
      );
    }

    const remoteTargetConfigurations = {
      [SORT.ACTIVITY]: {
        armMessageFor: () => "上次活跃",
        requiresVisitor: false,
        startRefresh: (_target, mode) => refresh.startActivity(mode),
      },
      [SORT.RELATION]: {
        armMessageFor: (selection) =>
          choiceLabelFor(RELATION_CHOICES, selection),
        defaultSelection: RELATION_CHOICES[0][0],
        requiresVisitor: true,
        setSelection: (selection) => {
          relationMetric = selection;
        },
        startRefresh: (target, mode) => refresh.startProfile(target, mode),
      },
      [SORT.COMPLETION]: {
        armMessageFor: (selection) =>
          choiceLabelFor(COMPLETION_CHOICES, selection),
        defaultSelection: COMPLETION_SCOPE.ALL,
        requiresVisitor: false,
        setSelection: (selection) => {
          completionScope = selection;
        },
        startRefresh: (target, mode) => refresh.startProfile(target, mode),
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
        showLoginRequiredStatus();
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
      controls.setCurrent(
        criterion,
        directionByCriterion.get(criterion),
        selection,
      );
      applyCurrentSort();

      if (!action.refreshMode) return;
      if (configuration.requiresVisitor && !visitorIdentifier) {
        showLoginRequiredStatus();
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
      controls.setCurrent(
        criterion,
        directionByCriterion.get(criterion),
        selectionFor(criterion),
      );
      applyCurrentSort();
    }

    function selectCriterion(criterion, requestedSubcriterion) {
      const configuration = remoteTargetConfigurations[criterion];
      if (configuration) {
        selectRemoteCriterion(criterion, configuration, requestedSubcriterion);
        return;
      }
      selectLocalCriterion(criterion);
    }

    function selectDirection(direction) {
      if (directionByCriterion.get(currentCriterion) === direction) return;

      directionByCriterion.set(currentCriterion, direction);
      controls.setCurrent(
        currentCriterion,
        direction,
        selectionFor(currentCriterion),
      );
      applyCurrentSort();
    }

    return {
      selectCriterion,
      selectDirection,
      syncControls() {
        controls.setCurrent(
          currentCriterion,
          directionByCriterion.get(currentCriterion),
          selectionFor(currentCriterion),
        );
      },
    };
  }

  function initialize(runtime = {}) {
    const pageDocument = runtime.document ?? document;
    const pageWindow = runtime.window ?? window;
    const list = pageDocument.querySelector("#memberUserList");
    if (!list || list.children.length === 0) return;

    const friends = readFriends(list, pageWindow.location.href);
    if (friends.length !== list.children.length) return;

    const now = runtime.now ?? Date.now;
    const cache = createFriendCache(
      runtime.storage ?? browserStorage(pageWindow),
      { now },
    );
    const visitorIdentifier = currentVisitorIdentifier(
      pageDocument,
      pageWindow,
    );
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    let controller = null;
    const controls = createSortBar(
      pageDocument,
      (...args) => controller?.selectCriterion(...args),
      (direction) => controller?.selectDirection(direction),
    );
    if (!mountSortBar(pageDocument, list, controls.bar)) return;
    installStyles(pageDocument);
    controller = createFriendSortController({
      cache,
      collator,
      controls,
      friends,
      list,
      now,
      pageWindow,
      runtime,
      visitorIdentifier,
    });
    controller.syncControls();
  }

  const core = {
    RELATION_CHOICES,
    COMPLETION_CHOICES,
    COMPLETION_SCOPE,
    createFriendCache,
    createSortBar,
    completionFieldFor,
    currentVisitorIdentifier,
    directionLabelsFor,
    findFriendsNeedingCompletion,
    findFriendsNeedingActivity,
    findFriendsNeedingRelation,
    fetchProfile,
    initialize,
    isCompletionRecord,
    isRelationRecord,
    needsLargeRequestConfirmation,
    nextBatchState,
    nextRemoteSelectionAction,
    createTaskScheduler,
    createFriendRefreshTasks,
    parseProfileDocument,
    parseTimelineDocument,
    sortFriends,
  };

  if (
    typeof module === "object" &&
    module.exports &&
    typeof document === "undefined"
  ) {
    module.exports = core;
    return;
  }

  initialize();
})();
