// ==UserScript==
// @name         Bangumi 好友排序
// @namespace    https://github.com/imagebuilder1837/bangumi-friend-sorter
// @version      0.1.4
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
  const COMPLETION_CACHE_TTL_MS = 72 * 60 * 60 * 1_000;
  const SITE_OFFSET_SECONDS = 8 * 60 * 60;
  const CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v3";
  const PREVIOUS_CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v2";
  const LEGACY_CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v1";
  const SORT = Object.freeze({
    ACTIVITY: "activity",
    ADDED: "added",
    COMPLETION: "completion",
    NAME: "name",
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
  const ACTIVITY_STATUS = Object.freeze({
    ARMED: "armed",
    COMPLETED: "completed",
    FETCHING: "fetching",
    IDLE: "idle",
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

  function directionLabelsFor(criterion) {
    if (criterion === SORT.NAME) {
      return {
        [DIRECTION.ASCENDING]: "升序",
        [DIRECTION.DESCENDING]: "降序",
      };
    }
    if (criterion === SORT.COMPLETION) {
      return {
        [DIRECTION.ASCENDING]: "从低到高",
        [DIRECTION.DESCENDING]: "从高到低",
      };
    }
    return {
      [DIRECTION.ASCENDING]: "从旧到新",
      [DIRECTION.DESCENDING]: "从新到旧",
    };
  }

  function defaultDirectionFor(criterion) {
    return criterion === SORT.NAME || criterion === SORT.ADDED
      ? DIRECTION.ASCENDING
      : DIRECTION.DESCENDING;
  }

  function isAscendingDirection(direction, criterion) {
    const effectiveDirection = direction || defaultDirectionFor(criterion);
    return effectiveDirection === DIRECTION.ASCENDING;
  }

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

    function validateFields(value) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return {};

      const fields = {};
      for (const [field, fieldValue] of Object.entries(value)) {
        const validator = validators.get(field);
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
      persist,
      setField(userIdentifier, field, value, shouldPersist = true) {
        const validator = validators.get(field);
        if (typeof validator !== "function" || !validator(value)) {
          return this;
        }
        const fields = records.get(userIdentifier) || {};
        fields[field] = value;
        records.set(userIdentifier, fields);
        if (shouldPersist) persist();
        return this;
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

  // 保留 activity-only 适配边界供渐进迁移中的旧调用方使用；调用方迁移到
  // createFriendCache 后即可删除该适配器。
  function createActivityCache(storage, options) {
    const cache = createFriendCache(storage, options);
    return {
      entries() {
        return (function* () {
          for (const [userIdentifier, fields] of cache.entries()) {
            yield [userIdentifier, fields.activity];
          }
        })();
      },
      get: (userIdentifier) => cache.getField(userIdentifier, "activity"),
      persist: () => cache.persist(),
      set(userIdentifier, record, shouldPersist = true) {
        cache.setField(userIdentifier, "activity", record, shouldPersist);
        return this;
      },
    };
  }

  function activityCacheView(cache) {
    return {
      get: (userIdentifier) => cache.getField(userIdentifier, "activity"),
      persist: () => cache.persist(),
      set(userIdentifier, record, shouldPersist = true) {
        cache.setField(userIdentifier, "activity", record, shouldPersist);
        return this;
      },
    };
  }

  function sortFriends(
    friends,
    criterion,
    activityByUser = new Map(),
    collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    }),
    direction,
    completionScope = COMPLETION_SCOPE.ALL,
  ) {
    const sorted = [...friends];
    const isAscending = isAscendingDirection(direction, criterion);

    if (criterion === SORT.ADDED) {
      sorted.sort(
        (left, right) =>
          (left.originalIndex - right.originalIndex) * (isAscending ? 1 : -1),
      );
    }

    if (criterion === SORT.NAME) {
      sorted.sort((left, right) => {
        return (
          (isAscending ? 1 : -1) *
          (collator.compare(left.displayName, right.displayName) ||
            collator.compare(userIdentifierFor(left), userIdentifierFor(right)))
        );
      });
    }

    if (criterion === SORT.ACTIVITY) {
      sorted.sort((left, right) => {
        const leftActivity = activityByUser.get(userIdentifierFor(left));
        const rightActivity = activityByUser.get(userIdentifierFor(right));
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
      });
    }

    if (criterion === SORT.COMPLETION) {
      sorted.sort((left, right) => {
        const leftCompletion = completionRecordFor(
          activityByUser,
          userIdentifierFor(left),
          completionScope,
        );
        const rightCompletion = completionRecordFor(
          activityByUser,
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
      });
    }

    return sorted;
  }

  function findFriendsNeedingActivity(friends, activityByUser, now) {
    return friends.filter((friend) => {
      const activity = activityByUser.get(userIdentifierFor(friend));
      return !activity || now - activity.fetchedAt > CACHE_TTL_MS;
    });
  }

  function nextActivitySelectionAction(
    currentCriterion,
    requestedCriterion,
    statusKind,
  ) {
    if (requestedCriterion !== SORT.ACTIVITY) {
      return statusKind === ACTIVITY_STATUS.ARMED
        ? { kind: "sort", clearPrompt: true }
        : { kind: "sort" };
    }
    if (currentCriterion !== SORT.ACTIVITY) {
      return statusKind === ACTIVITY_STATUS.IDLE
        ? { kind: "sort", refresh: "incremental" }
        : { kind: "sort" };
    }
    if (statusKind === ACTIVITY_STATUS.IDLE) return { kind: "arm" };
    if (statusKind === ACTIVITY_STATUS.ARMED) {
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

  async function runPageFetchTask(items, options) {
    let nextIndex = 0;
    let completed = 0;
    let failures = 0;
    let batchState = { consecutiveServerFailures: 0, stopped: false };

    async function worker() {
      while (!batchState.stopped) {
        const index = nextIndex;
        if (index >= items.length) return;
        nextIndex += 1;

        let outcome;
        try {
          outcome = await options.fetchPage(items[index]);
        } catch {
          outcome = { kind: "network-error" };
        }
        if (!outcome || typeof outcome !== "object") {
          outcome = { kind: "network-error" };
        }

        completed += 1;
        if (outcome.kind === "success") {
          options.onSuccess?.(items[index], outcome.record, outcome);
        } else {
          failures += 1;
        }
        batchState = nextBatchState(batchState, outcome);
        options.onProgress?.(completed, items.length);
      }
    }

    const workerCount = Math.min(4, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const unattempted = items.length - nextIndex;
    if (unattempted > 0) {
      completed += unattempted;
      failures += unattempted;
      options.onProgress?.(completed, items.length);
    }
    return { failures, stopped: batchState.stopped };
  }

  function parseCompletionCount(block) {
    const descriptions = [...(block?.querySelectorAll?.(".desc") || [])];
    const description = descriptions.find(
      (node) => node.textContent.trim() === "完成",
    );
    if (!description) return null;

    let card = description;
    while (card && card !== block) {
      const numberNode = card.querySelector?.(".num");
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

  function statsBlockFor(document, container, scope) {
    const selector = `#userStats_${scope}`;
    return (
      container.querySelector?.(selector) || document.querySelector?.(selector)
    );
  }

  function parseProfileDocument(document) {
    const container = document?.querySelector?.("#userStatsContainers");
    if (!container) return { kind: "invalid" };

    const childCount = container.children?.length ?? 0;
    if (childCount === 0 && container.textContent.trim() === "") {
      return {
        kind: "success",
        values: Object.fromEntries(
          COMPLETION_CHOICES.map(([scope]) => [scope, 0]),
        ),
      };
    }

    const aggregate = statsBlockFor(document, container, COMPLETION_SCOPE.ALL);
    const aggregateValue = parseCompletionCount(aggregate);
    if (!aggregate || aggregateValue === null) return { kind: "invalid" };

    const values = { [COMPLETION_SCOPE.ALL]: aggregateValue };
    for (const [scope] of COMPLETION_CHOICES.slice(1)) {
      const block = statsBlockFor(document, container, scope);
      if (!block) {
        values[scope] = 0;
        continue;
      }
      const value = parseCompletionCount(block);
      if (value !== null) values[scope] = value;
    }

    return { kind: "success", values };
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

  async function fetchProfile(friend, fetchImpl, domParser, now) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetchImpl(
        `/user/${encodeURIComponent(userIdentifierFor(friend))}`,
        {
          credentials: "same-origin",
          signal: controller.signal,
        },
      );
      if (!response.ok) return { kind: "http-error", status: response.status };

      const html = await response.text();
      const fetchedAt = now();
      const document = domParser.parseFromString(html, "text/html");
      const parsed = parseProfileDocument(document);
      if (parsed.kind === "invalid") return { kind: "parse-error" };
      return { kind: "success", record: { values: parsed.values, fetchedAt } };
    } catch {
      return { kind: "network-error" };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refreshCompletions(friends, options) {
    const result = await runPageFetchTask(friends, {
      fetchPage: (friend) =>
        fetchProfile(friend, options.fetchImpl, options.domParser, options.now),
      onSuccess(friend, record) {
        for (const [scope, value] of Object.entries(record.values)) {
          options.cache.setField(
            userIdentifierFor(friend),
            completionFieldFor(scope),
            { value, fetchedAt: record.fetchedAt },
            false,
          );
        }
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

  function applyFriendSort(
    list,
    friends,
    criterion,
    activityByUser,
    collator,
    direction,
    completionScope,
  ) {
    for (const friend of sortFriends(
      friends,
      criterion,
      activityByUser,
      collator,
      direction,
      completionScope,
    )) {
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
        top: calc(100% + 3px);
        transform: translateY(-4px);
        transition: opacity .15s ease, transform .15s ease, visibility .15s;
        visibility: hidden;
        z-index: 10;
      }
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

    const completionDropdown = document.createElement("span");
    completionDropdown.className = "bangumi-friend-sorter-dropdown";
    const completionButton = document.createElement("button");
    completionButton.type = "button";
    completionButton.className = "l bangumi-friend-sorter-dropdown-toggle";
    completionButton.textContent = "完成条目数";
    completionButton.setAttribute("aria-haspopup", "true");
    completionButton.setAttribute(
      "aria-controls",
      "bangumi-friend-sorter-completion-menu",
    );
    completionButton.addEventListener("click", () => {
      onSelect(SORT.COMPLETION, COMPLETION_SCOPE.ALL);
      completionButton.focus?.();
    });
    const completionMenu = document.createElement("span");
    completionMenu.id = "bangumi-friend-sorter-completion-menu";
    completionMenu.className = "bangumi-friend-sorter-dropdown-menu";
    completionMenu.setAttribute("role", "menu");
    const completionButtons = new Map();
    for (const [scope, label] of COMPLETION_CHOICES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "l";
      button.textContent = label;
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", () => onSelect(SORT.COMPLETION, scope));
      completionMenu.append(button);
      completionButtons.set(scope, button);
    }
    completionDropdown.append(completionButton, completionMenu);
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
        completionScope = COMPLETION_SCOPE.ALL,
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
        for (const [scope, button] of completionButtons) {
          if (criterion === SORT.COMPLETION && scope === completionScope) {
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
      completionButton,
      completionMenu,
      completionButtons,
    };
  }

  async function fetchActivity(friend, fetchImpl, domParser, now) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetchImpl(
        `/user/${encodeURIComponent(userIdentifierFor(friend))}/timeline`,
        {
          credentials: "same-origin",
          signal: controller.signal,
        },
      );
      if (!response.ok) return { kind: "http-error", status: response.status };

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
    } catch {
      return { kind: "network-error" };
    } finally {
      clearTimeout(timeout);
    }
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
        options.cache.set(userIdentifierFor(friend), record, false);
      },
      onProgress: options.onProgress,
    });
    options.cache.persist();
    return { failures: result.failures };
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

  function initialize(runtime = {}) {
    const pageDocument = runtime.document ?? document;
    const pageWindow = runtime.window ?? window;
    const list = pageDocument.querySelector("#memberUserList");
    if (!list || list.children.length === 0) return;

    const friends = readFriends(list, pageWindow.location.href);
    if (friends.length !== list.children.length) return;

    const now = runtime.now ?? Date.now;
    const friendCache = createFriendCache(
      runtime.storage ?? browserStorage(pageWindow),
      { fieldValidators: completionCacheFieldValidators(), now },
    );
    const activityCache = activityCacheView(friendCache);
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    let currentCriterion = SORT.ADDED;
    let completionScope = COMPLETION_SCOPE.ALL;
    const directionByCriterion = new Map(
      [...SORT_CHOICES.map(([criterion]) => criterion), SORT.COMPLETION].map(
        (criterion) => [criterion, defaultDirectionFor(criterion)],
      ),
    );
    let activityTask = null;
    let completionTask = null;
    let statusTimer = null;
    let statusKind = ACTIVITY_STATUS.IDLE;
    const confirmRequest =
      runtime.confirm ?? pageWindow.confirm?.bind(pageWindow) ?? (() => false);

    function clearStatus() {
      clearTimeout(statusTimer);
      statusTimer = null;
      statusKind = ACTIVITY_STATUS.IDLE;
      controls.status.textContent = "";
    }

    function setStatus(kind, message, clearAfterMs = 0) {
      clearStatus();
      statusKind = kind;
      controls.status.textContent = message;
      if (clearAfterMs > 0) {
        statusTimer = setTimeout(clearStatus, clearAfterMs);
      }
    }

    async function startActivityRefresh(mode = "incremental") {
      if (activityTask) return activityTask;

      const pending =
        mode === "full"
          ? friends
          : findFriendsNeedingActivity(friends, activityCache, now());
      if (pending.length === 0) return null;
      if (
        needsLargeRequestConfirmation(pending.length) &&
        !confirmRequest(
          `需要获取的好友数量过多（${pending.length} 人），是否继续？`,
        )
      ) {
        return null;
      }

      const dependencies = pageFetchDependencies(runtime, pageWindow);
      if (!dependencies) return null;

      setStatus(ACTIVITY_STATUS.FETCHING, `正在获取 0/${pending.length}`);
      activityTask = refreshActivities(pending, {
        cache: activityCache,
        domParser: dependencies.domParser,
        fetchImpl: dependencies.fetchImpl,
        now,
        onProgress(completed, total) {
          setStatus(ACTIVITY_STATUS.FETCHING, `正在获取 ${completed}/${total}`);
          runtime.onProgress?.(completed, total);
        },
      });

      try {
        const { failures } = await activityTask;
        if (currentCriterion === SORT.ACTIVITY) {
          applyFriendSort(
            list,
            friends,
            SORT.ACTIVITY,
            activityCache,
            collator,
            directionByCriterion.get(SORT.ACTIVITY),
          );
        }
        setStatus(
          ACTIVITY_STATUS.COMPLETED,
          failures ? `获取完成，${failures} 人失败` : "获取完成",
          5_000,
        );
      } finally {
        activityTask = null;
      }
      return null;
    }

    async function startCompletionRefresh() {
      if (completionTask) return completionTask;

      const pending = findFriendsNeedingCompletion(
        friends,
        friendCache,
        completionScope,
        now(),
      );
      if (pending.length === 0) return null;
      if (
        needsLargeRequestConfirmation(pending.length) &&
        !confirmRequest(
          `需要获取的好友数量过多（${pending.length} 人），是否继续？`,
        )
      ) {
        return null;
      }

      const dependencies = pageFetchDependencies(runtime, pageWindow);
      if (!dependencies) return null;

      setStatus(
        ACTIVITY_STATUS.FETCHING,
        `正在获取“完成条目数” 0/${pending.length}`,
      );
      completionTask = refreshCompletions(pending, {
        cache: friendCache,
        domParser: dependencies.domParser,
        fetchImpl: dependencies.fetchImpl,
        now,
        onProgress(completed, total) {
          setStatus(
            ACTIVITY_STATUS.FETCHING,
            `正在获取“完成条目数” ${completed}/${total}`,
          );
          runtime.onProgress?.(completed, total);
        },
      });

      try {
        const { failures } = await completionTask;
        if (currentCriterion === SORT.COMPLETION) {
          applyFriendSort(
            list,
            friends,
            SORT.COMPLETION,
            friendCache,
            collator,
            directionByCriterion.get(SORT.COMPLETION),
            completionScope,
          );
        }
        setStatus(
          ACTIVITY_STATUS.COMPLETED,
          failures
            ? `“完成条目数”获取完成，${failures} 人失败`
            : "“完成条目数”获取完成",
          5_000,
        );
      } finally {
        completionTask = null;
      }
      return null;
    }

    function selectCriterion(criterion, requestedCompletionScope) {
      if (criterion === SORT.COMPLETION) {
        if (statusKind === ACTIVITY_STATUS.ARMED) clearStatus();
        completionScope = requestedCompletionScope || COMPLETION_SCOPE.ALL;
        currentCriterion = criterion;
        const direction = directionByCriterion.get(criterion);
        controls.setCurrent(criterion, direction, completionScope);
        applyFriendSort(
          list,
          friends,
          criterion,
          friendCache,
          collator,
          direction,
          completionScope,
        );
        void startCompletionRefresh();
        return;
      }

      const action = nextActivitySelectionAction(
        currentCriterion,
        criterion,
        statusKind,
      );
      if (action.kind === "ignore") return;

      currentCriterion = criterion;
      const direction = directionByCriterion.get(criterion);
      controls.setCurrent(criterion, direction, completionScope);
      applyFriendSort(
        list,
        friends,
        criterion,
        activityCache,
        collator,
        direction,
        completionScope,
      );

      if (action.clearPrompt) clearStatus();
      if (action.kind === "arm") {
        setStatus(
          ACTIVITY_STATUS.ARMED,
          "5 秒内再次点击“上次活跃”以全量刷新",
          5_000,
        );
      } else if (action.refresh === "incremental") {
        void startActivityRefresh("incremental");
      } else if (action.kind === "refresh" && action.mode === "full") {
        clearStatus();
        void startActivityRefresh("full");
      }
    }

    function selectDirection(direction) {
      if (directionByCriterion.get(currentCriterion) === direction) return;

      directionByCriterion.set(currentCriterion, direction);
      controls.setCurrent(currentCriterion, direction, completionScope);
      applyFriendSort(
        list,
        friends,
        currentCriterion,
        activityCache,
        collator,
        direction,
        completionScope,
      );
    }

    const controls = createSortBar(
      pageDocument,
      selectCriterion,
      selectDirection,
    );
    if (!mountSortBar(pageDocument, list, controls.bar)) return;
    installStyles(pageDocument);
    controls.setCurrent(
      currentCriterion,
      directionByCriterion.get(currentCriterion),
      completionScope,
    );
  }

  const core = {
    COMPLETION_CHOICES,
    COMPLETION_SCOPE,
    createActivityCache,
    createFriendCache,
    createSortBar,
    completionCacheFieldValidators,
    completionFieldFor,
    directionLabelsFor,
    findFriendsNeedingCompletion,
    findFriendsNeedingActivity,
    fetchProfile,
    initialize,
    isCompletionRecord,
    needsLargeRequestConfirmation,
    nextBatchState,
    nextActivitySelectionAction,
    parseProfileDocument,
    parseTimelineDocument,
    refreshCompletions,
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
