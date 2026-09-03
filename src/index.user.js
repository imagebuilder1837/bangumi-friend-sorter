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
    const visitors = Object.values(value);
    return (
      visitors.length > 0 &&
      visitors.every((metrics) => {
        if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
          return false;
        }
        const entries = Object.entries(metrics);
        return (
          entries.length > 0 &&
          entries.every(
            ([metric, record]) =>
              RELATION_METRICS.has(metric) && isRelationRecord(record, metric),
          )
        );
      })
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
        const activity = friendCache.activityFor(userIdentifierFor(friend));
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
          const completion = friendCache.completionFor(
            userIdentifierFor(friend),
            completionScope,
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
          const relation = friendCache.relationFor(
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

    function fieldFor(userIdentifier, field) {
      return records.get(userIdentifier)?.[field];
    }

    function relationRecordFor(userIdentifier, relationSelection) {
      const { metric, visitorIdentifier } = relationSelection ?? {};
      return records.get(userIdentifier)?.relation?.[visitorIdentifier]?.[
        metric
      ];
    }

    function setField(userIdentifier, field, value) {
      const validator = validatorFor(field);
      if (typeof validator !== "function" || !validator(value)) return;
      const fields = records.get(userIdentifier) || {};
      fields[field] = value;
      records.set(userIdentifier, fields);
    }

    function setRelationField(
      userIdentifier,
      visitorIdentifier,
      metric,
      value,
    ) {
      if (!visitorIdentifier || !isRelationRecord(value, metric)) return;
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
    }

    const cache = {
      activityFor(userIdentifier) {
        return fieldFor(userIdentifier, "activity");
      },
      completionFor(userIdentifier, scope) {
        return fieldFor(userIdentifier, completionFieldFor(scope));
      },
      relationFor(userIdentifier, relationSelection) {
        return relationRecordFor(userIdentifier, relationSelection);
      },
      friendsNeedingRefresh(friends, target, { mode = "incremental" } = {}) {
        if (mode === "full") return [...friends];
        const targetReaders = {
          [SORT.ACTIVITY]: {
            read: (userIdentifier) => cache.activityFor(userIdentifier),
            ttlMs: CACHE_TTL_MS,
          },
          [SORT.COMPLETION]: {
            read: (userIdentifier) =>
              cache.completionFor(userIdentifier, target?.scope),
            ttlMs: PROFILE_CACHE_TTL_MS,
          },
          [SORT.RELATION]: {
            read: (userIdentifier) =>
              cache.relationFor(userIdentifier, {
                metric: target?.metric,
                visitorIdentifier: target?.visitorIdentifier,
              }),
            ttlMs: PROFILE_CACHE_TTL_MS,
          },
        };
        const policy = targetReaders[target?.kind];
        if (!policy) return [];
        const currentTime = now();
        return friends.filter((friend) => {
          const record = policy.read(userIdentifierFor(friend));
          return !record || currentTime - record.fetchedAt > policy.ttlMs;
        });
      },
      beginRefresh({ visitorIdentifier } = {}) {
        let completed = false;
        return {
          accept(userIdentifier, result) {
            if (completed || !userIdentifier || !result) return this;
            if (result.activity) {
              setField(userIdentifier, "activity", result.activity);
            }
            for (const [scope, value] of Object.entries(
              result.completion || {},
            )) {
              setField(userIdentifier, completionFieldFor(scope), {
                value,
                fetchedAt: result.fetchedAt,
              });
            }
            if (visitorIdentifier) {
              for (const [metric, value] of Object.entries(
                result.relation || {},
              )) {
                setRelationField(userIdentifier, visitorIdentifier, metric, {
                  value,
                  fetchedAt: result.fetchedAt,
                });
              }
            }
            return this;
          },
          complete() {
            if (!completed) persist();
            completed = true;
          },
        };
      },
    };
    return cache;
  }

  function relationSelectionFor(relationSelection) {
    return { metric: RELATION_CHOICES[0][0], ...relationSelection };
  }

  // 展示名称比较的唯一配置点：数值感知、大小写不敏感；sortFriends
  // 默认参数与页面初始化共享同一工厂。
  function nameCollator() {
    return new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  function sortFriends(
    friends,
    {
      criterion,
      // Required for the remote sorts (activity/completion/relation); local
      // sorts (added/name) never touch the friend cache.
      friendCache,
      collator = nameCollator(),
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
      const keyFor = options.keyFor ?? ((item) => item);
      const confirmMessage = options.confirmMessage ?? (() => "");
      const isSuccess =
        options.isSuccess ?? ((_record, outcome) => outcome.kind === "success");
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

  // 主页字段的三向结果：成功携带可靠值；缺失表示字段节点未披露（不是
  // 零）；无效表示节点存在但自相矛盾或无法解析。每个字段独立产出结果，
  // 一个字段的失败不抹去同一响应中其他字段的有效结果。
  function successOutcome(value) {
    return { kind: "success", value };
  }

  function syncRateOutcome(synchronize) {
    const node = synchronize?.querySelector?.(".percent_text");
    if (!node) return { kind: "missing" };
    const parsed = parseSyncRate(node);
    return parsed === null ? { kind: "invalid" } : successOutcome(parsed);
  }

  function commonLikesOutcome(synchronize) {
    const match = /(^|[^\d])([+-]?\d[\d,]*(?:\.\d+)?)\s*个共同喜好/.exec(
      synchronize?.textContent || "",
    );
    if (!match) return { kind: "missing" };
    const parsed = Number(match[2].replace(/,/g, ""));
    return Number.isInteger(parsed) && parsed >= 0
      ? successOutcome(parsed)
      : { kind: "invalid" };
  }

  function relationFieldOutcomes(document) {
    const synchronize = document?.querySelector?.(".userSynchronize");
    if (!synchronize) return null;
    return {
      commonLikes: commonLikesOutcome(synchronize),
      syncRate: syncRateOutcome(synchronize),
    };
  }

  function completionFieldOutcomes(document) {
    const container = document?.querySelector?.("#userStatsContainers");
    if (!container) return null;

    const outcomes = {};
    const childCount = container.children?.length ?? 0;
    if (childCount === 0 && container.textContent.trim() === "") {
      for (const [scope] of COMPLETION_CHOICES) {
        outcomes[scope] = successOutcome(0);
      }
      return outcomes;
    }

    const aggregate = statsBlockFor(container, COMPLETION_SCOPE.ALL);
    const aggregateValue =
      aggregate.kind === "found" ? parseCompletionCount(aggregate.block) : null;
    // 聚合块是全部范围的结构前提：它缺失或矛盾时六个范围都无效。
    if (aggregateValue === null) return null;
    outcomes[COMPLETION_SCOPE.ALL] = successOutcome(aggregateValue);

    for (const [scope] of COMPLETION_CHOICES.slice(1)) {
      const stats = statsBlockFor(container, scope);
      if (stats.kind === "missing") {
        // 缺失的分类块可靠地为零（见 docs/spec.md）。
        outcomes[scope] = successOutcome(0);
      } else if (stats.kind === "found") {
        const value = parseCompletionCount(stats.block);
        outcomes[scope] =
          value === null ? { kind: "invalid" } : successOutcome(value);
      } else {
        // 重复的分类块只使自己的范围无效。
        outcomes[scope] = { kind: "invalid" };
      }
    }
    return outcomes;
  }

  // 对解析后的主页文档只做这一遍提取：八个字段各自产出三向结果。
  function parseProfileFieldOutcomes(document) {
    return {
      completion: completionFieldOutcomes(document),
      relation: relationFieldOutcomes(document),
    };
  }

  function successfulOutcomeValues(outcomes) {
    const values = {};
    for (const [selection, outcome] of Object.entries(outcomes || {})) {
      if (outcome.kind === "success") values[selection] = outcome.value;
    }
    return values;
  }

  // 文档级视图，与逐字段结果共享同一遍提取：只有成功的字段值保留，
  // 没有任何有效字段的文档视为无效。
  function parseProfileDocument(document) {
    const outcomes = parseProfileFieldOutcomes(document);
    const completionValues =
      outcomes.completion === null
        ? null
        : successfulOutcomeValues(outcomes.completion);
    const relation =
      outcomes.relation === null
        ? null
        : successfulOutcomeValues(outcomes.relation);
    if (!completionValues && relation === null) return { kind: "invalid" };

    const parsed = { kind: "success" };
    if (completionValues) parsed.completion = completionValues;
    if (relation !== null) parsed.relation = relation;
    return parsed;
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

  // 一次主页请求、一次文档提取：记录按字段携带三向结果，交给主页字段
  // 任务分别判定成功与失败。字段取值收在记录边界的 outcomeFor：
  // 调用方只交字段，kind → selection 的内部形状不外泄。
  async function fetchProfile(friend, fetchImpl, domParser, now) {
    return fetchPageWithTimeout(
      `/user/${encodeURIComponent(userIdentifierFor(friend))}`,
      fetchImpl,
      async (response) => {
        const html = await response.text();
        const fetchedAt = now();
        const document = domParser.parseFromString(html, "text/html");
        const fields = parseProfileFieldOutcomes(document);
        if (fields.completion === null && fields.relation === null) {
          return { kind: "parse-error" };
        }
        const record = { fetchedAt, fields };
        record.outcomeFor = (field) =>
          fields[field.kind]?.[field[REMOTE_TARGET_SELECTION_KEYS[field.kind]]];
        return { kind: "success", record };
      },
    );
  }

  function readFriends(
    list,
    baseUrl = window.location.href,
    pageDocument = window.document,
  ) {
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

      // The gray rule inside a friend item is the site's own border-bottom
      // on ul.usersMedium div.userContainer strong; the 名次 badge anchors
      // to that block. Reading only validates the anchor point — the badge
      // itself is created by the sort bar's render pass.
      const rankHost = element.querySelector(".userContainer strong");
      if (!rankHost) return null;

      return {
        displayName,
        element,
        originalIndex,
        rankHost,
        userIdentifier,
      };
    });

    return friends.every(Boolean) ? friends : [];
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
        padding: 4px 0;
        pointer-events: none;
        position: absolute;
        top: 100%;
        transform: translateY(-4px);
        transition: opacity .15s ease, transform .15s ease, visibility .15s;
        visibility: hidden;
        width: max-content;
        min-width: 118px;
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
        font-size: 12px;
        line-height: 100%;
        margin: 2px 5px;
        padding: 7px 15px;
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
      /* 名次 badge: the host strong is the site's name block whose bottom
         border is the gray rule; the badge hangs just below that line,
         flush with its right end. */
      #memberUserList div.userContainer > strong {
        position: relative;
      }
      #memberUserList .bangumi-friend-sorter-rank {
        color: #000;
        font-weight: bold;
        position: absolute;
        right: 0;
        top: 100%;
      }
      html[data-theme="dark"] #memberUserList
        .bangumi-friend-sorter-rank {
        color: #ddd;
      }
    `;
    document.head.append(style);
  }

  function setAriaCurrent(button, isCurrent) {
    if (isCurrent) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }

  // 排序栏 deep module：排序交互与呈现的唯一边界。`bind` 一次性接收领域
  // 意图回调（选择排序目标、切换方向），`render` 幂等地接收可呈现状态；
  // 菜单、按钮、方向文案、状态提示、名次、ARIA、输入模态、焦点与展开
  // 状态全部留在模块内部，调用方不持有或修改任何原始 DOM 节点。模块不
  // 发起远程请求，也不决定刷新策略。
  // 接口约定：bind 必须在首次 render 前恰好调用一次（相对 mount 的先后
  // 不限）；render 接收完整的可呈现状态，重复调用安全，展示顺序不变时
  // 跳过重排与名次更新。
  function createSortBar(pageDocument, { list }) {
    const bar = pageDocument.createElement("div");
    // Reuse the site's #browserTools frame, including its horizontal borders.
    bar.id = "browserTools";
    bar.className = "clearit bangumi-friend-sorter-bar";
    bar.dataset.friendSorter = "";
    bar.setAttribute("aria-label", "好友排序");

    // 领域意图只通过 bind 声明的回调离开排序栏；绑定前发生的事件（正常
    // 时序下不可能）被静默忽略。
    let handlers = null;

    function bind({ selectCriterion, selectDirection }) {
      if (handlers) throw new Error("排序栏的意图回调只能绑定一次");
      handlers = { selectCriterion, selectDirection };
    }

    const filters = pageDocument.createElement("div");
    filters.className = "filters";
    filters.id = "bangumi-friend-sorter";

    const sortOptions = pageDocument.createElement("span");
    sortOptions.className = "bangumi-friend-sorter-sort-options";
    // Bare text nodes are anonymous flex items and cannot carry margins, so
    // the fixed labels get wrapper spans for the breathing-room gaps.
    const prefix = pageDocument.createElement("span");
    prefix.className = "bangumi-friend-sorter-prefix";
    prefix.textContent = "按";
    sortOptions.append(prefix);

    const buttons = new Map();
    for (const [criterion, label] of SORT_CHOICES) {
      const button = pageDocument.createElement("button");
      button.type = "button";
      button.className = "l";
      button.textContent = label;
      button.addEventListener("click", () =>
        handlers?.selectCriterion(criterion),
      );
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
      const dropdown = pageDocument.createElement("span");
      dropdown.className = "bangumi-friend-sorter-dropdown";

      const toggle = pageDocument.createElement("button");
      toggle.type = "button";
      toggle.className = "l bangumi-friend-sorter-dropdown-toggle";
      toggle.textContent = label;
      toggle.setAttribute("aria-haspopup", "true");
      toggle.setAttribute("aria-controls", id);
      toggle.addEventListener("click", () => {
        onDefaultSelect();
        toggle.focus?.();
      });

      const menu = pageDocument.createElement("span");
      menu.id = id;
      menu.className = "bangumi-friend-sorter-dropdown-menu";
      menu.setAttribute("role", "menu");
      const buttons = new Map();
      for (const [value, choiceLabel] of choices) {
        const button = pageDocument.createElement("button");
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

      // Input modality of whichever pointer/keyboard interaction last took
      // focus inside the dropdown; null means programmatic or unknown focus.
      // Mouse-created focus is transient: it is released when the pointer
      // leaves, while touch/keyboard focus intentionally persists (see ADR 0001).
      let focusModality = null;

      dropdown.addEventListener("pointerdown", (event) => {
        focusModality = event.pointerType || "pointer";
      });

      function keepMenuOpenOnFocus(button) {
        button.addEventListener("focus", () => setMenuOpen(true));
        button.addEventListener("focusout", (event) => {
          if (!isInsideDropdown(event.relatedTarget)) {
            focusModality = null;
            setMenuOpen(false);
          }
        });
        button.addEventListener("keydown", (event) => {
          focusModality = "keyboard";
          if (event.key === "Escape") {
            // Esc 关闭：键盘用户按下 Esc 时释放焦点，焦点离开后菜单
            // 经由既有 focusout 路径收起。
            event.preventDefault?.();
            button.blur?.();
            return;
          }
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault?.();
          button.click();
        });
      }

      dropdown.addEventListener("pointerenter", () => setMenuOpen(true));
      dropdown.addEventListener("pointerleave", (event) => {
        // A desktop mouse click focuses the toggle; when that focus itself
        // came from the mouse, leaving the dropdown releases it so the menu
        // closes instead of lingering.
        if (
          event.pointerType === "mouse" &&
          focusModality === "mouse" &&
          isInsideDropdown(pageDocument.activeElement)
        ) {
          pageDocument.activeElement.blur?.();
          setMenuOpen(false);
          return;
        }
        if (!isInsideDropdown(pageDocument.activeElement)) setMenuOpen(false);
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
      onDefaultSelect: () =>
        handlers?.selectCriterion(SORT.COMPLETION, COMPLETION_SCOPE.ALL),
      onSelect: (scope) => handlers?.selectCriterion(SORT.COMPLETION, scope),
    });
    const completionDropdown = completionControl.dropdown;

    const relationControl = createDropdown({
      id: "bangumi-friend-sorter-relation-menu",
      label: "喜好契合",
      choices: RELATION_CHOICES,
      onDefaultSelect: () =>
        handlers?.selectCriterion(SORT.RELATION, RELATION_CHOICES[0][0]),
      onSelect: (metric) => handlers?.selectCriterion(SORT.RELATION, metric),
    });
    const relationDropdown = relationControl.dropdown;

    sortOptions.append(relationDropdown);
    sortOptions.append(completionDropdown);

    const suffix = pageDocument.createElement("span");
    suffix.className = "bangumi-friend-sorter-suffix";
    suffix.textContent = "排序";
    sortOptions.append(suffix);
    const status = pageDocument.createElement("span");
    status.id = "bangumi-friend-sorter-status";
    status.setAttribute("aria-live", "polite");
    sortOptions.append(status);

    const directionOptions = pageDocument.createElement("span");
    directionOptions.className = "bangumi-friend-sorter-direction-options";
    const directionButtons = new Map();
    const initialDirectionLabels = directionLabelsFor(SORT.ADDED);
    for (const direction of [DIRECTION.ASCENDING, DIRECTION.DESCENDING]) {
      const button = pageDocument.createElement("button");
      button.type = "button";
      button.className = "l";
      button.textContent = initialDirectionLabels[direction];
      button.addEventListener("click", () =>
        handlers?.selectDirection(direction),
      );
      directionOptions.append(button);
      directionButtons.set(direction, button);
    }

    filters.append(sortOptions, directionOptions);
    bar.append(filters);

    // 挂载复用原站 .mainWrapper 布局：排序栏插入 .columns 之前占据整行；
    // 布局不符合预期时不修改页面。站点样式复用与必要 CSS 属于本模块，
    // 在挂载成功后注入。
    function mount() {
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
        installStyles(pageDocument);
        return true;
      }
      if (!canWalkAncestors) {
        list.before(bar);
        installStyles(pageDocument);
        return true;
      }
      return false;
    }

    // 名次徽章按需创建：锚点是读取好友时验证过的原站名称块，初始名次
    // 随第一次 render 按当时展示顺序标注。
    function rankBadgeFor(friend) {
      if (!friend.rankElement) {
        const badge = pageDocument.createElement("span");
        badge.className = "bangumi-friend-sorter-rank";
        friend.rankHost.append(badge);
        friend.rankElement = badge;
      }
      return friend.rankElement;
    }

    let lastOrderElements = null;

    // 幂等呈现：当前选择、方向文案、菜单选中态、刷新状态提示与好友名次
    // 都由这一次渲染更新。展示顺序与上次相同（例如只有状态提示变化）时
    // 跳过重排，保持既有 DOM 操作量级。调用方始终传入完整的可呈现状态。
    function render({
      criterion,
      direction,
      selection,
      statusMessage,
      orderedFriends,
    }) {
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
      if (status.textContent !== statusMessage) {
        status.textContent = statusMessage;
      }

      const elements = orderedFriends.map((friend) => friend.element);
      const orderChanged =
        !lastOrderElements ||
        lastOrderElements.length !== elements.length ||
        lastOrderElements.some((element, index) => element !== elements[index]);
      if (!orderChanged) return;
      lastOrderElements = elements;
      orderedFriends.forEach((friend, index) => {
        list.append(friend.element);
        rankBadgeFor(friend).textContent = `#${index + 1}`;
      });
    }

    return { bind, mount, render };
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

  function browserStorage(pageWindow = window) {
    try {
      return pageWindow.localStorage;
    } catch {
      return null;
    }
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

  // 主页字段任务 deep module：拥有八个主页字段（六个完成统计范围与同步
  // 率、共同喜好数两个契合指标）的字段语义、同一批次内单次可复用的主页
  // 请求、任务合并扩充与字段级成功失败统计。调用方只声明当前排序需要的
  // 字段，不再拼装解析、调度或缓存写入细节。
  const PROFILE_TASK_TYPE = "profile";
  const PROFILE_FIELD_GROUP_LABELS = Object.freeze({
    [SORT.COMPLETION]: "完成条目数",
    [SORT.RELATION]: "喜好契合",
  });

  function profileFieldLabelFor(field) {
    return PROFILE_FIELD_GROUP_LABELS[field?.kind] ?? "";
  }

  // Bridges one page task's lifecycle to a friend-cache refresh batch: the
  // batch opens when the task starts fetching, accepts each friend's result
  // and commits once when the task finishes. Callers never touch persistence.
  function createCacheBatchLifecycle({ cache, status }) {
    return ({
      applySort,
      labelFor,
      progressReporter,
      projectResult,
      taskType,
      visitorIdentifier,
    }) => {
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
    };
  }

  // Starts a foreground scheduler task for one refresh; guarded so a
  // stopped scheduler or missing fetch dependencies never enqueue work.
  function startForegroundTask({
    confirmRequest,
    dependencies,
    fetch,
    isSuccess = (_record, outcome) => outcome.kind === "success",
    keyFor,
    lifecycle = {},
    pending,
    scheduler,
    target,
    taskType,
  }) {
    if (scheduler.isGloballyStopped() || !dependencies()) return null;
    if (pending.length === 0 && !scheduler.getTask(taskType)) return null;
    const { task } = scheduler.enqueue(
      taskType,
      pending,
      {
        confirmMessage: (count) =>
          `本次新增获取的好友数量过多（${count} 人），是否继续？`,
        confirmRequest,
        fetch: (item) => {
          const pageDependencies = dependencies();
          if (!pageDependencies) return { kind: "network-error" };
          return fetch(item, pageDependencies);
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

  function createProfileFieldTasks({
    applySort,
    cache,
    confirmRequest,
    dependencies,
    friends,
    now,
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
      return (
        outcome.kind === "success" &&
        record?.outcomeFor?.(field)?.kind === "success"
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

    const cacheLifecycle = createCacheBatchLifecycle({ cache, status });
    const lifecycle = cacheLifecycle({
      applySort,
      labelFor: profileFieldLabelFor,
      progressReporter,
      projectResult: cacheResultFor,
      taskType: PROFILE_TASK_TYPE,
      visitorIdentifier,
    });

    // 声明一个当前排序需要的主页字段：按字段判断待请求好友，合并进运行
    // 中的主页任务或创建新任务。同一好友在整个任务内最多请求一次，而一
    // 次响应解析全部八个字段，因此已排队和在途好友天然服务新增字段需求。
    function refresh(field, mode = "incremental") {
      return startForegroundTask({
        confirmRequest,
        dependencies,
        fetch: (friend, pageDependencies) =>
          fetchProfile(
            friend,
            pageDependencies.fetchImpl,
            pageDependencies.domParser,
            now,
          ),
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

  // 远程排序会话 deep module：页面初始化后的最高层业务边界。会话只通过
  // start、choose 与 changeDirection 接收外部命令；内部私有状态机与任务
  // 登记表共同拥有当前排序目标、子选项、方向记忆、增量刷新、连续两次选
  // 择触发的全量刷新、登录前置条件、请求先后关系与提示优先级，并编排好
  // 友缓存、活跃任务、主页字段任务、排序函数与排序栏。任务登记表、状态
  // 机与排序栏内部节点均不向外暴露。
  function createFriendSortSession({
    cache,
    collator,
    friends,
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
    const getDependencies = () => pageFetchDependencies(runtime, pageWindow);

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

    const cacheLifecycle = createCacheBatchLifecycle({ cache, status });
    const activityLifecycle = cacheLifecycle({
      applySort: applyActivitySort,
      labelFor: () => "上次活跃",
      progressReporter: showActivityProgress,
      projectResult: (activity) => ({ activity }),
      taskType: ACTIVITY_TASK_TYPE,
    });

    const profileFields = createProfileFieldTasks({
      applySort: applyProfileSort,
      cache,
      confirmRequest,
      dependencies: getDependencies,
      friends,
      now,
      onProgress: runtime.onProgress,
      scheduler,
      status,
      visitorIdentifier,
    });

    function startActivity(mode) {
      return startForegroundTask({
        confirmRequest,
        dependencies: getDependencies,
        fetch: (friend, dependencies) =>
          fetchActivity(
            friend,
            dependencies.fetchImpl,
            dependencies.domParser,
            now,
          ),
        keyFor: userIdentifierFor,
        lifecycle: activityLifecycle,
        pending: cache.friendsNeedingRefresh(
          friends,
          { kind: SORT.ACTIVITY },
          { mode },
        ),
        scheduler,
        target: mode,
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
    let lastOrderedFriends = [];

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
        lastOrderedFriends = sortFriends(friends, {
          criterion: currentCriterion,
          friendCache: cache,
          collator,
          direction,
          completionScope,
          relationSelection: {
            metric: relationMetric,
            visitorIdentifier,
          },
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
        startRefresh: (_target, mode) => startActivity(mode),
      },
      [SORT.RELATION]: {
        armMessageFor: (selection) =>
          choiceLabelFor(RELATION_CHOICES, selection),
        defaultSelection: RELATION_CHOICES[0][0],
        requiresVisitor: true,
        setSelection: (selection) => {
          relationMetric = selection;
        },
        startRefresh: (target, mode) => profileFields.refresh(target, mode),
      },
      [SORT.COMPLETION]: {
        armMessageFor: (selection) =>
          choiceLabelFor(COMPLETION_CHOICES, selection),
        defaultSelection: COMPLETION_SCOPE.ALL,
        requiresVisitor: false,
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

  function initialize(runtime = {}) {
    const pageDocument = runtime.document ?? document;
    const pageWindow = runtime.window ?? window;
    const list = pageDocument.querySelector("#memberUserList");
    if (!list || list.children.length === 0) return;

    const friends = readFriends(list, pageWindow.location.href, pageDocument);
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
    const collator = nameCollator();
    const sortBar = createSortBar(pageDocument, { list });
    if (!sortBar.mount()) return;
    const session = createFriendSortSession({
      cache,
      collator,
      friends,
      now,
      pageWindow,
      runtime,
      sortBar,
      visitorIdentifier,
    });
    // 页面入口只创建会话并启动：后续交互全部经 choose 与 changeDirection
    // 进入业务流程。
    sortBar.bind({
      selectCriterion: (criterion, selection) =>
        session.choose(criterion, selection),
      selectDirection: (direction) => session.changeDirection(direction),
    });
    session.start();
  }

  const core = {
    createFriendCache,
    createFriendSortSession,
    createSortBar,
    createTaskScheduler,
    currentVisitorIdentifier,
    directionLabelsFor,
    fetchProfile,
    initialize,
    needsLargeRequestConfirmation,
    nextBatchState,
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
