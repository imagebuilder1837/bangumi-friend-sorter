// ==UserScript==
// @name         Bangumi 好友排序
// @namespace    https://github.com/imagebuilder1837/bangumi-friend-sorter
// @version      0.1.1
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
  const SITE_OFFSET_SECONDS = 8 * 60 * 60;
  const CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v2";
  const LEGACY_CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v1";
  const SORT = Object.freeze({
    ACTIVITY: "activity",
    ADDED: "added",
    NAME: "name",
  });
  const SORT_CHOICES = [
    [SORT.ADDED, "加好友时间"],
    [SORT.NAME, "名称"],
    [SORT.ACTIVITY, "上次活跃"],
  ];

  function isActivityRecord(value) {
    if (!value || !Number.isFinite(value.fetchedAt)) return false;
    if (value.kind === "empty") return true;
    return value.kind === "active" && Number.isInteger(value.activityAtSeconds);
  }

  function createActivityCache(storage) {
    const records = new Map();

    try {
      const saved = JSON.parse(storage?.getItem(CACHE_STORAGE_KEY) || "null");
      if (saved?.version === 2 && saved.records && typeof saved.records === "object") {
        for (const [userId, record] of Object.entries(saved.records)) {
          if (isActivityRecord(record)) records.set(userId, record);
        }
      }
    } catch {
      // The in-memory map remains usable when storage is unavailable or corrupt.
    }

    try {
      storage?.removeItem?.(LEGACY_CACHE_STORAGE_KEY);
    } catch {
      // Removing an obsolete cache is best effort.
    }

    function persist() {
      try {
        storage?.setItem(
          CACHE_STORAGE_KEY,
          JSON.stringify({ version: 2, records: Object.fromEntries(records) }),
        );
      } catch {
        // Keep the newly written record in memory for the current page.
      }
    }

    return {
      entries: () => records.entries(),
      get: (userId) => records.get(userId),
      persist,
      set(userId, record, shouldPersist = true) {
        records.set(userId, record);
        if (shouldPersist) persist();
        return this;
      },
    };
  }

  function sortFriends(
    friends,
    criterion,
    activityByUser = new Map(),
    collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }),
  ) {
    const sorted = [...friends];

    if (criterion === SORT.ADDED) {
      sorted.sort((left, right) => left.originalIndex - right.originalIndex);
    }

    if (criterion === SORT.NAME) {
      sorted.sort((left, right) => {
        return (
          collator.compare(left.displayName, right.displayName) ||
          collator.compare(left.userId, right.userId)
        );
      });
    }

    if (criterion === SORT.ACTIVITY) {
      sorted.sort((left, right) => {
        const leftActivity = activityByUser.get(left.userId);
        const rightActivity = activityByUser.get(right.userId);
        const leftHasTime = leftActivity?.kind === "active";
        const rightHasTime = rightActivity?.kind === "active";

        if (leftHasTime && rightHasTime) {
          return rightActivity.activityAtSeconds - leftActivity.activityAtSeconds ||
            left.originalIndex - right.originalIndex;
        }
        if (leftHasTime) return -1;
        if (rightHasTime) return 1;
        return left.originalIndex - right.originalIndex;
      });
    }

    return sorted;
  }

  function findFriendsNeedingActivity(friends, activityByUser, now) {
    return friends.filter((friend) => {
      const activity = activityByUser.get(friend.userId);
      return !activity || now - activity.fetchedAt > CACHE_TTL_MS;
    });
  }

  function parseSiteTimestampParts(value) {
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      value || "",
    );
    if (!match) return null;

    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
    const [year, month, day, hour, minute] = [
      yearText,
      monthText,
      dayText,
      hourText,
      minuteText,
    ].map(Number);
    const second = secondText === undefined ? 0 : Number(secondText);
    const parsedSeconds =
      Date.UTC(year, month - 1, day, hour, minute, second) / 1_000 - SITE_OFFSET_SECONDS;
    const parsed = new Date((parsedSeconds + SITE_OFFSET_SECONDS) * 1_000);
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
    if (cursor !== body.length || tokens.length < 1 || tokens.length > 2) return null;
    if (tokens.length === 2 && tokens[1].rank !== tokens[0].rank - 1) return null;

    const totalSeconds = tokens.every(({ unit }) => unit === "分" || unit === "秒")
      ? tokens.reduce(
          (total, token) => total + token.amount * (token.unit === "分" ? 60 : 1),
          0,
        )
      : null;
    return { totalSeconds };
  }

  function matchesSiteMinute(epochSeconds, timestampParts) {
    const siteDate = new Date((epochSeconds + SITE_OFFSET_SECONDS) * 1_000);
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
      return timeline.textContent.trim() === "" ? { kind: "empty" } : { kind: "invalid" };
    }

    const timestampNode = firstItem?.querySelector(".post_actions .titleTip[title]");
    const timestamp = timestampNode?.getAttribute("title");
    const timestampParts = parseSiteTimestampParts(timestamp);
    let activityAtSeconds = timestampParts?.epochSeconds ?? null;

    if (
      activityAtSeconds !== null &&
      !timestampParts.hasExplicitSeconds &&
      Number.isFinite(referenceAtSeconds)
    ) {
      const relative = parseRelativeTime(timestampNode.textContent);
      if (relative?.totalSeconds !== null && relative?.totalSeconds !== undefined) {
        const inferred = Math.trunc(referenceAtSeconds) - relative.totalSeconds;
        if (matchesSiteMinute(inferred, timestampParts)) activityAtSeconds = inferred;
      }
    }

    return activityAtSeconds === null ? { kind: "invalid" } : { kind: "active", activityAtSeconds };
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

  function readFriends(list) {
    const elements = [...list.children];
    const friends = elements.map((element, originalIndex) => {
      const anchor = element.querySelector('a.avatar[href*="/user/"]');
      if (!anchor) return null;

      let userId;
      try {
        const pathname = new URL(anchor.getAttribute("href"), window.location.href).pathname;
        const match = /^\/user\/([^/]+)\/?$/.exec(pathname);
        userId = match ? decodeURIComponent(match[1]) : null;
      } catch {
        return null;
      }

      const displayName = anchor.textContent.trim();
      if (!userId || !displayName) return null;
      return { displayName, element, originalIndex, userId };
    });

    return friends.every(Boolean) ? friends : [];
  }

  function applyFriendSort(list, friends, criterion, activityByUser, collator) {
    for (const friend of sortFriends(friends, criterion, activityByUser, collator)) {
      list.append(friend.element);
    }
  }

  function installStyles(document) {
    const style = document.createElement("style");
    style.textContent = `
      #bangumi-friend-sorter.filters {
        align-items: baseline;
        display: flex;
        flex-wrap: wrap;
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

  function createSortBar(document, onSelect) {
    const bar = document.createElement("div");
    bar.id = "browserTools";
    bar.className = "clearit";
    bar.dataset.friendSorter = "";
    bar.setAttribute("aria-label", "好友排序");

    const filters = document.createElement("div");
    filters.className = "filters";
    filters.id = "bangumi-friend-sorter";
    filters.append("按");

    const buttons = new Map();
    for (const [criterion, label] of SORT_CHOICES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "l";
      button.textContent = label;
      button.addEventListener("click", () => onSelect(criterion));
      filters.append(button);
      buttons.set(criterion, button);
    }

    filters.append("排序");
    const status = document.createElement("span");
    status.id = "bangumi-friend-sorter-status";
    status.setAttribute("aria-live", "polite");
    filters.append(status);
    bar.append(filters);

    return {
      bar,
      setCurrent(criterion) {
        for (const [value, button] of buttons) {
          if (value === criterion) button.setAttribute("aria-current", "true");
          else button.removeAttribute("aria-current");
        }
      },
      status,
    };
  }

  async function fetchActivity(friend, fetchImpl, domParser, now) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetchImpl(`/user/${encodeURIComponent(friend.userId)}/timeline`, {
        credentials: "same-origin",
        signal: controller.signal,
      });
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
    let nextIndex = 0;
    let completed = 0;
    let failures = 0;
    let batchState = { consecutiveServerFailures: 0, stopped: false };

    async function worker() {
      while (!batchState.stopped) {
        const index = nextIndex;
        if (index >= friends.length) return;
        nextIndex += 1;

        const friend = friends[index];
        const outcome = await fetchActivity(
          friend,
          options.fetchImpl,
          options.domParser,
          options.now,
        );
        completed += 1;

        if (outcome.kind === "success") {
          options.cache.set(friend.userId, outcome.record, false);
        } else {
          failures += 1;
        }
        batchState = nextBatchState(batchState, outcome);
        options.onProgress(completed, friends.length);
      }
    }

    const workerCount = Math.min(4, friends.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const unattempted = friends.length - nextIndex;
    if (unattempted > 0) {
      completed += unattempted;
      failures += unattempted;
      options.onProgress(completed, friends.length);
    }
    options.cache.persist();
    return { failures };
  }

  function browserStorage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  function initialize() {
    const list = document.querySelector("#memberUserList");
    if (!list || list.children.length === 0) return;

    const friends = readFriends(list);
    if (friends.length !== list.children.length) return;

    const activityCache = createActivityCache(browserStorage());
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    let currentCriterion = SORT.ADDED;
    let activityTask = null;
    let statusTimer = null;

    function setStatus(message, clearAfterMs = 0) {
      clearTimeout(statusTimer);
      controls.status.textContent = message;
      if (clearAfterMs > 0) {
        statusTimer = setTimeout(() => {
          controls.status.textContent = "";
        }, clearAfterMs);
      }
    }

    async function startActivityRefresh() {
      if (activityTask) return activityTask;

      const pending = findFriendsNeedingActivity(friends, activityCache, Date.now());
      if (pending.length === 0) return null;
      if (
        needsLargeRequestConfirmation(pending.length) &&
        !window.confirm(
          `需要获取的好友数量过多（${pending.length} 人），是否继续？`,
        )
      ) {
        return null;
      }

      setStatus(`正在获取 0/${pending.length}`);
      activityTask = refreshActivities(pending, {
        cache: activityCache,
        domParser: new DOMParser(),
        fetchImpl: window.fetch.bind(window),
        now: Date.now,
        onProgress(completed, total) {
          setStatus(`正在获取 ${completed}/${total}`);
        },
      });

      try {
        const { failures } = await activityTask;
        if (currentCriterion === SORT.ACTIVITY) {
          applyFriendSort(list, friends, SORT.ACTIVITY, activityCache, collator);
        }
        setStatus(failures ? `获取完成，${failures} 人失败` : "获取完成", 5_000);
      } finally {
        activityTask = null;
      }
      return null;
    }

    function selectCriterion(criterion) {
      currentCriterion = criterion;
      controls.setCurrent(criterion);
      applyFriendSort(list, friends, criterion, activityCache, collator);
      if (criterion === SORT.ACTIVITY) void startActivityRefresh();
    }

    const controls = createSortBar(document, selectCriterion);
    installStyles(document);
    list.before(controls.bar);
    controls.setCurrent(currentCriterion);
  }

  const core = {
    createActivityCache,
    findFriendsNeedingActivity,
    needsLargeRequestConfirmation,
    nextBatchState,
    parseTimelineDocument,
    refreshActivities,
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
