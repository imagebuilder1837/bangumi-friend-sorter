const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sorter = require("../src/index.user.js");

function friendPageWith(entries) {
  class Element {
    constructor(tagName) {
      this.attributes = new Map();
      this.beforeNodes = [];
      this.children = [];
      this.dataset = {};
      this.tagName = tagName;
      this.textContent = "";
    }

    addEventListener(type, handler) {
      this.listeners ??= new Map();
      this.listeners.set(type, handler);
    }

    click() {
      this.listeners?.get("click")?.();
    }

    append(...children) {
      for (const child of children) {
        if (child && this.children.includes(child)) {
          this.children.splice(this.children.indexOf(child), 1);
        }
        this.children.push(child);
      }
    }

    before(...nodes) {
      this.beforeNodes.push(...nodes);
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
  }

  const list = new Element("ul");
  list.children = entries.map(({ href, name }) => {
    const anchor = new Element("a");
    anchor.setAttribute("href", href);
    anchor.textContent = name;
    const item = new Element("li");
    item.textContent = name;
    item.querySelector = (selector) => {
      assert.equal(selector, 'a.avatar[href*="/user/"]');
      return anchor;
    };
    return item;
  });

  const head = new Element("head");
  const document = {
    createElement: (tagName) => new Element(tagName),
    head,
    querySelector(selector) {
      assert.equal(selector, "#memberUserList");
      return list;
    },
  };
  return { document, list };
}

test("纯空白展示名称不会阻止排序栏初始化", () => {
  const page = friendPageWith([
    { href: "/user/normal", name: "正常好友" },
    { href: "/user/ato", name: "\u3000" },
  ]);
  const previousDocument = global.document;
  const previousWindow = global.window;
  global.document = page.document;
  global.window = {
    localStorage: {
      getItem: () => null,
      removeItem() {},
      setItem() {},
    },
    location: { href: "https://bgm.tv/user/sai/friends" },
  };

  try {
    sorter.initialize();
  } finally {
    global.document = previousDocument;
    global.window = previousWindow;
  }

  assert.equal(page.list.beforeNodes.length, 1);
  assert.equal(page.list.beforeNodes[0].dataset.friendSorter, "");
});

function timelineDocumentFromFixture(filename) {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", filename), "utf8");
  const hasTimeline = /id=["']timeline["']/.test(html);
  const hasTimelineTabs = /id=["']timelineTabs["']/.test(html);
  const hasTimelineContent = /id=["']tmlContent["'][^>]*>\s*<div id=["']timeline["']/.test(
    html,
  );
  const item = html.match(
    /<li[^>]*class=["'][^"']*\btml_item\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/,
  );
  const hasItem = item !== null;
  const timestamp = item?.[1].match(
    /<div[^>]*class=["'][^"']*\bpost_actions\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*title=["']([^"']+)["'][^>]*class=["'][^"']*\btitleTip\b[^"']*["'][^>]*>([^<]*)</,
  );
  const timestampNode = timestamp
    ? {
        getAttribute: (name) => (name === "title" ? timestamp[1] : null),
        textContent: timestamp[2],
      }
    : null;
  const itemNode = hasItem
    ? {
        querySelector(selector) {
          assert.equal(selector, ".post_actions .titleTip[title]");
          return timestampNode;
        },
      }
    : null;
  const timelineNode = hasTimeline
    ? {
        querySelector(selector) {
          assert.equal(selector, ".tml_item");
          return itemNode;
        },
        textContent: hasItem ? "动态内容" : "",
      }
    : null;

  return {
    querySelector(selector) {
      if (selector === "#timeline") return timelineNode;
      if (selector === "#timelineTabs") return hasTimelineTabs ? {} : null;
      if (selector === "#tmlContent > #timeline") {
        return hasTimelineContent ? timelineNode : null;
      }
      assert.fail(`unexpected selector: ${selector}`);
    },
  };
}

test("加好友时间默认从旧到新，也支持从新到旧", () => {
  const friends = [
    { userIdentifier: "third", displayName: "三", originalIndex: 2 },
    { userIdentifier: "first", displayName: "一", originalIndex: 0 },
    { userIdentifier: "second", displayName: "二", originalIndex: 1 },
  ];

  assert.deepEqual(
    sorter.sortFriends(friends, "added", new Map()).map(({ userIdentifier }) => userIdentifier),
    ["first", "second", "third"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, "added", new Map(), undefined, "asc").map(
      ({ userIdentifier }) => userIdentifier,
    ),
    ["first", "second", "third"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, "added", new Map(), undefined, "desc").map(
      ({ userIdentifier }) => userIdentifier,
    ),
    ["third", "second", "first"],
  );
});

test("名称排序支持升序和降序，同名随方向比较用户标识", () => {
  const friends = [
    { userIdentifier: "z", displayName: "user10", originalIndex: 0 },
    { userIdentifier: "b", displayName: "User2", originalIndex: 1 },
    { userIdentifier: "a", displayName: "user2", originalIndex: 2 },
  ];
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

  assert.deepEqual(
    sorter.sortFriends(friends, "name", new Map(), collator).map(({ userIdentifier }) => userIdentifier),
    ["a", "b", "z"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, "name", new Map(), collator, "desc").map(
      ({ userIdentifier }) => userIdentifier,
    ),
    ["z", "b", "a"],
  );
});

test("上次活跃支持从新到旧和从旧到新，未知活跃时间始终在后", () => {
  const friends = [
    { userIdentifier: "unknown", displayName: "未知", originalIndex: 0 },
    { userIdentifier: "older", displayName: "较早", originalIndex: 1 },
    { userIdentifier: "empty", displayName: "无动态", originalIndex: 2 },
    { userIdentifier: "newer-a", displayName: "较新甲", originalIndex: 3 },
    { userIdentifier: "newer-b", displayName: "较新乙", originalIndex: 4 },
  ];
  const activities = new Map([
    ["older", { kind: "active", activityAtSeconds: 1, fetchedAt: 4_000 }],
    ["empty", { kind: "empty", fetchedAt: 4_000 }],
    ["newer-a", { kind: "active", activityAtSeconds: 2, fetchedAt: 4_000 }],
    ["newer-b", { kind: "active", activityAtSeconds: 2, fetchedAt: 4_000 }],
  ]);

  assert.deepEqual(
    sorter.sortFriends(friends, "activity", activities).map(({ userIdentifier }) => userIdentifier),
    ["newer-a", "newer-b", "older", "unknown", "empty"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, "activity", activities, undefined, "asc").map(
      ({ userIdentifier }) => userIdentifier,
    ),
    ["older", "newer-a", "newer-b", "unknown", "empty"],
  );
});

test("方向文案随排序维度切换", () => {
  assert.deepEqual(sorter.directionLabelsFor("name"), {
    asc: "升序",
    desc: "降序",
  });
  assert.deepEqual(sorter.directionLabelsFor("added"), {
    asc: "从旧到新",
    desc: "从新到旧",
  });
  assert.deepEqual(sorter.directionLabelsFor("activity"), {
    asc: "从旧到新",
    desc: "从新到旧",
  });
});

test("仅为缺失或超过二十四小时的活跃缓存安排请求", () => {
  const hour = 60 * 60 * 1_000;
  const now = 30 * hour;
  const friends = [
    { userIdentifier: "fresh-active" },
    { userIdentifier: "fresh-empty" },
    { userIdentifier: "boundary" },
    { userIdentifier: "stale" },
    { userIdentifier: "missing" },
  ];
  const activities = new Map([
    ["fresh-active", { kind: "active", activityAtSeconds: 10, fetchedAt: now - hour }],
    ["fresh-empty", { kind: "empty", fetchedAt: now - hour }],
    ["boundary", { kind: "active", activityAtSeconds: 20, fetchedAt: now - 24 * hour }],
    ["stale", { kind: "active", activityAtSeconds: 30, fetchedAt: now - 24 * hour - 1 }],
  ]);

  assert.deepEqual(
    sorter.findFriendsNeedingActivity(friends, activities, now).map(({ userIdentifier }) => userIdentifier),
    ["stale", "missing"],
  );
});

test("排序栏分左右两组按钮并更新方向文案", () => {
  const page = friendPageWith([]);
  const criteria = [];
  const directions = [];
  const controls = sorter.createSortBar(
    page.document,
    (criterion) => criteria.push(criterion),
    (direction) => directions.push(direction),
  );
  const filters = controls.bar.children[0];
  const sortOptions = filters.children[0];
  const directionOptions = filters.children[1];
  const sortButtons = sortOptions.children.filter(
    (child) => child?.tagName === "button",
  );
  const directionButtons = directionOptions.children.filter(
    (child) => child?.tagName === "button",
  );

  assert.equal(sortOptions.className, "bangumi-friend-sorter-sort-options");
  assert.equal(
    directionOptions.className,
    "bangumi-friend-sorter-direction-options",
  );
  assert.deepEqual(sortButtons.map(({ textContent }) => textContent), [
    "加好友时间",
    "名称",
    "上次活跃",
  ]);

  controls.setCurrent("name", "desc");
  assert.deepEqual(directionButtons.map(({ textContent }) => textContent), [
    "升序",
    "降序",
  ]);
  assert.equal(sortButtons[1].getAttribute("aria-current"), "true");
  assert.equal(directionButtons[1].getAttribute("aria-current"), "true");
  directionButtons[0].click();
  sortButtons[2].click();
  assert.deepEqual(directions, ["asc"]);
  assert.deepEqual(criteria, ["activity"]);

  controls.setCurrent("activity", "asc");
  assert.deepEqual(directionButtons.map(({ textContent }) => textContent), [
    "从旧到新",
    "从新到旧",
  ]);
  assert.equal(directionButtons[0].getAttribute("aria-current"), "true");
});

test("页面交互按排序维度记忆方向并仅重排当前缓存", () => {
  const page = friendPageWith([
    { href: "/user/z", name: "Zed" },
    { href: "/user/b", name: "Bob" },
    { href: "/user/a", name: "Ada" },
  ]);
  const previousDocument = global.document;
  const previousWindow = global.window;
  global.document = page.document;
  global.window = {
    localStorage: {
      getItem: () => null,
      removeItem() {},
      setItem() {},
    },
    location: { href: "https://bgm.tv/user/sai/friends" },
  };

  try {
    sorter.initialize();
  } finally {
    global.document = previousDocument;
    global.window = previousWindow;
  }

  const filters = page.list.beforeNodes[0].children[0];
  const sortOptions = filters.children[0];
  const directionOptions = filters.children[1];
  const sortButtons = sortOptions.children.filter(
    (child) => child?.tagName === "button",
  );
  const directionButtons = directionOptions.children.filter(
    (child) => child?.tagName === "button",
  );

  sortButtons[1].click();
  assert.deepEqual(page.list.children.map((item) => item.textContent), [
    "Ada",
    "Bob",
    "Zed",
  ]);
  directionButtons[1].click();
  assert.deepEqual(page.list.children.map((item) => item.textContent), [
    "Zed",
    "Bob",
    "Ada",
  ]);
  sortButtons[0].click();
  assert.deepEqual(directionButtons.map(({ textContent }) => textContent), [
    "从旧到新",
    "从新到旧",
  ]);
  assert.equal(directionButtons[0].getAttribute("aria-current"), "true");
  assert.deepEqual(page.list.children.map((item) => item.textContent), [
    "Zed",
    "Bob",
    "Ada",
  ]);
  directionButtons[1].click();
  assert.deepEqual(page.list.children.map((item) => item.textContent), [
    "Ada",
    "Bob",
    "Zed",
  ]);
  sortButtons[1].click();
  assert.equal(directionButtons[1].getAttribute("aria-current"), "true");
  assert.deepEqual(page.list.children.map((item) => item.textContent), [
    "Zed",
    "Bob",
    "Ada",
  ]);
});

test("活跃刷新完成后沿用刷新期间选择的方向", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "Ada" },
    { href: "/user/b", name: "Bob" },
  ]);
  const previousDocument = global.document;
  const previousWindow = global.window;
  const previousDomParser = global.DOMParser;
  const fetchedAt = Date.now();
  global.document = page.document;
  global.DOMParser = class {
    parseFromString() {
      return timelineDocumentFromFixture("timeline-active-seconds.html");
    }
  };
  global.window = {
    fetch: async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => "fixture",
    }),
    localStorage: {
      getItem(key) {
        if (key !== "bangumi-friend-sorter:activity-cache:v2") return null;
        return JSON.stringify({
          version: 2,
          records: {
            b: {
              kind: "active",
              activityAtSeconds: Date.UTC(2026, 7, 27) / 1_000,
              fetchedAt,
            },
          },
        });
      },
      removeItem() {},
      setItem() {},
    },
    location: { href: "https://bgm.tv/user/sai/friends" },
  };

  try {
    sorter.initialize();
    const filters = page.list.beforeNodes[0].children[0];
    const sortOptions = filters.children[0];
    const directionOptions = filters.children[1];
    const sortButtons = sortOptions.children.filter(
      (child) => child?.tagName === "button",
    );
    const directionButtons = directionOptions.children.filter(
      (child) => child?.tagName === "button",
    );

    sortButtons[2].click();
    directionButtons[0].click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(page.list.children.map((item) => item.textContent), [
      "Ada",
      "Bob",
    ]);
  } finally {
    global.document = previousDocument;
    global.window = previousWindow;
    global.DOMParser = previousDomParser;
  }
});

test("上次活跃点击按排序切换、待命和刷新状态分流", () => {
  assert.deepEqual(
    sorter.nextActivitySelectionAction("name", "activity", "idle"),
    { kind: "sort", refresh: "incremental" },
  );
  assert.deepEqual(
    sorter.nextActivitySelectionAction("activity", "activity", "idle"),
    { kind: "arm" },
  );
  assert.deepEqual(
    sorter.nextActivitySelectionAction("activity", "activity", "armed"),
    { kind: "refresh", mode: "full" },
  );
  assert.deepEqual(
    sorter.nextActivitySelectionAction("activity", "activity", "fetching"),
    { kind: "ignore" },
  );
  assert.deepEqual(
    sorter.nextActivitySelectionAction("activity", "activity", "completed"),
    { kind: "ignore" },
  );
  assert.deepEqual(
    sorter.nextActivitySelectionAction("name", "activity", "fetching"),
    { kind: "sort" },
  );
  assert.deepEqual(
    sorter.nextActivitySelectionAction("name", "activity", "completed"),
    { kind: "sort" },
  );
  assert.deepEqual(
    sorter.nextActivitySelectionAction("activity", "name", "armed"),
    { kind: "sort", clearPrompt: true },
  );
});

test("从时间胶囊首条动态读取活跃时刻", () => {
  const document = timelineDocumentFromFixture("timeline-active.html");

  assert.deepEqual(
    sorter.parseTimelineDocument(document, Date.UTC(2026, 7, 26, 6, 37, 34) / 1_000),
    {
      kind: "active",
      activityAtSeconds: Date.UTC(2026, 6, 4, 6, 37) / 1_000,
    },
  );
});

test("省略秒的大单位文案不推测更小单位", () => {
  const document = timelineDocumentFromFixture("timeline-active.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 6, 4, 6, 37) / 1_000,
  });
});

test("上次活跃时间保留页面提供的秒级精度", () => {
  const document = timelineDocumentFromFixture("timeline-active-seconds.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
  });
});

test("只有分钟的相对文案不推测秒数", () => {
  const document = timelineDocumentFromFixture("timeline-active-minutes-only.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 34) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42) / 1_000,
  });
});

test("刚刚按参考时间恢复秒数并保持绝对分钟", () => {
  const document = timelineDocumentFromFixture("timeline-active-just-now.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
  });
});

test("相对秒数与绝对分钟冲突时回退到分钟起点", () => {
  const document = timelineDocumentFromFixture("timeline-active-seconds.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 44, 36) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42) / 1_000,
  });
});

test("有效的空时间胶囊被识别为无公开动态", () => {
  const document = timelineDocumentFromFixture("timeline-empty.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), { kind: "empty" });
});

test("只有孤立时间线容器的残缺页面被识别为失败", () => {
  const document = timelineDocumentFromFixture("timeline-partial.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), { kind: "invalid" });
});

test("首条动态缺失精确时间时被识别为失败", () => {
  const document = timelineDocumentFromFixture("timeline-missing-time.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), { kind: "invalid" });
});

test("仅在本次待请求人数超过四百时要求确认", () => {
  assert.equal(sorter.needsLargeRequestConfirmation(400), false);
  assert.equal(sorter.needsLargeRequestConfirmation(401), true);
});

test("收到限流响应时立即停止活跃请求批次", () => {
  const state = sorter.nextBatchState(
    { consecutiveServerFailures: 0, stopped: false },
    { kind: "http-error", status: 429 },
  );

  assert.deepEqual(state, { consecutiveServerFailures: 0, stopped: true });
});

test("连续五个禁止或服务端响应才停止批次且成功响应会重置计数", () => {
  let state = { consecutiveServerFailures: 0, stopped: false };
  for (const status of [403, 500, 502, 503]) {
    state = sorter.nextBatchState(state, { kind: "http-error", status });
  }
  assert.deepEqual(state, { consecutiveServerFailures: 4, stopped: false });

  state = sorter.nextBatchState(state, { kind: "success" });
  assert.deepEqual(state, { consecutiveServerFailures: 0, stopped: false });

  for (const status of [500, 403, 500, 502, 503]) {
    state = sorter.nextBatchState(state, { kind: "http-error", status });
  }
  assert.deepEqual(state, { consecutiveServerFailures: 5, stopped: true });
});

test("持久存储不可用时活跃缓存仍在当前页面内工作", () => {
  const unavailableStorage = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    },
  };
  const cache = sorter.createActivityCache(unavailableStorage);
  const record = { kind: "active", activityAtSeconds: 1, fetchedAt: 2_000 };

  cache.set("sai", record);

  assert.equal(cache.get("sai"), record);
  assert.deepEqual([...cache.entries()], [["sai", record]]);
});

test("升级缓存版本时迁移有效的 v2 活跃记录到 v3", () => {
  const writes = [];
  const removedKeys = [];
  const record = { kind: "active", activityAtSeconds: 1_000, fetchedAt: 2_000 };
  const storage = {
    getItem(key) {
      if (key === "bangumi-friend-sorter:activity-cache:v2") {
        return JSON.stringify({ version: 2, records: { sai: record } });
      }
      return null;
    },
    removeItem(key) {
      removedKeys.push(key);
    },
    setItem(key, value) {
      writes.push([key, JSON.parse(value)]);
    },
  };

  const cache = sorter.createActivityCache(storage, { now: () => 3_000 });

  assert.deepEqual(cache.get("sai"), record);
  assert.deepEqual(writes, [[
    "bangumi-friend-sorter:activity-cache:v3",
    { version: 3, records: { sai: { activity: record } } },
  ]]);
  assert.deepEqual(removedKeys, [
    "bangumi-friend-sorter:activity-cache:v2",
    "bangumi-friend-sorter:activity-cache:v1",
  ]);
});

test("v2 活跃记录迁移遵守二十四小时有效期边界", () => {
  const hour = 60 * 60 * 1_000;
  const now = 100 * hour;
  const records = {
    fresh: { kind: "active", activityAtSeconds: 1, fetchedAt: now - hour },
    boundary: {
      kind: "active",
      activityAtSeconds: 2,
      fetchedAt: now - 24 * hour,
    },
    stale: {
      kind: "active",
      activityAtSeconds: 3,
      fetchedAt: now - 24 * hour - 1,
    },
  };
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v2") return null;
      return JSON.stringify({ version: 2, records });
    },
    removeItem() {},
    setItem() {},
  };

  const cache = sorter.createActivityCache(storage, { now: () => now });

  assert.deepEqual([...cache.entries()], [
    ["fresh", records.fresh],
    ["boundary", records.boundary],
  ]);
});

test("v3 缓存不完整时仍合并尚未迁移的 v2 活跃记录", () => {
  const activity = { kind: "active", activityAtSeconds: 1_000, fetchedAt: 2_000 };
  const writes = [];
  const storage = {
    getItem(key) {
      if (key === "bangumi-friend-sorter:activity-cache:v3") {
        return JSON.stringify({
          version: 3,
          records: { sai: { preference: { value: 87.5, fetchedAt: 3_000 } } },
        });
      }
      if (key === "bangumi-friend-sorter:activity-cache:v2") {
        return JSON.stringify({ version: 2, records: { sai: activity } });
      }
      return null;
    },
    removeItem() {},
    setItem(key, value) {
      writes.push([key, JSON.parse(value)]);
    },
  };

  const cache = sorter.createFriendCache(storage, {
    fieldValidators: {
      preference: (value) => Number.isFinite(value?.value),
    },
    now: () => 3_000,
  });

  assert.deepEqual(cache.get("sai"), {
    activity,
    preference: { value: 87.5, fetchedAt: 3_000 },
  });
  assert.deepEqual(writes, [[
    "bangumi-friend-sorter:activity-cache:v3",
    {
      version: 3,
      records: {
        sai: {
          activity,
          preference: { value: 87.5, fetchedAt: 3_000 },
        },
      },
    },
  ]]);
});

test("v3 缓存独立校验并保存好友的扩展字段", () => {
  const activity = {
    kind: "active",
    activityAtSeconds: 1_000,
    fetchedAt: 2_000,
  };
  const preference = { value: 87.5, fetchedAt: 3_000 };
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({
        version: 3,
        records: {
          sai: { activity, preference },
          broken: {
            activity,
            preference: { value: -1, fetchedAt: 3_000 },
          },
        },
      });
    },
  };

  const cache = sorter.createFriendCache(storage, {
    fieldValidators: {
      activity: (value) =>
        value?.kind === "active" &&
        Number.isInteger(value.activityAtSeconds) &&
        Number.isFinite(value.fetchedAt),
      preference: (value) =>
        Number.isFinite(value?.value) &&
        value.value >= 0 &&
        Number.isFinite(value.fetchedAt),
    },
  });

  assert.deepEqual(cache.get("sai"), { activity, preference });
  assert.deepEqual(cache.get("broken"), { activity });
  assert.deepEqual(cache.getField("sai", "preference"), preference);
  assert.deepEqual([...cache.entries()], [
    ["sai", { activity, preference }],
    ["broken", { activity }],
  ]);
});

test("升级缓存版本时删除旧版缓存而不迁移分钟级结果", () => {
  const removedKeys = [];
  const storage = {
    getItem(key) {
      if (key === "bangumi-friend-sorter:activity-cache:v1") {
        return JSON.stringify({
          version: 1,
          records: {
            sai: { kind: "active", activityAt: 1_000, fetchedAt: 2_000 },
          },
        });
      }
      return null;
    },
    removeItem(key) {
      removedKeys.push(key);
    },
    setItem() {},
  };

  const cache = sorter.createActivityCache(storage);

  assert.deepEqual([...cache.entries()], []);
  assert.deepEqual(removedKeys, ["bangumi-friend-sorter:activity-cache:v1"]);
});

test("损坏的缓存 JSON 降级为当前页面内存缓存", () => {
  const storage = {
    getItem() {
      return "{not-json";
    },
    setItem() {
      throw new Error("quota exceeded");
    },
  };
  const cache = sorter.createActivityCache(storage);
  const record = { kind: "active", activityAtSeconds: 1, fetchedAt: 2_000 };

  cache.set("sai", record);

  assert.equal(cache.get("sai"), record);
});

test("请求响应头的时间按整秒传给活跃时间解析并写入秒级缓存", async () => {
  const document = timelineDocumentFromFixture("timeline-active-seconds.html");
  const records = [];
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36);

  await sorter.refreshActivities([{ userIdentifier: "sai" }], {
    cache: {
      persist() {},
      set(userIdentifier, record) {
        records.push([userIdentifier, record]);
      },
    },
    domParser: { parseFromString: () => document },
    fetchImpl: async () => ({
      ok: true,
      headers: { get: (name) => (name === "date" ? new Date(responseTime).toUTCString() : null) },
      text: async () => "fixture",
    }),
    now: () => responseTime,
    onProgress() {},
  });

  assert.deepEqual(records, [[
    "sai",
    {
      kind: "active",
      activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
      fetchedAt: responseTime,
    },
  ]]);
});

test("时间胶囊返回四零四时计入失败且不覆盖缓存", async () => {
  let cacheWrites = 0;
  const progress = [];

  const result = await sorter.refreshActivities([{ userIdentifier: "missing" }], {
    cache: {
      persist() {},
      set() {
        cacheWrites += 1;
      },
    },
    domParser: {},
    fetchImpl: async () => ({ ok: false, status: 404 }),
    now: () => 1_000,
    onProgress: (completed, total) => progress.push([completed, total]),
  });

  assert.deepEqual(result, { failures: 1 });
  assert.equal(cacheWrites, 0);
  assert.deepEqual(progress, [[1, 1]]);
});

test("页面获取任务通过请求结果、成功回调和进度回调驱动", async () => {
  const requested = [];
  const saved = [];
  const progress = [];

  const result = await sorter.runPageFetchTask(["sai", "tom"], {
    fetchPage: async (userIdentifier) => {
      requested.push(userIdentifier);
      return {
        kind: "success",
        record: { userIdentifier, fetchedAt: 2_000 },
      };
    },
    onSuccess: (userIdentifier, record) => saved.push([userIdentifier, record]),
    onProgress: (completed, total) => progress.push([completed, total]),
  });

  assert.deepEqual(requested.sort(), ["sai", "tom"]);
  assert.deepEqual(saved.sort(([left], [right]) => left.localeCompare(right)), [
    ["sai", { userIdentifier: "sai", fetchedAt: 2_000 }],
    ["tom", { userIdentifier: "tom", fetchedAt: 2_000 }],
  ]);
  assert.deepEqual(result, { failures: 0, stopped: false });
  assert.deepEqual(
    progress.sort(([left], [right]) => left - right),
    [[1, 2], [2, 2]],
  );
});

test("页面初始化可以注入获取任务所需的运行时依赖", async () => {
  const page = friendPageWith([{ href: "/user/sai", name: "Sai" }]);
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36);
  let requests = 0;
  let nowCalls = 0;
  const progress = [];
  const writes = [];
  const storage = {
    getItem() {
      return null;
    },
    removeItem() {},
    setItem(key, value) {
      writes.push([key, JSON.parse(value)]);
    },
  };
  const pageWindow = {
    location: { href: "https://bgm.tv/user/sai/friends" },
  };

  sorter.initialize({
    document: page.document,
    window: pageWindow,
    storage,
    domParser: { parseFromString: () => timelineDocumentFromFixture("timeline-active-seconds.html") },
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        headers: { get: () => new Date(responseTime).toUTCString() },
        text: async () => "fixture",
      };
    },
    now: () => {
      nowCalls += 1;
      return responseTime;
    },
    onProgress: (completed, total) => progress.push([completed, total]),
  });

  const filters = page.list.beforeNodes[0].children[0];
  const sortButtons = filters.children[0].children.filter(
    (child) => child?.tagName === "button",
  );
  sortButtons[2].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests, 1);
  assert.equal(nowCalls, 2);
  assert.deepEqual(progress, [[1, 1]]);
  assert.deepEqual(writes, [[
    "bangumi-friend-sorter:activity-cache:v3",
    {
      version: 3,
      records: {
        sai: {
          activity: {
            kind: "active",
            activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
            fetchedAt: responseTime,
          },
        },
      },
    },
  ]]);
});

test("页面初始化使用注入时钟判断 v2 上次活跃记录迁移有效期", async () => {
  const hour = 60 * 60 * 1_000;
  const now = 100 * hour;
  const records = {
    fresh: { kind: "active", activityAtSeconds: 1, fetchedAt: now - hour },
    boundary: {
      kind: "active",
      activityAtSeconds: 2,
      fetchedAt: now - 24 * hour,
    },
    stale: {
      kind: "active",
      activityAtSeconds: 3,
      fetchedAt: now - 24 * hour - 1,
    },
  };
  const page = friendPageWith([
    { href: "/user/fresh", name: "新鲜" },
    { href: "/user/boundary", name: "边界" },
    { href: "/user/stale", name: "过期" },
  ]);
  let requests = 0;
  const storage = {
    getItem(key) {
      if (key === "bangumi-friend-sorter:activity-cache:v2") {
        return JSON.stringify({ version: 2, records });
      }
      return null;
    },
    removeItem() {},
    setItem() {},
  };

  sorter.initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage,
    domParser: {
      parseFromString: () => timelineDocumentFromFixture("timeline-active-seconds.html"),
    },
    fetchImpl: async () => {
      requests += 1;
      return { ok: false, status: 404 };
    },
    now: () => now,
  });

  const filters = page.list.beforeNodes[0].children[0];
  const sortButtons = filters.children[0].children.filter(
    (child) => child?.tagName === "button",
  );
  sortButtons[2].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests, 1);
});

class ProfileNode {
  constructor({ id = null, className = "", textContent = "", children = [] } = {}) {
    this.attributes = new Map();
    this.children = [];
    this.id = id;
    this.className = className;
    this.textContent = textContent;
    for (const child of children) this.append(child);
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      if (
        (selector.startsWith("#") && node.id === selector.slice(1)) ||
        (selector.startsWith(".") &&
          node.className.split(/\s+/).includes(selector.slice(1)))
      ) {
        matches.push(node);
      }
      for (const child of node.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return matches;
  }
}

function profileStatsDocument({
  counts = { all: 20, "2": 8, "1": 10, "3": 6, "4": 4, "6": 2 },
  includeBooks = false,
  malformedBooks = false,
} = {}) {
  const card = (count, label = "完成") =>
    new ProfileNode({
      children: [
        new ProfileNode({ className: "desc", textContent: label }),
        new ProfileNode({ className: "num", textContent: String(count) }),
      ],
    });
  const block = (id, count) =>
    new ProfileNode({ id: `userStats_${id}`, children: [card(count)] });
  const blocks = [
    block("all", counts.all),
    block("2", counts["2"]),
    block("3", counts["3"]),
    block("4", counts["4"]),
    block("6", counts["6"]),
  ];
  if (includeBooks) {
    blocks.splice(
      2,
      0,
      malformedBooks
        ? new ProfileNode({ id: "userStats_1", children: [card("")] })
        : block("1", counts["1"]),
    );
  }
  const container = new ProfileNode({ id: "userStatsContainers", children: blocks });
  return {
    querySelector: (selector) =>
      selector === "#userStatsContainers"
        ? container
        : container.querySelector(selector),
  };
}

function profileStatsDocumentFromFixture(filename) {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", filename), "utf8");
  const containerMatch = html.match(
    /<div id=["']userStatsContainers["']>([\s\S]*?)<\/div>\s*<\/body>/,
  );
  assert.ok(containerMatch);
  const container = new ProfileNode({ id: "userStatsContainers" });
  const blockPattern = /<section id=["'](userStats_(?:all|1|2|3|4|6))["']>([\s\S]*?)<\/section>/g;
  let blockMatch;
  while ((blockMatch = blockPattern.exec(containerMatch[1]))) {
    const block = new ProfileNode({ id: blockMatch[1] });
    const cardPattern = /<article[^>]*>([\s\S]*?)<\/article>/g;
    let cardMatch;
    while ((cardMatch = cardPattern.exec(blockMatch[2]))) {
      const description = cardMatch[1].match(
        /<span[^>]*class=["']desc["'][^>]*>([^<]*)<\/span>/,
      );
      const number = cardMatch[1].match(
        /<span[^>]*class=["']num["'][^>]*>([^<]*)<\/span>/,
      );
      block.append(
        new ProfileNode({
          children: [
            new ProfileNode({
              className: "desc",
              textContent: description?.[1] || "",
            }),
            new ProfileNode({
              className: "num",
              textContent: number?.[1] || "",
            }),
          ],
        }),
      );
    }
    container.append(block);
  }
  return {
    querySelector: (selector) =>
      selector === "#userStatsContainers"
        ? container
        : container.querySelector(selector),
  };
}

test("主页完成统计按完成描述定位六个统计范围", () => {
  const parsed = sorter.parseProfileDocument(
    profileStatsDocumentFromFixture("profile-stats.html"),
  );

  assert.deepEqual(parsed, {
    kind: "success",
    values: { all: 20, "2": 8, "1": 10, "3": 6, "4": 4, "6": 2 },
  });
});

test("缺失分类块可靠解析为零，缺失聚合块视为失败", () => {
  assert.deepEqual(sorter.parseProfileDocument(profileStatsDocument()), {
    kind: "success",
    values: { all: 20, "1": 0, "2": 8, "3": 6, "4": 4, "6": 2 },
  });

  const invalid = new ProfileNode({
    id: "userStatsContainers",
    children: [new ProfileNode({ id: "userStats_2" })],
  });
  assert.deepEqual(sorter.parseProfileDocument({
    querySelector: (selector) =>
      selector === "#userStatsContainers"
        ? invalid
        : invalid.querySelector(selector),
    }), { kind: "invalid" });

  const empty = new ProfileNode({ id: "userStatsContainers" });
  assert.deepEqual(sorter.parseProfileDocument({
    querySelector: (selector) =>
      selector === "#userStatsContainers"
        ? empty
        : empty.querySelector(selector),
  }), {
    kind: "success",
    values: { all: 0, "1": 0, "2": 0, "3": 0, "4": 0, "6": 0 },
  });

  const partial = sorter.parseProfileDocument(
    profileStatsDocument({ includeBooks: true, malformedBooks: true }),
  );
  assert.equal(partial.values["1"], undefined);
});

test("完成条目数按当前范围从高到低或从低到高稳定排序", () => {
  const friends = [
    { userIdentifier: "unknown", originalIndex: 0 },
    { userIdentifier: "same-b", originalIndex: 1 },
    { userIdentifier: "high", originalIndex: 2 },
    { userIdentifier: "zero", originalIndex: 3 },
    { userIdentifier: "same-a", originalIndex: 4 },
  ];
  const values = new Map([
    ["same-b", { value: 5, fetchedAt: 1 }],
    ["high", { value: 10, fetchedAt: 1 }],
    ["zero", { value: 0, fetchedAt: 1 }],
    ["same-a", { value: 5, fetchedAt: 1 }],
  ]);

  assert.deepEqual(
    sorter.sortFriends(friends, "completion", values, undefined, "desc", "all")
      .map(({ userIdentifier }) => userIdentifier),
    ["high", "same-b", "same-a", "zero", "unknown"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, "completion", values, undefined, "asc", "all")
      .map(({ userIdentifier }) => userIdentifier),
    ["zero", "same-b", "same-a", "high", "unknown"],
  );
});

test("完成统计缓存的七十二小时边界只请求缺失或过期范围", () => {
  const hour = 60 * 60 * 1_000;
  const now = 100 * hour;
  const friends = [
    { userIdentifier: "fresh" },
    { userIdentifier: "boundary" },
    { userIdentifier: "stale" },
    { userIdentifier: "missing" },
  ];
  const values = new Map([
    ["fresh", { value: 1, fetchedAt: now - hour }],
    ["boundary", { value: 2, fetchedAt: now - 72 * hour }],
    ["stale", { value: 3, fetchedAt: now - 72 * hour - 1 }],
  ]);

  assert.deepEqual(
    sorter.findFriendsNeedingCompletion(friends, values, "all", now).map(
      ({ userIdentifier }) => userIdentifier,
    ),
    ["stale", "missing"],
  );
});

test("同一主页响应分别刷新完成统计，失败范围保留旧缓存", async () => {
  const now = 10_000;
  const oldBook = { value: 99, fetchedAt: now - 1 };
  const writes = [];
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({
        version: 3,
        records: { sai: { completion_1: oldBook } },
      });
    },
    setItem(key, value) {
      writes.push([key, JSON.parse(value)]);
    },
  };
  const cache = sorter.createFriendCache(storage, {
    fieldValidators: sorter.completionCacheFieldValidators(),
  });

  await sorter.refreshCompletions([{ userIdentifier: "sai" }], {
    cache,
    domParser: { parseFromString: () => profileStatsDocument({ includeBooks: true, malformedBooks: true }) },
    fetchImpl: async () => ({ ok: true, text: async () => "profile" }),
    now: () => now,
    onProgress() {},
  });

  assert.deepEqual(cache.get("sai"), {
    completion_all: { value: 20, fetchedAt: now },
    completion_1: oldBook,
    completion_2: { value: 8, fetchedAt: now },
    completion_3: { value: 6, fetchedAt: now },
    completion_4: { value: 4, fetchedAt: now },
    completion_6: { value: 2, fetchedAt: now },
  });
  assert.equal(writes.length, 1);
});

test("完成条目数菜单按范围回调并只表达当前子项的无障碍状态", () => {
  const selected = [];
  const controls = sorter.createSortBar(
    friendPageWith([]).document,
    (criterion, scope) => selected.push([criterion, scope]),
  );
  const filters = controls.bar.children[0];
  const sortOptions = filters.children[0];
  const dropdown = sortOptions.children.find(
    (child) => child?.className === "bangumi-friend-sorter-dropdown",
  );
  const toggle = dropdown.children[0];
  const menu = dropdown.children[1];

  assert.equal(toggle.textContent, "完成条目数");
  assert.deepEqual(menu.children.map(({ textContent }) => textContent), [
    "全部",
    "动画",
    "书籍",
    "音乐",
    "游戏",
    "三次元",
  ]);
  controls.setCurrent("completion", "desc", "2");
  assert.equal(toggle.getAttribute("aria-current"), "true");
  assert.equal(menu.children[1].getAttribute("aria-current"), "true");
  assert.equal(menu.children[1].className, "l");
  menu.children[3].click();
  toggle.click();
  assert.deepEqual(selected, [
    ["completion", "3"],
    ["completion", "all"],
  ]);
});

test("初始化将排序栏挂在主内容列之前并使用完成条目数方向文案", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const columns = { children: [] };
  const wrapper = {
    children: [columns],
    querySelector: (selector) => (selector === ".columns" ? columns : null),
    insertBefore(node, before) {
      this.children.splice(this.children.indexOf(before), 0, node);
    },
  };
  page.list.closest = (selector) =>
    selector === ".mainWrapper" ? wrapper : null;

  sorter.initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    domParser: {
      parseFromString: (html) =>
        profileStatsDocument({
          counts: html.includes("/user/a")
            ? { all: 2, "2": 2, "1": 2, "3": 2, "4": 2, "6": 2 }
            : { all: 20, "2": 20, "1": 20, "3": 20, "4": 20, "6": 20 },
        }),
    },
    fetchImpl: async (url) => ({
      ok: true,
      text: async () => url,
    }),
  });

  const bar = wrapper.children[0];
  const filters = bar.children[0];
  const sortOptions = filters.children[0];
  const dropdown = sortOptions.children.find(
    (child) => child?.className === "bangumi-friend-sorter-dropdown",
  );
  dropdown.children[0].click();
  await new Promise((resolve) => setImmediate(resolve));
  const directionButtons = filters.children[1].children.filter(
    (child) => child?.tagName === "button",
  );

  assert.equal(bar.dataset.friendSorter, "");
  assert.equal(wrapper.children[1], columns);
  assert.deepEqual(directionButtons.map(({ textContent }) => textContent), [
    "从低到高",
    "从高到低",
  ]);
  assert.deepEqual(page.list.children.map((item) => item.textContent), ["B", "A"]);
});

test("缺少主内容布局时不修改好友页面", () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
  page.list.closest = () => null;

  sorter.initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
  });

  assert.equal(page.list.beforeNodes.length, 0);
  assert.equal(page.document.head.children.length, 0);
});
