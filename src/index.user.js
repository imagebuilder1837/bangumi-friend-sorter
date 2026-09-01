// ==UserScript==
// @name         Bangumi 好友排序
// @namespace    https://github.com/imagebuilder1837/bangumi-friend-sorter
// @version      0.1.5
// @description  为好友/反向好友页增加上次活跃、喜好契合和完成条目数等排序方式。
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
  const COMPLETION_CACHE_TTL_MS = 72 * 60 * 60 * 1_000;
  const PAGE_REQUEST_TIMEOUT_MS = 15_000;
  const SITE_OFFSET_SECONDS = 8 * 60 * 60;
  const CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v3";
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
  });
  const REFRESH_PROMPT_STATUS = "armed";
  const LOGIN_STATUS = "login";
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
  const RELATION_CHOICES = [
    ["syncRate", "同步率"],
    ["commonLikes", "共同喜好数"],
  ];
  const COMPLETION_CACHE_FIELD_PREFIX = "completion_";
  const INVALID_STATS_BLOCK = Symbol("invalid-stats-block");

  function userIdentifierFor(friend) {
    // Accept the pre-v3 friend shape while using the glossary term everywhere new.
    return friend.userIdentifier ?? friend.userId;
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

  function isRelationRecord(value, metric) {
    if (!value || typeof value !== "object") return false;
    if (!Number.isFinite(value.value) || !Number.isFinite(value.fetchedAt)) {
      return false;
    }
    if (metric === "commonLikes") {
      return Number.isInteger(value.value) && value.value >= 0;
    }
    return metric === "syncRate";
  }

  function relationFieldFor(visitorIdentifier, metric) {
    return `relation_${encodeURIComponent(String(visitorIdentifier))}_${metric}`;
  }

  function completionCacheFieldValidators() {
    return Object.fromEntries(
      COMPLETION_CHOICES.map(([scope]) => [
        completionFieldFor(scope),
        isCompletionRecord,
      ]),
    );
  }

  function completionRecordFromValue(value) {
    if (isCompletionRecord(value)) return value;
    if (Number.isSafeInteger(value) && value >= 0) {
      return { value, fetchedAt: 0 };
    }
    return null;
  }

  function completionRecordFor(source, userIdentifier, scope) {
    const field = completionFieldFor(scope);
    if (typeof source?.getField === "function") {
      return source.getField(userIdentifier, field);
    }

    const value = source?.get?.(userIdentifier);
    return (
      completionRecordFromValue(value) ||
      completionRecordFromValue(value?.[field]) ||
      completionRecordFromValue(value?.[scope])
    );
  }

  function relationRecordFor(
    source,
    userIdentifier,
    visitorIdentifier,
    metric = "syncRate",
  ) {
    if (!visitorIdentifier) return null;
    const field = relationFieldFor(visitorIdentifier, metric);
    if (typeof source?.getRelationField === "function") {
      return source.getRelationField(visitorIdentifier, userIdentifier, metric);
    }
    if (typeof source?.getField === "function") {
      return source.getField(userIdentifier, field);
    }

    const value = source?.get?.(userIdentifier);
    return (
      value?.[field] ||
      value?.relation?.[visitorIdentifier]?.[metric] ||
      (isRelationRecord(value, metric) ? value : null)
    );
  }

  function activityRecordFor(source, userIdentifier) {
    if (typeof source?.getField === "function") {
      return source.getField(userIdentifier, "activity");
    }

    const value = source?.get?.(userIdentifier);
    return value?.activity ?? value;
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
      compare(left, right, { isAscending, sortData }) {
        const leftActivity = activityRecordFor(
          sortData,
          userIdentifierFor(left),
        );
        const rightActivity = activityRecordFor(
          sortData,
          userIdentifierFor(right),
        );
        const leftHasTime = leftActivity?.kind === "active";
        const rightHasTime = rightActivity?.kind === "active";

        if (leftHasTime && rightHasTime) {
          return (
            (leftActivity.activityAtSeconds - rightActivity.activityAtSeconds) *
              (isAscending ? 1 : -1) || left.originalIndex - right.originalIndex
          );
        }
        if (leftHasTime) return -1;
        if (rightHasTime) return 1;
        return left.originalIndex - right.originalIndex;
      },
    },
    [SORT.COMPLETION]: {
      defaultDirection: DIRECTION.DESCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "从低到高",
        [DIRECTION.DESCENDING]: "从高到低",
      }),
      compare(left, right, { completionScope, isAscending, sortData }) {
        const leftCompletion = completionRecordFor(
          sortData,
          userIdentifierFor(left),
          completionScope,
        );
        const rightCompletion = completionRecordFor(
          sortData,
          userIdentifierFor(right),
          completionScope,
        );
        const leftHasValue = isCompletionRecord(leftCompletion);
        const rightHasValue = isCompletionRecord(rightCompletion);

        if (leftHasValue && rightHasValue) {
          return (
            (leftCompletion.value - rightCompletion.value) *
              (isAscending ? 1 : -1) || left.originalIndex - right.originalIndex
          );
        }
        if (leftHasValue) return -1;
        if (rightHasValue) return 1;
        return left.originalIndex - right.originalIndex;
      },
    },
    [SORT.RELATION]: {
      defaultDirection: DIRECTION.DESCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "从低到高",
        [DIRECTION.DESCENDING]: "从高到低",
      }),
      compare(
        left,
        right,
        { isAscending, relationMetric, relationVisitorIdentifier, sortData },
      ) {
        const leftRelation = relationRecordFor(
          sortData,
          userIdentifierFor(left),
          relationVisitorIdentifier,
          relationMetric,
        );
        const rightRelation = relationRecordFor(
          sortData,
          userIdentifierFor(right),
          relationVisitorIdentifier,
          relationMetric,
        );
        const leftHasValue = isRelationRecord(leftRelation, relationMetric);
        const rightHasValue = isRelationRecord(rightRelation, relationMetric);

        if (leftHasValue && rightHasValue) {
          return (
            (leftRelation.value - rightRelation.value) *
              (isAscending ? 1 : -1) || left.originalIndex - right.originalIndex
          );
        }
        if (leftHasValue) return -1;
        if (rightHasValue) return 1;
        return left.originalIndex - right.originalIndex;
      },
    },
  });
  const DEFAULT_SORT_CONFIG = Object.freeze({
    defaultDirection: DIRECTION.DESCENDING,
    directionLabels: Object.freeze({
      [DIRECTION.ASCENDING]: "从旧到新",
      [DIRECTION.DESCENDING]: "从新到旧",
    }),
  });

  function sortConfigFor(criterion) {
    return SORT_CONFIG[criterion] || DEFAULT_SORT_CONFIG;
  }

  function directionLabelsFor(criterion) {
    return { ...sortConfigFor(criterion).directionLabels };
  }

  function defaultDirectionFor(criterion) {
    return sortConfigFor(criterion).defaultDirection;
  }

  function isAscendingDirection(direction, criterion) {
    const effectiveDirection = direction || defaultDirectionFor(criterion);
    return effectiveDirection === DIRECTION.ASCENDING;
  }

  function createFriendCache(
    storage,
    { fieldValidators = {}, now = Date.now } = {},
  ) {
    const records = new Map();
    const validators = new Map([
      ["activity", isActivityRecord],
      ...Object.entries(fieldValidators),
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
      const validator = validators.get(field);
      if (validator) return validator;
      const relationMatch = /^relation_.+_(syncRate|commonLikes)$/.exec(field);
      return relationMatch
        ? (relationValue) => isRelationRecord(relationValue, relationMatch[1])
        : null;
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
          CACHE_STORAGE_KEY,
          JSON.stringify({ version: 3, records: Object.fromEntries(records) }),
        );
        return true;
      } catch {
        // Keep newly written records in memory when persistence is unavailable.
        return false;
      }
    }

    const hasCurrentCache = loadFields(read(CACHE_STORAGE_KEY));
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
      getRelationField(visitorIdentifier, userIdentifier, metric) {
        return this.getField(
          userIdentifier,
          relationFieldFor(visitorIdentifier, metric),
        );
      },
      persist,
      setField(userIdentifier, field, value, shouldPersist = true) {
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
        visitorIdentifier,
        userIdentifier,
        metric,
        value,
        shouldPersist = true,
      ) {
        if (!isRelationRecord(value, metric)) return this;
        return this.setField(
          userIdentifier,
          relationFieldFor(visitorIdentifier, metric),
          value,
          shouldPersist,
        );
      },
      setFields(userIdentifier, values, shouldPersist = true) {
        const fields = validateFields(values);
        if (Object.keys(fields).length === 0) return this;
        records.set(userIdentifier, {
          ...records.get(userIdentifier),
          ...fields,
        });
        if (shouldPersist) persist();
        return this;
      },
    };
  }

  function sortFriends(
    friends,
    {
      criterion,
      sortData = new Map(),
      collator = new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: "base",
      }),
      direction,
      completionScope = COMPLETION_SCOPE.ALL,
      relationMetric = "syncRate",
      relationVisitorIdentifier,
    } = {},
  ) {
    const sorted = [...friends];
    const isAscending = isAscendingDirection(direction, criterion);

    const sortConfig = SORT_CONFIG[criterion];
    if (sortConfig?.compare) {
      sorted.sort((left, right) =>
        sortConfig.compare(left, right, {
          collator,
          completionScope,
          isAscending,
          relationMetric,
          relationVisitorIdentifier,
          sortData,
        }),
      );
    }

    return sorted;
  }

  function findFriendsNeedingActivity(friends, activityByUser, now) {
    return friends.filter((friend) => {
      const activity = activityRecordFor(
        activityByUser,
        userIdentifierFor(friend),
      );
      return !activity || now - activity.fetchedAt > CACHE_TTL_MS;
    });
  }

  function nextActivitySelectionAction(
    currentCriterion,
    requestedCriterion,
    statusKind,
  ) {
    if (requestedCriterion !== SORT.ACTIVITY) {
      return statusKind === REFRESH_PROMPT_STATUS
        ? { kind: "sort", clearPrompt: true }
        : { kind: "sort" };
    }
    if (currentCriterion !== SORT.ACTIVITY) {
      return statusKind === REFRESH_PROMPT_STATUS
        ? { kind: "sort", clearPrompt: true, refresh: "incremental" }
        : { kind: "sort", refresh: "incremental" };
    }
    if (statusKind === REFRESH_STATUS.IDLE) return { kind: "arm" };
    if (statusKind === REFRESH_PROMPT_STATUS) {
      return { kind: "refresh", mode: "full" };
    }
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
    const unitRanks = { 年: 5, 月: 4, 天: 3, 小时: 2, 分: 1, 秒: 0 };
    const tokens = [];
    const tokenPattern = /(\d+)(年|月|天|小时|分|秒)/g;
    let cursor = 0;
    let match;
    while ((match = tokenPattern.exec(body))) {
      if (match.index !== cursor) return null;
      tokens.push({
        amount: Number(match[1]),
        rank: unitRanks[match[2]],
        unit: match[2],
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
    let foregroundTaskSeen = false;
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
      if (foregroundType && !foreground && !foregroundTaskSeen) return null;
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
      const lifecycle = options.lifecycle ?? options;
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
            lifecycle.onFetching?.({ completed, target, total });
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
          lifecycle.onProgress?.({ completed, target, total });
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
          target = nextTarget;
          if (
            newItems.length > 400 &&
            options.confirmRequest &&
            !options.confirmRequest(confirmMessage(newItems.length, nextTarget))
          ) {
            return { added: 0, accepted: false };
          }
          for (const item of newItems) {
            queuedKeys.add(keyFor(item));
            queue.push(item);
          }
          total += newItems.length;
          if (started) {
            lifecycle.onQueue?.({
              added: newItems.length,
              completed,
              target,
              total,
            });
          }
          return { added: newItems.length, accepted: true };
        },
        fetch: options.fetch,
        getState() {
          return { completed, target, total };
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
            lifecycle.onProgress?.({ completed, target, total });
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
        foregroundTaskSeen = true;
      } else if (added > 0 && type === foregroundType) {
        foregroundTaskSeen = true;
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
        foregroundTaskSeen = Boolean(
          foregroundType && tasks.has(foregroundType),
        );
        pump();
      },
      stopAll,
    };
  }

  async function runPageFetchTask(items, options) {
    if (items.length === 0) return { failures: 0, stopped: false };

    const entries = items.map((item, index) => ({ index, item }));
    return new Promise((resolve) => {
      const scheduler = createTaskScheduler({ concurrency: 4 });
      scheduler.enqueue("standalone", entries, {
        fetch: ({ item }) => options.fetchPage(item),
        isSuccess: (record, outcome) => outcome.kind === "success",
        keyFor: ({ index }) => index,
        lifecycle: {
          onFinished: ({ failures, stopped }) => resolve({ failures, stopped }),
          onProgress: ({ completed, total }) =>
            options.onProgress?.(completed, total),
          onSuccess: ({ item }, record, outcome) =>
            options.onSuccess?.(item, record, outcome),
        },
      });
    });
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

  function statsBlockFor(container, scope) {
    const selector = `#userStats_${scope}`;
    const blocks = [...(container?.querySelectorAll?.(selector) || [])];
    if (blocks.length > 1) return INVALID_STATS_BLOCK;
    return blocks[0] || null;
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
    if (aggregate === INVALID_STATS_BLOCK || !aggregate) {
      return null;
    }
    const aggregateValue = parseCompletionCount(aggregate);
    if (aggregateValue === null) return null;

    const values = { [COMPLETION_SCOPE.ALL]: aggregateValue };
    for (const [scope] of COMPLETION_CHOICES.slice(1)) {
      const block = statsBlockFor(container, scope);
      if (block === INVALID_STATS_BLOCK) return null;
      if (!block) {
        values[scope] = 0;
        continue;
      }
      const value = parseCompletionCount(block);
      if (value !== null) values[scope] = value;
    }

    return values;
  }

  function parseProfileDocument(document) {
    const values = parseCompletionValues(document);
    const relation = parseRelationValues(document);
    if (!values && relation === null) return { kind: "invalid" };

    const parsed = { kind: "success" };
    if (values) parsed.values = values;
    if (relation !== null) parsed.relation = relation;
    return parsed;
  }

  function findFriendsNeedingCompletion(
    friends,
    completionByUser,
    scope = COMPLETION_SCOPE.ALL,
    now = Date.now(),
  ) {
    if (typeof scope === "number") {
      now = scope;
      scope = COMPLETION_SCOPE.ALL;
    }
    return friends.filter((friend) => {
      const completion = completionRecordFor(
        completionByUser,
        userIdentifierFor(friend),
        scope,
      );
      return (
        !completion || now - completion.fetchedAt > COMPLETION_CACHE_TTL_MS
      );
    });
  }

  function findFriendsNeedingRelation(
    friends,
    relationCache,
    visitorIdentifier,
    metric = "syncRate",
    now = Date.now(),
  ) {
    return friends.filter((friend) => {
      const relation = relationRecordFor(
        relationCache,
        userIdentifierFor(friend),
        visitorIdentifier,
        metric,
      );
      return !relation || now - relation.fetchedAt > COMPLETION_CACHE_TTL_MS;
    });
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

    const username = pageWindow?.CHOBITS_USERNAME;
    if (typeof username === "string" && username.trim()) {
      return username.trim();
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
        if (parsed.values) record.values = parsed.values;
        if (parsed.relation) record.relation = parsed.relation;
        return { kind: "success", record };
      },
    );
  }

  function saveProfileRecord(cache, visitorIdentifier, friend, record) {
    for (const [scope, value] of Object.entries(record.values || {})) {
      cache.setField(
        userIdentifierFor(friend),
        completionFieldFor(scope),
        { value, fetchedAt: record.fetchedAt },
        false,
      );
    }
    if (!visitorIdentifier) return;
    for (const [metric, value] of Object.entries(record.relation || {})) {
      cache.setRelationField(
        visitorIdentifier,
        userIdentifierFor(friend),
        metric,
        { value, fetchedAt: record.fetchedAt },
        false,
      );
    }
  }

  async function refreshProfilePages(friends, options) {
    const result = await runPageFetchTask(friends, {
      fetchPage: (friend) =>
        fetchProfile(friend, options.fetchImpl, options.domParser, options.now),
      onSuccess(friend, record) {
        saveProfileRecord(
          options.cache,
          options.visitorIdentifier,
          friend,
          record,
        );
      },
      onProgress: options.onProgress,
    });
    options.cache.persist();
    return { failures: result.failures };
  }

  function readFriends(list, baseUrl = window.location.href) {
    const elements = [...list.children];
    const friends = elements.map((element, originalIndex) => {
      const anchor = element.querySelector('a.avatar[href*="/user/"]');
      if (!anchor) return null;

      let userIdentifier;
      try {
        const pathname = new URL(anchor.getAttribute("href"), baseUrl).pathname;
        const match = /^\/user\/([^/]+)\/?$/.exec(pathname);
        userIdentifier = match ? decodeURIComponent(match[1]) : null;
      } catch {
        return null;
      }

      const displayName = anchor.textContent.trim();
      if (!userIdentifier) return null;
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
        border: 1px solid #ddd;
        border-radius: 5px;
        box-shadow: 2px 2px 5px #eee;
        display: flex;
        flex-wrap: wrap;
        left: -5px;
        min-width: 230px;
        opacity: 0;
        padding: 0;
        pointer-events: none;
        position: absolute;
        top: 100%;
        transform: translateY(-4px);
        transition: opacity .15s ease, transform .15s ease, visibility .15s;
        visibility: hidden;
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
        border-left: 1px solid #eee;
        border-right: 1px solid #fff;
        border-radius: 0;
        padding: 5px 10px;
        width: auto;
      }
      #bangumi-friend-sorter
        .bangumi-friend-sorter-dropdown-menu button.l:first-child {
        border-left: 0;
      }
      #bangumi-friend-sorter
        .bangumi-friend-sorter-dropdown-menu button.l:last-child {
        border-right: 0;
      }
      #bangumi-friend-sorter .bangumi-friend-sorter-dropdown-menu button.l:hover,
      #bangumi-friend-sorter
        .bangumi-friend-sorter-dropdown-menu button.l:focus-visible {
        background: #369cf8;
        color: #fff;
        outline: 2px solid var(--primary-color, #f09199);
        outline-offset: -2px;
      }
      html[data-theme="dark"] #bangumi-friend-sorter
        .bangumi-friend-sorter-dropdown-menu {
        background-color: rgba(80, 80, 80, .7);
        border-color: #6e6e6e;
        box-shadow: 2px 2px 5px #444;
      }
      html[data-theme="dark"] #bangumi-friend-sorter
        .bangumi-friend-sorter-dropdown-menu button.l {
        border-left-color: #444;
        border-right-color: #333;
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
    sortOptions.append("按");

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
    const completionButton = completionControl.button;
    const completionMenu = completionControl.menu;
    const completionButtons = completionControl.buttons;

    const relationControl = createDropdown({
      id: "bangumi-friend-sorter-relation-menu",
      label: "喜好契合",
      choices: RELATION_CHOICES,
      onDefaultSelect: () => onSelect(SORT.RELATION, RELATION_CHOICES[0][0]),
      onSelect: (metric) => onSelect(SORT.RELATION, metric),
    });
    const relationDropdown = relationControl.dropdown;
    const relationButton = relationControl.button;
    const relationMenu = relationControl.menu;
    const relationButtons = relationControl.buttons;

    sortOptions.append(relationDropdown);
    sortOptions.append(completionDropdown);

    sortOptions.append("排序");
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
          if (value === criterion) button.setAttribute("aria-current", "true");
          else button.removeAttribute("aria-current");
        }
        if (criterion === SORT.COMPLETION) {
          completionButton.setAttribute("aria-current", "true");
        } else {
          completionButton.removeAttribute("aria-current");
        }
        if (criterion === SORT.RELATION) {
          relationButton.setAttribute("aria-current", "true");
        } else {
          relationButton.removeAttribute("aria-current");
        }
        for (const [scope, button] of completionButtons) {
          if (criterion === SORT.COMPLETION && scope === selection) {
            button.setAttribute("aria-current", "true");
          } else {
            button.removeAttribute("aria-current");
          }
        }
        for (const [metric, button] of relationButtons) {
          if (criterion === SORT.RELATION && metric === selection) {
            button.setAttribute("aria-current", "true");
          } else {
            button.removeAttribute("aria-current");
          }
        }
        const labels = directionLabelsFor(criterion);
        for (const [value, button] of directionButtons) {
          button.textContent = labels[value];
          if (value === direction) button.setAttribute("aria-current", "true");
          else button.removeAttribute("aria-current");
        }
      },
      status,
      relationButton,
      relationMenu,
      relationButtons,
      completionButton,
      completionMenu,
      completionButtons,
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

  async function refreshActivities(friends, options) {
    const result = await runPageFetchTask(friends, {
      fetchPage: (friend) =>
        fetchActivity(
          friend,
          options.fetchImpl,
          options.domParser,
          options.now,
        ),
      onSuccess(friend, record) {
        options.cache.setField(
          userIdentifierFor(friend),
          "activity",
          record,
          false,
        );
      },
      onProgress: options.onProgress,
    });
    options.cache.persist();
    return { failures: result.failures };
  }

  function profileRecordHasTarget(record, target) {
    if (!record) return false;
    if (target.kind === "completion") {
      const value = record.values?.[target.scope];
      return Number.isSafeInteger(value) && value >= 0;
    }
    const value = record.relation?.[target.metric];
    return isRelationRecord(
      { value, fetchedAt: record.fetchedAt },
      target.metric,
    );
  }

  function enqueueRefreshTask({
    confirmMessage,
    confirmRequest,
    fetchItem,
    getDependencies,
    isSuccess,
    keyFor,
    lifecycle = {},
    pending,
    scheduler,
    target,
    taskType,
  }) {
    const { task } = scheduler.enqueue(
      taskType,
      pending,
      {
        confirmMessage,
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

  function lifecycleWithMode(lifecycle, mode) {
    return {
      ...lifecycle,
      onFetching: (state) => lifecycle.onFetching?.({ ...state, mode }),
      onProgress: (state) => lifecycle.onProgress?.({ ...state, mode }),
      onQueue: (state) => lifecycle.onQueue?.({ ...state, mode }),
    };
  }

  function createProfileRefreshCoordinator({
    cache,
    confirmMessage,
    confirmRequest,
    getDependencies,
    friends,
    getPending,
    now,
    lifecycle = {},
    scheduler,
    visitorIdentifier,
  }) {
    const profileLifecycle = {
      ...lifecycle,
      onFinished(result) {
        cache.persist();
        lifecycle.onFinished?.(result);
      },
      onSuccess(friend, record) {
        saveProfileRecord(cache, visitorIdentifier, friend, record);
      },
    };

    return {
      start(target, mode = "incremental") {
        if (scheduler.isGloballyStopped() || !getDependencies()) return null;

        const pending = mode === "full" ? friends : getPending(target);
        if (pending.length === 0 && !scheduler.getTask("profile")) return null;
        return enqueueRefreshTask({
          confirmMessage,
          confirmRequest,
          fetchItem: (friend, dependencies) =>
            fetchProfile(
              friend,
              dependencies.fetchImpl,
              dependencies.domParser,
              now,
            ),
          getDependencies,
          isSuccess: (record, outcome, nextTarget) =>
            outcome.kind === "success" &&
            profileRecordHasTarget(record, nextTarget),
          keyFor: userIdentifierFor,
          lifecycle: profileLifecycle,
          pending,
          scheduler,
          target,
          taskType: "profile",
        });
      },
    };
  }

  function createPageRefreshCoordinator({
    confirmMessage,
    confirmRequest,
    getDependencies,
    getPending,
    keyFor,
    lifecycle = {},
    scheduler,
    taskType,
    fetchPage,
  }) {
    return {
      start(mode) {
        if (scheduler.isGloballyStopped() || !getDependencies()) return null;

        const pending = getPending(mode);
        if (pending.length === 0 && !scheduler.getTask(taskType)) return null;
        return enqueueRefreshTask({
          confirmMessage,
          confirmRequest,
          fetchItem: fetchPage,
          getDependencies,
          isSuccess: (record, outcome) => outcome.kind === "success",
          keyFor,
          lifecycle: lifecycleWithMode(lifecycle, mode),
          pending,
          scheduler,
          target: mode,
          taskType,
        });
      },
    };
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
    controls,
    now = Date.now,
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
        statusKind = LOGIN_STATUS;
        controls.status.textContent = loginStatus.message;
        return;
      }

      const completion = completionStatuses[0];
      if (completion) {
        statusKind = REFRESH_STATUS.COMPLETED;
        controls.status.textContent = completion.message;
        return;
      }

      if (transientStatus) {
        statusKind = transientStatus.kind;
        controls.status.textContent = transientStatus.message;
        return;
      }

      const progress = currentProgressStatus();
      if (progress) {
        statusKind = REFRESH_STATUS.FETCHING;
        controls.status.textContent = progress.message;
        return;
      }

      statusKind = REFRESH_STATUS.IDLE;
      controls.status.textContent = "";
    }

    function clearArmedStatus() {
      if (transientStatus?.kind !== REFRESH_PROMPT_STATUS) return;
      clearStatusTimeout(statusTimer);
      statusTimer = null;
      transientStatus = null;
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

      if (kind !== LOGIN_STATUS && loginStatus) return;
      clearStatusTimeout(statusTimer);
      statusTimer = null;
      if (kind === LOGIN_STATUS) {
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
    const scheduler = createTaskScheduler({ concurrency: 4 });
    const status = createStatusController({
      clearTimeout: runtime.clearTimeout ?? globalThis.clearTimeout,
      controls,
      now,
      scheduler,
      setTimeout: runtime.setTimeout ?? globalThis.setTimeout,
    });
    const confirmRequest =
      runtime.confirm ?? pageWindow.confirm?.bind(pageWindow) ?? (() => false);
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
        sortData: cache,
        collator,
        direction: directionByCriterion.get(currentCriterion),
        completionScope,
        relationMetric,
        relationVisitorIdentifier: visitorIdentifier,
      });
    }

    function applySortIfCurrent(criterion) {
      if (currentCriterion === criterion) applyCurrentSort();
    }

    function applyProfileSortIfCurrent() {
      if (
        currentCriterion === SORT.RELATION ||
        currentCriterion === SORT.COMPLETION
      ) {
        applyCurrentSort();
      }
    }

    function profileMainLabel(target) {
      return target.kind === "relation" ? "喜好契合" : "完成条目数";
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
        `正在获取“${profileMainLabel(target)}” ${completed}/${total}`,
    });

    const activityLifecycle = {
      onFetching: showActivityProgress,
      onFinished: ({ failures, globallyStopped }) => {
        status.clearProgress("activity");
        cache.persist();
        applySortIfCurrent(SORT.ACTIVITY);
        if (globallyStopped) {
          status.showRateLimit();
          return;
        }
        status.set(
          REFRESH_STATUS.COMPLETED,
          failures
            ? `“上次活跃”获取完成，${failures} 人失败`
            : "“上次活跃”获取完成",
          5_000,
        );
      },
      onProgress: showActivityProgress,
      onQueue: showActivityProgress,
      onRateLimited: status.showRateLimit,
      onSuccess: (friend, record) =>
        cache.setField(userIdentifierFor(friend), "activity", record, false),
    };

    const profileLifecycle = {
      onFetching: showProfileProgress,
      onFinished: ({ failures, globallyStopped, target }) => {
        status.clearProgress("profile");
        applyProfileSortIfCurrent();
        if (globallyStopped) {
          status.showRateLimit();
          return;
        }
        const label = profileMainLabel(target);
        status.set(
          REFRESH_STATUS.COMPLETED,
          failures
            ? `“${label}”获取完成，${failures} 人失败`
            : `“${label}”获取完成`,
          5_000,
        );
      },
      onProgress: showProfileProgress,
      onQueue: showProfileProgress,
      onRateLimited: status.showRateLimit,
    };

    const activityRefresh = createPageRefreshCoordinator({
      confirmMessage: (count) =>
        `本次新增获取的好友数量过多（${count} 人），是否继续？`,
      confirmRequest,
      getDependencies: () => pageFetchDependencies(runtime, pageWindow),
      getPending: (mode) =>
        mode === "full"
          ? friends
          : findFriendsNeedingActivity(friends, cache, now()),
      keyFor: userIdentifierFor,
      lifecycle: activityLifecycle,
      scheduler,
      taskType: "activity",
      fetchPage: (friend, dependencies) =>
        fetchActivity(
          friend,
          dependencies.fetchImpl,
          dependencies.domParser,
          now,
        ),
    });

    const profileRefresh = createProfileRefreshCoordinator({
      cache,
      confirmMessage: (count) =>
        `本次新增获取的好友数量过多（${count} 人），是否继续？`,
      confirmRequest,
      friends,
      getDependencies: () => pageFetchDependencies(runtime, pageWindow),
      getPending: (target) =>
        target.kind === "relation"
          ? findFriendsNeedingRelation(
              friends,
              cache,
              visitorIdentifier,
              target.metric,
              now(),
            )
          : findFriendsNeedingCompletion(friends, cache, target.scope, now()),
      now,
      lifecycle: profileLifecycle,
      scheduler,
      visitorIdentifier,
    });

    function profileSelectionAction(repeatsCurrentTarget) {
      if (!repeatsCurrentTarget) {
        return {
          clearPrompt: status.getKind() === REFRESH_PROMPT_STATUS,
          refreshMode: "incremental",
        };
      }
      if (status.getKind() === REFRESH_PROMPT_STATUS) {
        return { clearPrompt: true, refreshMode: "full" };
      }
      if (status.getKind() === REFRESH_STATUS.IDLE) return { arm: true };
      return { ignore: true };
    }

    const profileTargetConfigurations = {
      [SORT.RELATION]: {
        choices: RELATION_CHOICES,
        defaultSelection: RELATION_CHOICES[0][0],
        requiresVisitor: true,
        currentSelection: () => relationMetric,
        setSelection: (selection) => {
          relationMetric = selection;
        },
        createTarget: (selection) => ({
          kind: "relation",
          metric: selection,
        }),
      },
      [SORT.COMPLETION]: {
        choices: COMPLETION_CHOICES,
        defaultSelection: COMPLETION_SCOPE.ALL,
        requiresVisitor: false,
        currentSelection: () => completionScope,
        setSelection: (selection) => {
          completionScope = selection;
        },
        createTarget: (selection) => ({
          kind: "completion",
          scope: selection,
        }),
      },
    };

    function selectProfileCriterion(criterion, requestedSubcriterion) {
      const configuration = profileTargetConfigurations[criterion];
      const selection = requestedSubcriterion ?? configuration.defaultSelection;
      if (configuration.requiresVisitor && status.getKind() === LOGIN_STATUS) {
        return;
      }

      const repeatsCurrentTarget =
        currentCriterion === criterion &&
        configuration.currentSelection() === selection;
      if (
        configuration.requiresVisitor &&
        repeatsCurrentTarget &&
        !visitorIdentifier
      ) {
        status.set(LOGIN_STATUS, "请登录后使用喜好契合排序", 5_000);
        return;
      }

      const action = profileSelectionAction(repeatsCurrentTarget);
      if (action.ignore) return;
      if (action.clearPrompt) status.clear();
      if (action.arm) {
        const label =
          configuration.choices.find(([value]) => value === selection)?.[1] ||
          selection;
        status.set(
          REFRESH_PROMPT_STATUS,
          `5 秒内再次点击“${label}”以全量刷新`,
          5_000,
        );
        return;
      }

      configuration.setSelection(selection);
      currentCriterion = criterion;
      controls.setCurrent(
        criterion,
        directionByCriterion.get(criterion),
        selection,
      );
      applyCurrentSort();
      if (configuration.requiresVisitor && !visitorIdentifier) {
        status.set(LOGIN_STATUS, "请登录后使用喜好契合排序", 5_000);
      } else {
        void profileRefresh.start(
          configuration.createTarget(selection),
          action.refreshMode,
        );
      }
    }

    function selectCriterion(criterion, requestedSubcriterion) {
      if (profileTargetConfigurations[criterion]) {
        selectProfileCriterion(criterion, requestedSubcriterion);
        return;
      }

      const action = nextActivitySelectionAction(
        currentCriterion,
        criterion,
        status.getKind(),
      );
      if (action.kind === "ignore") return;

      currentCriterion = criterion;
      controls.setCurrent(
        criterion,
        directionByCriterion.get(criterion),
        selectionFor(criterion),
      );
      applyCurrentSort();

      if (action.clearPrompt) status.clear();
      if (action.kind === "arm") {
        status.set(
          REFRESH_PROMPT_STATUS,
          "5 秒内再次点击“上次活跃”以全量刷新",
          5_000,
        );
      } else if (action.refresh === "incremental") {
        void activityRefresh.start("incremental");
      } else if (action.kind === "refresh" && action.mode === "full") {
        status.clear();
        void activityRefresh.start("full");
      }
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
      { fieldValidators: completionCacheFieldValidators(), now },
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
    completionCacheFieldValidators,
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
    nextActivitySelectionAction,
    createTaskScheduler,
    parseProfileDocument,
    parseTimelineDocument,
    relationFieldFor,
    refreshProfilePages,
    refreshActivities,
    runPageFetchTask,
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
