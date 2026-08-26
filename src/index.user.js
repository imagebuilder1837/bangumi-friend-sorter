// ==UserScript==
// @name         Bangumi 好友排序
// @namespace    https://github.com/imagebuilder1837/bangumi-friend-sorter
// @version      0.1.0
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
  const CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v1";

  function isActivityRecord(value) {
    if (!value || !Number.isFinite(value.fetchedAt)) return false;
    if (value.kind === "empty") return true;
    return value.kind === "active" && Number.isFinite(value.activityAt);
  }

  function createActivityCache(storage) {
    const records = new Map();

    try {
      const saved = JSON.parse(storage?.getItem(CACHE_STORAGE_KEY) || "null");
      if (saved?.version === 1 && saved.records && typeof saved.records === "object") {
        for (const [userId, record] of Object.entries(saved.records)) {
          if (isActivityRecord(record)) records.set(userId, record);
        }
      }
    } catch {
      // The in-memory map remains usable when storage is unavailable or corrupt.
    }

    function persist() {
      try {
        storage?.setItem(
          CACHE_STORAGE_KEY,
          JSON.stringify({ version: 1, records: Object.fromEntries(records) }),
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

    if (criterion === "added") {
      sorted.sort((left, right) => left.originalIndex - right.originalIndex);
    }

    if (criterion === "name") {
      sorted.sort((left, right) => {
        return (
          collator.compare(left.displayName, right.displayName) ||
          collator.compare(left.userId, right.userId)
        );
      });
    }

    if (criterion === "activity") {
      sorted.sort((left, right) => {
        const leftActivity = activityByUser.get(left.userId);
        const rightActivity = activityByUser.get(right.userId);
        const leftHasTime = leftActivity?.kind === "active";
        const rightHasTime = rightActivity?.kind === "active";

        if (leftHasTime && rightHasTime) {
          return rightActivity.activityAt - leftActivity.activityAt ||
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

  function parseSiteTimestamp(value) {
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
    const parsed = new Date(year, month - 1, day, hour, minute, second);
    if (
      parsed.getFullYear() !== year ||
      parsed.getMonth() !== month - 1 ||
      parsed.getDate() !== day ||
      parsed.getHours() !== hour ||
      parsed.getMinutes() !== minute ||
      parsed.getSeconds() !== second
    ) {
      return null;
    }
    return parsed.getTime();
  }

  function parseTimelineDocument(document) {
    const timeline = document.querySelector("#timeline");
    if (!timeline) return { kind: "invalid" };

    const firstItem = timeline?.querySelector(".tml_item");
    if (!firstItem) return { kind: "empty" };

    const timestamp = firstItem
      ?.querySelector(".post_actions .titleTip[title]")
      ?.getAttribute("title");
    const activityAt = parseSiteTimestamp(timestamp);

    return activityAt === null ? { kind: "invalid" } : { kind: "active", activityAt };
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
    const choices = [
      ["added", "加好友时间"],
      ["name", "名称"],
      ["activity", "上次活跃"],
    ];
    for (const [criterion, label] of choices) {
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

      const document = domParser.parseFromString(await response.text(), "text/html");
      const parsed = parseTimelineDocument(document);
      if (parsed.kind === "invalid") return { kind: "parse-error" };
      return { kind: "success", record: { ...parsed, fetchedAt: now() } };
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
    let currentCriterion = "added";
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
        if (currentCriterion === "activity") {
          applyFriendSort(list, friends, "activity", activityCache, collator);
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
      if (criterion === "activity") void startActivityRefresh();
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
