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
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }

    click() {
      this.dispatchEvent({ type: "click" });
    }

    dispatchEvent(event) {
      event.target ??= this;
      event.preventDefault ??= () => {
        event.defaultPrevented = true;
      };
      for (const handler of this.listeners?.get(event.type) || []) {
        handler.call(this, event);
      }
      return !event.defaultPrevented;
    }

    focus() {
      const previous = this.ownerDocument?.activeElement;
      if (previous === this) return;
      this.ownerDocument.activeElement = this;
      previous?.dispatchEvent({ type: "focusout", relatedTarget: this });
      previous?.dispatchEvent({ type: "blur", relatedTarget: this });
      this.dispatchEvent({ type: "focus", relatedTarget: previous });
    }

    blur() {
      if (this.ownerDocument?.activeElement !== this) return;
      this.ownerDocument.activeElement = null;
      this.dispatchEvent({ type: "focusout", relatedTarget: null });
      this.dispatchEvent({ type: "blur", relatedTarget: null });
    }

    append(...children) {
      for (const child of children) {
        if (child && this.children.includes(child)) {
          this.children.splice(this.children.indexOf(child), 1);
        }
        if (child && typeof child === "object") {
          child.parentElement = this;
          child.ownerDocument ??= this.ownerDocument;
        }
        this.children.push(child);
      }
    }

    contains(target) {
      return (
        this === target ||
        this.children.some((child) => child?.contains?.(target))
      );
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

  const document = {
    activeElement: null,
    createElement: (tagName) => {
      const element = new Element(tagName);
      element.ownerDocument = document;
      return element;
    },
    head: new Element("head"),
    querySelector(selector) {
      assert.equal(selector, "#memberUserList");
      return list;
    },
  };
  document.head.ownerDocument = document;
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

test("网页默认顺序默认从旧到新，也支持从新到旧", () => {
  const friends = [
    { userIdentifier: "third", displayName: "三", originalIndex: 2 },
    { userIdentifier: "first", displayName: "一", originalIndex: 0 },
    { userIdentifier: "second", displayName: "二", originalIndex: 1 },
  ];

  assert.deepEqual(
    sorter.sortFriends(friends, { criterion: "added" }).map(
      ({ userIdentifier }) => userIdentifier,
    ),
    ["first", "second", "third"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, { criterion: "added", direction: "asc" }).map(
      ({ userIdentifier }) => userIdentifier,
    ),
    ["first", "second", "third"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, { criterion: "added", direction: "desc" }).map(
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
    sorter.sortFriends(friends, { criterion: "name", collator }).map(
      ({ userIdentifier }) => userIdentifier,
    ),
    ["a", "b", "z"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, { criterion: "name", collator, direction: "desc" }).map(
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
    sorter.sortFriends(friends, { criterion: "activity", sortData: activities }).map(
      ({ userIdentifier }) => userIdentifier,
    ),
    ["newer-a", "newer-b", "older", "unknown", "empty"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "activity",
      sortData: activities,
      direction: "asc",
    }).map(
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
  assert.deepEqual(sorter.directionLabelsFor("relation"), {
    asc: "从低到高",
    desc: "从高到低",
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
    { kind: "sort", refresh: "incremental" },
  );
  assert.deepEqual(
    sorter.nextActivitySelectionAction("name", "activity", "completed"),
    { kind: "sort", refresh: "incremental" },
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

test("页面任务调度器在全局四槽位内优先前台任务且不取消在途请求", async () => {
  const scheduler = sorter.createTaskScheduler({ concurrency: 4 });
  const started = [];
  const pending = new Map();
  const fetchPage = (type) => (item) =>
    new Promise((resolve) => {
      started.push(`${type}:${item}`);
      pending.set(`${type}:${item}`, resolve);
    });
  const taskOptions = (type) => ({
    fetch: fetchPage(type),
    isSuccess: () => true,
  });

  scheduler.setForeground("activity");
  scheduler.enqueue("activity", ["a1", "a2", "a3", "a4", "a5"], taskOptions("activity"));
  scheduler.setForeground("profile");
  scheduler.enqueue("profile", ["p1", "p2"], taskOptions("profile"));

  assert.deepEqual(started, [
    "activity:a1",
    "activity:a2",
    "activity:a3",
    "activity:a4",
  ]);

  pending.get("activity:a1")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [
    "activity:a1",
    "activity:a2",
    "activity:a3",
    "activity:a4",
    "profile:p1",
  ]);

  pending.get("profile:p1")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [
    "activity:a1",
    "activity:a2",
    "activity:a3",
    "activity:a4",
    "profile:p1",
    "profile:p2",
  ]);

  for (const key of ["activity:a2", "activity:a3", "activity:a4", "profile:p2"]) {
    pending.get(key)({ kind: "success" });
  }
  await new Promise((resolve) => setImmediate(resolve));
  pending.get("activity:a5")?.({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(scheduler.getInFlightCount(), 0);
  assert.equal(scheduler.getTask("activity"), null);
  assert.equal(scheduler.getTask("profile"), null);
});

test("前台队列耗尽但仍有在途请求时不会恢复后台任务", async () => {
  const scheduler = sorter.createTaskScheduler({ concurrency: 2 });
  const pending = new Map();
  const started = [];
  const options = (type) => ({
    fetch: (item) =>
      new Promise((resolve) => {
        started.push(`${type}:${item}`);
        pending.set(`${type}:${item}`, resolve);
      }),
    isSuccess: () => true,
  });

  scheduler.setForeground("activity");
  scheduler.enqueue("activity", ["a1", "a2", "a3"], options("activity"));
  scheduler.setForeground("profile");
  scheduler.enqueue("profile", ["p1", "p2"], options("profile"));

  pending.get("activity:a1")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["activity:a1", "activity:a2", "profile:p1"]);

  pending.get("profile:p1")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    started,
    ["activity:a1", "activity:a2", "profile:p1", "profile:p2"],
  );

  pending.get("activity:a2")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    started,
    ["activity:a1", "activity:a2", "profile:p1", "profile:p2"],
  );

  pending.get("profile:p2")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    started,
    [
      "activity:a1",
      "activity:a2",
      "profile:p1",
      "profile:p2",
      "activity:a3",
    ],
  );

  pending.get("activity:a3")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
});

test("页面任务调度器收到 429 时停止所有任务并统计未尝试好友", async () => {
  const scheduler = sorter.createTaskScheduler({ concurrency: 4 });
  const pending = new Map();
  const finished = [];
  const fetchPage = (type) => (item) =>
    new Promise((resolve) => pending.set(`${type}:${item}`, resolve));
  const options = (type) => ({
    fetch: fetchPage(type),
    isSuccess: (record, outcome) => outcome.kind === "success" && record,
    onFinished: (result) => finished.push([type, result]),
  });

  scheduler.setForeground("activity");
  scheduler.enqueue("activity", ["a1", "a2", "a3", "a4", "a5"], options("activity"));
  scheduler.enqueue("profile", ["p1", "p2"], options("profile"));
  pending.get("activity:a1")({ kind: "http-error", status: 429 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(scheduler.getInFlightCount(), 3);
  assert.deepEqual(
    finished.map(([type, result]) => [type, result.failures, result.stopped]),
    [["profile", 2, true]],
  );

  for (const key of ["activity:a2", "activity:a3", "activity:a4"]) {
    pending.get(key)({ kind: "success", record: key });
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    finished
      .map(([type, result]) => [type, result.failures, result.stopped])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ["activity", 2, true],
      ["profile", 2, true],
    ],
  );
  assert.equal(scheduler.getInFlightCount(), 0);
  assert.equal(scheduler.isGloballyStopped(), true);
});

test("页面任务连续五次服务端失败后停止自身并恢复另一页面任务", async () => {
  const scheduler = sorter.createTaskScheduler({ concurrency: 1 });
  const pending = new Map();
  const started = [];
  const finished = [];
  const options = (type) => ({
    fetch: (item) =>
      new Promise((resolve) => {
        started.push(`${type}:${item}`);
        pending.set(`${type}:${item}`, resolve);
      }),
    isSuccess: (record, outcome) => outcome.kind === "success" && record,
    onFinished: (result) => finished.push([type, result]),
  });

  scheduler.setForeground("activity");
  scheduler.enqueue("activity", ["a1", "a2", "a3", "a4", "a5", "a6"], options("activity"));
  scheduler.enqueue("profile", ["p1"], options("profile"));
  for (const item of ["a1", "a2", "a3", "a4", "a5"]) {
    pending.get(`activity:${item}`)({ kind: "http-error", status: 500 });
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(started, [
    "activity:a1",
    "activity:a2",
    "activity:a3",
    "activity:a4",
    "activity:a5",
    "profile:p1",
  ]);
  assert.equal(finished[0][0], "activity");
  assert.equal(finished[0][1].failures, 6);
  assert.equal(finished[0][1].stopped, true);

  pending.get("profile:p1")({ kind: "success", record: "p1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished[1][0], "profile");
  assert.equal(finished[1][1].failures, 0);
});

test("没有待请求好友的远程目标不会暂停后台任务", async () => {
  const page = friendPageWith(
    ["a", "b", "c", "d", "e"].map((userIdentifier) => ({
      href: `/user/${userIdentifier}`,
      name: userIdentifier.toUpperCase(),
    })),
  );
  const now = 100_000;
  const pending = new Map();
  const started = [];
  const responseFor = (url) => ({
    ok: true,
    headers: { get: () => null },
    text: async () => (url.endsWith("/timeline") ? "timeline" : "profile"),
  });
  const release = (url) => {
    const resolve = pending.get(url);
    assert.ok(resolve, `expected a pending request for ${url}`);
    pending.delete(url);
    resolve(responseFor(url));
  };
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(predicate(), true);
  };
  const records = Object.fromEntries(
    ["a", "b", "c", "d", "e"].map((userIdentifier) => [
      userIdentifier,
      { completion_all: { value: 1, fetchedAt: now } },
    ]),
  );

  sorter.initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage: {
      getItem: (key) =>
        key === "bangumi-friend-sorter:activity-cache:v3"
          ? JSON.stringify({ version: 3, records })
          : null,
      setItem() {},
      removeItem() {},
    },
    now: () => now,
    domParser: {
      parseFromString: (html) =>
        html === "timeline"
          ? timelineDocumentFromFixture("timeline-active-seconds.html")
          : profileStatsDocument(),
    },
    fetchImpl: (url) => {
      started.push(url);
      return new Promise((resolve) => pending.set(url, resolve));
    },
  });

  const filters = page.list.beforeNodes[0].children[0];
  const sortOptions = filters.children[0];
  const activityButton = sortOptions.children.find(
    (child) => child?.tagName === "button" && child.textContent === "上次活跃",
  );
  const completionDropdown = sortOptions.children.find(
    (child) => child?.children?.[0]?.textContent === "完成条目数",
  );

  activityButton.click();
  assert.equal(started.filter((url) => url.endsWith("/timeline")).length, 4);
  completionDropdown.children[0].click();
  assert.equal(started.filter((url) => !url.endsWith("/timeline")).length, 0);

  release("/user/a/timeline");
  await waitFor(
    () => started.filter((url) => url.endsWith("/timeline")).length === 5,
  );

  for (const userIdentifier of ["b", "c", "d", "e"]) {
    release(`/user/${userIdentifier}/timeline`);
  }
  await waitFor(() => pending.size === 0);
});

test("初始化在时间胶囊和用户主页任务之间切换并恢复暂停队列", async () => {
  const page = friendPageWith(
    ["a", "b", "c", "d", "e"].map((userIdentifier) => ({
      href: `/user/${userIdentifier}`,
      name: userIdentifier.toUpperCase(),
    })),
  );
  const started = [];
  const pending = new Map();
  const responseFor = (url) => ({
    ok: true,
    headers: { get: () => null },
    text: async () => (url.endsWith("/timeline") ? "timeline" : "profile"),
  });
  const release = (url) => {
    const resolve = pending.get(url);
    assert.ok(resolve, `expected a pending request for ${url}`);
    pending.delete(url);
    resolve(responseFor(url));
  };
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(predicate(), true);
  };

  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    domParser: {
      parseFromString: (html) =>
        html === "timeline"
          ? timelineDocumentFromFixture("timeline-active-seconds.html")
          : profileStatsDocument(),
    },
    fetchImpl: (url) => {
      started.push(url);
      return new Promise((resolve) => pending.set(url, resolve));
    },
  });

  const filters = page.list.beforeNodes[0].children[0];
  const sortOptions = filters.children[0];
  const sortButtons = sortOptions.children.filter(
    (child) => child?.tagName === "button",
  );
  const completionDropdown = sortOptions.children.find(
    (child) => child?.children?.[0]?.textContent === "完成条目数",
  );

  sortButtons[2].click();
  assert.equal(started.filter((url) => url.endsWith("/timeline")).length, 4);
  completionDropdown.children[0].click();
  assert.equal(started.filter((url) => !url.endsWith("/timeline")).length, 0);

  release("/user/a/timeline");
  await waitFor(
    () => started.filter((url) => !url.endsWith("/timeline")).length === 1,
  );
  release("/user/a");
  await waitFor(
    () => started.filter((url) => !url.endsWith("/timeline")).length === 2,
  );
  assert.equal(started.includes("/user/e/timeline"), false);

  for (const userIdentifier of ["b", "c", "d"]) {
    release(`/user/${userIdentifier}`);
    await waitFor(
      () =>
        started.filter((url) => !url.endsWith("/timeline")).length ===
        ["b", "c", "d"].indexOf(userIdentifier) + 3,
    );
  }
  release("/user/e");
  await waitFor(() => started.includes("/user/e/timeline"));

  for (const userIdentifier of ["b", "c", "d", "e"]) {
    release(`/user/${userIdentifier}/timeline`);
  }
  await waitFor(() => pending.size === 0);
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
  assert.equal(nowCalls, 3);
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

function relationProfileDocument({ syncRate, commonLikes } = {}) {
  const relation = new ProfileNode({
    className: "userSynchronize",
    textContent:
      commonLikes === undefined ? "" : `${commonLikes}个共同喜好`,
    children:
      syncRate === undefined
        ? []
        : [new ProfileNode({ className: "percent_text", textContent: syncRate })],
  });
  return {
    querySelector(selector) {
      if (selector === ".userSynchronize") return relation;
      return relation.querySelector(selector);
    },
  };
}

function profileDocumentWithRelation({ syncRate, commonLikes, counts } = {}) {
  const statsDocument = profileStatsDocument({ counts });
  const relationDocument = relationProfileDocument({ syncRate, commonLikes });
  return {
    querySelector(selector) {
      if (selector === ".userSynchronize") {
        return relationDocument.querySelector(selector);
      }
      return statsDocument.querySelector(selector);
    },
  };
}

test("主页解析同步率和共同喜好数，缺失字段不转换为零", () => {
  assert.deepEqual(
    sorter.parseProfileDocument(
      relationProfileDocument({ syncRate: "-3.5%", commonLikes: 0 }),
    ),
    { kind: "success", relation: { syncRate: -3.5, commonLikes: 0 } },
  );
  assert.deepEqual(
    sorter.parseProfileDocument(relationProfileDocument({ syncRate: "2.25%" })),
    { kind: "success", relation: { syncRate: 2.25 } },
  );
  assert.deepEqual(
    sorter.parseProfileDocument(
      relationProfileDocument({ syncRate: "2.25%", commonLikes: "-3" }),
    ),
    { kind: "success", relation: { syncRate: 2.25 } },
  );
  assert.deepEqual(
    sorter.parseProfileDocument(
      relationProfileDocument({ syncRate: "2.25%", commonLikes: "1.5" }),
    ),
    { kind: "success", relation: { syncRate: 2.25 } },
  );
  const beyondSafeInteger = Number.MAX_SAFE_INTEGER + 1;
  assert.deepEqual(
    sorter.parseProfileDocument(
      relationProfileDocument({ commonLikes: beyondSafeInteger }),
    ),
    { kind: "success", relation: { commonLikes: beyondSafeInteger } },
  );
});

test("主页完成统计按完成描述定位六个统计范围", () => {
  const parsed = sorter.parseProfileDocument(
    profileStatsDocumentFromFixture("profile-stats.html"),
  );

  assert.deepEqual(parsed, {
    kind: "success",
    values: { all: 20, "2": 8, "1": 10, "3": 6, "4": 4, "6": 2 },
  });
});

test("统计块存在多个完成描述时视为结构矛盾", () => {
  assert.deepEqual(
    sorter.parseProfileDocument(
      profileStatsDocumentFromFixture("profile-stats-conflict.html"),
    ),
    { kind: "invalid" },
  );
});

test("唯一完成卡存在多个数量节点时视为结构矛盾", () => {
  const aggregate = new ProfileNode({
    id: "userStats_all",
    children: [
      new ProfileNode({
        children: [
          new ProfileNode({ className: "desc", textContent: "完成" }),
          new ProfileNode({ className: "num", textContent: "20" }),
          new ProfileNode({ className: "num", textContent: "21" }),
        ],
      }),
    ],
  });
  const container = new ProfileNode({
    id: "userStatsContainers",
    children: [aggregate],
  });

  assert.deepEqual(
    sorter.parseProfileDocument({
      querySelector: (selector) =>
        selector === "#userStatsContainers"
          ? container
          : container.querySelector(selector),
    }),
    { kind: "invalid" },
  );
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

test("统计范围只接受容器内的唯一统计块", () => {
  const statBlock = (scope, count) =>
    new ProfileNode({
      id: `userStats_${scope}`,
      children: [
        new ProfileNode({
          children: [
            new ProfileNode({ className: "desc", textContent: "完成" }),
            new ProfileNode({ className: "num", textContent: String(count) }),
          ],
        }),
      ],
    });
  const outsideAggregate = statBlock("all", 99);
  const incompleteContainer = new ProfileNode({
    id: "userStatsContainers",
    children: [statBlock("2", 8)],
  });
  const documentWithOutsideAggregate = {
    querySelector(selector) {
      if (selector === "#userStatsContainers") return incompleteContainer;
      if (selector === "#userStats_all") return outsideAggregate;
      return incompleteContainer.querySelector(selector);
    },
  };

  assert.deepEqual(
    sorter.parseProfileDocument(documentWithOutsideAggregate),
    { kind: "invalid" },
  );

  const duplicateContainer = new ProfileNode({
    id: "userStatsContainers",
    children: [statBlock("all", 20), statBlock("all", 21)],
  });
  assert.deepEqual(
    sorter.parseProfileDocument({
      querySelector: (selector) =>
        selector === "#userStatsContainers"
          ? duplicateContainer
          : duplicateContainer.querySelector(selector),
    }),
    { kind: "invalid" },
  );
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
    sorter.sortFriends(friends, {
      criterion: "completion",
      sortData: values,
      direction: "desc",
      completionScope: "all",
    })
      .map(({ userIdentifier }) => userIdentifier),
    ["high", "same-b", "same-a", "zero", "unknown"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "completion",
      sortData: values,
      direction: "asc",
      completionScope: "all",
    })
      .map(({ userIdentifier }) => userIdentifier),
    ["zero", "same-b", "same-a", "high", "unknown"],
  );
});

test("喜好契合按访问者隔离并稳定排序可靠零和未知值", () => {
  const now = 10_000;
  const friends = [
    { userIdentifier: "unknown", originalIndex: 0 },
    { userIdentifier: "same-b", originalIndex: 1 },
    { userIdentifier: "high", originalIndex: 2 },
    { userIdentifier: "zero", originalIndex: 3 },
    { userIdentifier: "same-a", originalIndex: 4 },
  ];
  const cache = sorter.createFriendCache(null);
  for (const [userIdentifier, value] of [
    ["same-b", 5],
    ["high", 10],
    ["zero", 0],
    ["same-a", 5],
  ]) {
    cache.setRelationField("visitor-a", userIdentifier, "commonLikes", {
      value,
      fetchedAt: now,
    });
  }
  cache.setRelationField("visitor-b", "unknown", "commonLikes", {
    value: 99,
    fetchedAt: now,
  });

  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "relation",
      relationMetric: "commonLikes",
      relationVisitorIdentifier: "visitor-a",
      sortData: cache,
      direction: "desc",
    }).map(({ userIdentifier }) => userIdentifier),
    ["high", "same-b", "same-a", "zero", "unknown"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "relation",
      relationMetric: "commonLikes",
      relationVisitorIdentifier: "visitor-a",
      sortData: cache,
      direction: "asc",
    }).map(({ userIdentifier }) => userIdentifier),
    ["zero", "same-b", "same-a", "high", "unknown"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "relation",
      relationMetric: "commonLikes",
      relationVisitorIdentifier: "visitor-b",
      sortData: cache,
    }).map(({ userIdentifier }) => userIdentifier),
    ["unknown", "same-b", "high", "zero", "same-a"],
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

test("喜好契合缓存按访问者和指标判断七十二小时有效期", () => {
  const hour = 60 * 60 * 1_000;
  const now = 100 * hour;
  const friends = [
    { userIdentifier: "fresh" },
    { userIdentifier: "boundary" },
    { userIdentifier: "stale" },
    { userIdentifier: "missing" },
  ];
  const cache = sorter.createFriendCache(null);
  cache.setRelationField("visitor", "fresh", "syncRate", {
    value: 1.5,
    fetchedAt: now - hour,
  });
  cache.setRelationField("visitor", "boundary", "syncRate", {
    value: 2,
    fetchedAt: now - 72 * hour,
  });
  cache.setRelationField("visitor", "stale", "syncRate", {
    value: 3,
    fetchedAt: now - 72 * hour - 1,
  });

  assert.deepEqual(
    sorter.findFriendsNeedingRelation(
      friends,
      cache,
      "visitor",
      "syncRate",
      now,
    ).map(({ userIdentifier }) => userIdentifier),
    ["stale", "missing"],
  );
  assert.deepEqual(
    sorter.findFriendsNeedingRelation(
      friends,
      cache,
      "other-visitor",
      "syncRate",
      now,
    ).map(({ userIdentifier }) => userIdentifier),
    ["fresh", "boundary", "stale", "missing"],
  );
});

test("当前访问者标识按 UID、配置的访问者标识、页头头像依次回退且不读取被查看者", () => {
  const avatar = { getAttribute: () => "/user/header-user" };
  const headerDocument = {
    querySelector(selector) {
      return selector === "#headerNeue2 .idBadgerNeue a.avatar[href*='/user/']"
        ? avatar
        : null;
    },
  };

  assert.equal(
    sorter.currentVisitorIdentifier(headerDocument, {
      CHOBITS_UID: "42",
      CHOBITS_USERNAME: "name",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    }),
    "42",
  );
  assert.equal(
    sorter.currentVisitorIdentifier(headerDocument, {
      CHOBITS_UID: "9007199254740993",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    }),
    "9007199254740993",
  );
  assert.equal(
    sorter.currentVisitorIdentifier(headerDocument, {
      CHOBITS_UID: "0",
      CHOBITS_USERNAME: "  name  ",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    }),
    "name",
  );
  assert.equal(
    sorter.currentVisitorIdentifier(headerDocument, {
      location: { href: "https://bgm.tv/user/viewed/friends" },
    }),
    "header-user",
  );
  assert.equal(
    sorter.currentVisitorIdentifier(
      { querySelector: () => null },
      { location: { href: "https://bgm.tv/user/viewed/friends" } },
    ),
    null,
  );
});

test("初始化按当前访问者隔离喜好契合缓存", () => {
  const now = 100_000;
  const visitorA = "visitor-a";
  const visitorB = "visitor-b";
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({
        version: 3,
        records: {
          friend: {
            [sorter.relationFieldFor(visitorA, "syncRate")]: {
              value: 90,
              fetchedAt: now,
            },
          },
        },
      });
    },
    setItem() {},
    removeItem() {},
  };

  const pageA = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  let requestsA = 0;
  sorter.initialize({
    document: pageA.document,
    window: {
      CHOBITS_USERNAME: visitorA,
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage,
    now: () => now,
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: async () => {
      requestsA += 1;
      return { ok: true, text: async () => "profile" };
    },
  });
  const sortOptionsA = pageA.list.beforeNodes[0].children[0].children[0];
  const relationDropdownA = sortOptionsA.children.find(
    (child) => child.children?.[0]?.textContent === "喜好契合",
  );
  relationDropdownA.children[0].click();
  assert.equal(requestsA, 0);

  const pageB = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  let requestsB = 0;
  sorter.initialize({
    document: pageB.document,
    window: {
      CHOBITS_USERNAME: visitorB,
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage,
    now: () => now,
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: async () => {
      requestsB += 1;
      return { ok: true, text: async () => "profile" };
    },
  });
  const sortOptionsB = pageB.list.beforeNodes[0].children[0].children[0];
  const relationDropdownB = sortOptionsB.children.find(
    (child) => child.children?.[0]?.textContent === "喜好契合",
  );
  relationDropdownB.children[0].click();
  assert.equal(requestsB, 1);
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
    (child) => child?.children?.[0]?.textContent === "完成条目数",
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

test("喜好契合菜单按指标回调并直接点击默认选择同步率", () => {
  const selected = [];
  const controls = sorter.createSortBar(
    friendPageWith([]).document,
    (criterion, metric) => selected.push([criterion, metric]),
  );
  const sortOptions = controls.bar.children[0].children[0];
  const dropdowns = sortOptions.children.filter(
    (child) => child?.className === "bangumi-friend-sorter-dropdown",
  );
  assert.deepEqual(
    dropdowns.map((dropdown) => dropdown.children[0]?.textContent),
    ["喜好契合", "完成条目数"],
  );
  const relationDropdown = dropdowns.find(
    (dropdown) => dropdown.children[0]?.textContent === "喜好契合",
  );
  const toggle = relationDropdown.children[0];
  const menu = relationDropdown.children[1];

  assert.equal(toggle.textContent, "喜好契合");
  assert.deepEqual(menu.children.map(({ textContent }) => textContent), [
    "同步率",
    "共同喜好数",
  ]);
  controls.setCurrent("relation", "desc", "commonLikes");
  assert.equal(toggle.getAttribute("aria-current"), "true");
  assert.equal(menu.children[1].getAttribute("aria-current"), "true");
  toggle.click();
  menu.children[1].click();
  assert.deepEqual(selected, [
    ["relation", "syncRate"],
    ["relation", "commonLikes"],
  ]);
});

test("喜好契合菜单的焦点状态只控制自身菜单", () => {
  const page = friendPageWith([]);
  const controls = sorter.createSortBar(page.document, () => {});
  const sortOptions = controls.bar.children[0].children[0];
  const relationDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "喜好契合",
  );
  const relationButton = relationDropdown.children[0];
  const relationMenu = relationDropdown.children[1];

  relationButton.focus();
  assert.equal(relationButton.getAttribute("aria-expanded"), "true");
  relationMenu.children[1].focus();
  assert.equal(relationButton.getAttribute("aria-expanded"), "true");
  page.document.createElement("div").focus();
  assert.equal(relationButton.getAttribute("aria-expanded"), "false");
});

test("未登录时选择喜好契合不请求且登录提示不会因重复选择续时", () => {
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  let requests = 0;
  sorter.initialize({
    document: page.document,
    window: {
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetchImpl: async () => {
      requests += 1;
      return { ok: false, status: 500 };
    },
  });

  const sortOptions = page.list.beforeNodes[0].children[0].children[0];
  const relationDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "喜好契合",
  );
  const relationButton = relationDropdown.children[0];
  const relationMenu = relationDropdown.children[1];
  const status = page.list.beforeNodes[0].children[0].children[0].children.at(-1);

  relationButton.click();
  assert.equal(requests, 0);
  assert.equal(status.textContent, "请登录后使用喜好契合排序");
  const completionDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "完成条目数",
  );
  completionDropdown.children[0].click();
  assert.equal(status.textContent, "请登录后使用喜好契合排序");
  relationMenu.children[1].click();
  assert.equal(requests, 0);
  assert.equal(status.textContent, "请登录后使用喜好契合排序");
});

test("选择喜好契合会清除已激活的上次活跃全量刷新提示", () => {
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
  });

  const sortOptions = page.list.beforeNodes[0].children[0].children[0];
  const activityButton = sortOptions.children.find(
    (child) => child?.tagName === "button" && child.textContent === "上次活跃",
  );
  const relationDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "喜好契合",
  );
  const status = sortOptions.children.at(-1);

  activityButton.click();
  activityButton.click();
  assert.equal(status.textContent, "5 秒内再次点击“上次活跃”以全量刷新");
  relationDropdown.children[0].click();
  assert.equal(status.textContent, "");
});

test("登录提示不会被完成任务完成状态覆盖", async () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map();
  const setTimer = (callback, delay) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const advance = async (milliseconds) => {
    now += milliseconds;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.due <= now)
        .sort(([, left], [, right]) => left.due - right.due)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      timer.callback();
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  let releaseProfile;
  const pendingProfile = new Promise((resolve) => {
    releaseProfile = resolve;
  });
  sorter.initialize({
    document: page.document,
    window: {
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    now: () => now,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    domParser: { parseFromString: () => profileStatsDocument() },
    fetchImpl: () => pendingProfile,
  });

  const sortOptions = page.list.beforeNodes[0].children[0].children[0];
  const completionDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "完成条目数",
  );
  const relationDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "喜好契合",
  );
  const status = sortOptions.children.at(-1);

  completionDropdown.children[0].click();
  relationDropdown.children[0].click();
  assert.equal(status.textContent, "请登录后使用喜好契合排序");

  now = 1_000;
  releaseProfile({ ok: true, text: async () => "profile" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.textContent, "请登录后使用喜好契合排序");

  await advance(4_000);
  assert.equal(status.textContent, "“完成条目数”获取完成");
  await advance(1_000);
  assert.equal(status.textContent, "");
});

test("不同页面类型的完成提示按实际完成时间排队并依次出队", async () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map();
  const setTimer = (callback, delay) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const advance = async (milliseconds) => {
    now += milliseconds;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.due <= now)
        .sort(([, left], [, right]) => left.due - right.due)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      timer.callback();
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  let releaseActivity;
  let releaseProfile;
  const activityResponse = new Promise((resolve) => {
    releaseActivity = resolve;
  });
  const profileResponse = new Promise((resolve) => {
    releaseProfile = resolve;
  });

  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    now: () => now,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    domParser: {
      parseFromString: (html) =>
        html === "timeline"
          ? timelineDocumentFromFixture("timeline-active-seconds.html")
          : profileStatsDocument(),
    },
    fetchImpl: (url) =>
      url.endsWith("/timeline") ? activityResponse : profileResponse,
  });

  const sortOptions = page.list.beforeNodes[0].children[0].children[0];
  const activityButton = sortOptions.children.find(
    (child) => child?.tagName === "button" && child.textContent === "上次活跃",
  );
  const completionDropdown = sortOptions.children.find(
    (child) => child?.children?.[0]?.textContent === "完成条目数",
  );
  const status = sortOptions.children.at(-1);

  activityButton.click();
  completionDropdown.children[0].click();
  releaseActivity({
    ok: true,
    headers: { get: () => null },
    text: async () => "timeline",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.textContent, "“上次活跃”获取完成");

  now = 1_000;
  releaseProfile({
    ok: true,
    headers: { get: () => null },
    text: async () => "profile",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.textContent, "“上次活跃”获取完成");

  await advance(3_999);
  assert.equal(status.textContent, "“上次活跃”获取完成");
  await advance(1);
  assert.equal(status.textContent, "“完成条目数”获取完成");
  await advance(1_000);
  assert.equal(status.textContent, "");
});

test("主页同步率与共同喜好数切换复用任务、去重请求并按最后字段统计失败", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const now = 100_000;
  const syncField = sorter.relationFieldFor("visitor", "syncRate");
  const writes = [];
  const requests = [];
  const progress = [];
  let releaseA;
  const pendingA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({
        version: 3,
        records: {
          a: {
            [sorter.relationFieldFor("visitor", "commonLikes")]: {
              value: 1,
              fetchedAt: now,
            },
          },
          b: { [syncField]: { value: 10, fetchedAt: now } },
        },
      });
    },
    setItem(key, value) {
      writes.push([key, JSON.parse(value)]);
    },
    removeItem() {},
  };

  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage,
    now: () => now,
    domParser: {
      parseFromString: (userIdentifier) =>
        userIdentifier === "a"
          ? profileDocumentWithRelation({
              syncRate: "50%",
              counts: { all: 1, "2": 1, "3": 1, "4": 1, "6": 1 },
            })
          : profileDocumentWithRelation({
              syncRate: "70%",
              commonLikes: 20,
              counts: { all: 2, "2": 2, "3": 2, "4": 2, "6": 2 },
            }),
    },
    fetchImpl: (url) => {
      const userIdentifier = url.split("/").pop();
      requests.push(userIdentifier);
      return userIdentifier === "a"
        ? pendingA
        : Promise.resolve({ ok: true, text: async () => userIdentifier });
    },
    onProgress: (completed, total) => progress.push([completed, total]),
  });

  const sortOptions = page.list.beforeNodes[0].children[0].children[0];
  const relationDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "喜好契合",
  );
  const relationButton = relationDropdown.children[0];
  const relationMenu = relationDropdown.children[1];
  const status = sortOptions.children.at(-1);

  relationButton.click();
  assert.deepEqual(requests, ["a"]);
  relationMenu.children[1].click();
  releaseA({ ok: true, text: async () => "a" });

  for (let attempt = 0; attempt < 20 && requests.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  for (let attempt = 0; attempt < 20 && writes.length < 1; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(requests, ["a", "b"]);
  assert.ok(progress.some(([completed, total]) => completed === 0 && total === 2));
  assert.ok(progress.some(([completed, total]) => completed === 2 && total === 2));
  assert.equal(status.textContent, "“喜好契合”获取完成，1 人失败");
  assert.deepEqual(page.list.children.map((item) => item.textContent), ["B", "A"]);
  assert.deepEqual(writes.at(-1)[1].records.a[syncField], {
    value: 50,
    fetchedAt: now,
  });
  assert.deepEqual(writes.at(-1)[1].records.a[sorter.relationFieldFor("visitor", "commonLikes")], {
    value: 1,
    fetchedAt: now,
  });
  assert.deepEqual(writes.at(-1)[1].records.b[sorter.relationFieldFor("visitor", "commonLikes")], {
    value: 20,
    fetchedAt: now,
  });
  assert.deepEqual(writes.at(-1)[1].records.a[sorter.completionFieldFor("all")], {
    value: 1,
    fetchedAt: now,
  });
  assert.deepEqual(writes.at(-1)[1].records.b[sorter.completionFieldFor("all")], {
    value: 2,
    fetchedAt: now,
  });
});

test("同步率切换到完成条目数时复用同一主页任务", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const now = 100_000;
  const syncField = sorter.relationFieldFor("visitor", "syncRate");
  let releaseA;
  const pendingA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const requests = [];
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({
        version: 3,
        records: {
          b: { [syncField]: { value: 10, fetchedAt: now } },
        },
      });
    },
    setItem() {},
    removeItem() {},
  };

  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage,
    now: () => now,
    domParser: {
      parseFromString: (userIdentifier) =>
        profileDocumentWithRelation({
          syncRate: userIdentifier === "a" ? "50%" : "70%",
          commonLikes: userIdentifier === "a" ? 2 : 3,
          counts: {
            all: userIdentifier === "a" ? 1 : 5,
            "2": 1,
            "3": 1,
            "4": 1,
            "6": 1,
          },
        }),
    },
    fetchImpl: (url) => {
      const userIdentifier = url.split("/").pop();
      requests.push(userIdentifier);
      return userIdentifier === "a"
        ? pendingA
        : Promise.resolve({ ok: true, text: async () => userIdentifier });
    },
  });

  const sortOptions = page.list.beforeNodes[0].children[0].children[0];
  const relationDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "喜好契合",
  );
  const completionDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "完成条目数",
  );
  relationDropdown.children[0].click();
  assert.deepEqual(requests, ["a"]);
  completionDropdown.children[0].click();
  assert.deepEqual(requests, ["a", "b"]);
  releaseA({ ok: true, text: async () => "a" });

  for (let attempt = 0; attempt < 20 && requests.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  for (let attempt = 0; attempt < 20 && page.list.children[0].textContent !== "B"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(requests, ["a", "b"]);
  assert.deepEqual(page.list.children.map((item) => item.textContent), ["B", "A"]);
});

test("取消大批量扩充后恢复旧主页任务目标", async () => {
  const entries = Array.from({ length: 403 }, (_, index) => ({
    href: `/user/friend-${index}`,
    name: `好友${index}`,
  }));
  const page = friendPageWith(entries);
  const now = 100_000;
  const syncField = sorter.relationFieldFor("visitor", "syncRate");
  const cachedRecords = {};
  for (let index = 1; index < entries.length; index += 1) {
    cachedRecords[`friend-${index}`] = {
      [syncField]: { value: 10, fetchedAt: now },
    };
  }
  cachedRecords["friend-402"][
    sorter.relationFieldFor("visitor", "commonLikes")
  ] = { value: 20, fetchedAt: now };
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({ version: 3, records: cachedRecords });
    },
    setItem() {},
    removeItem() {},
  };
  let releaseFirst;
  const firstResponse = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const requests = [];
  const confirmations = [];

  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage,
    now: () => now,
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: (url) => {
      requests.push(url);
      return firstResponse;
    },
    confirm: (message) => {
      confirmations.push(message);
      return false;
    },
  });

  const sortOptions = page.list.beforeNodes[0].children[0].children[0];
  const relationDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "喜好契合",
  );
  const relationMenu = relationDropdown.children[1];
  const status = sortOptions.children.at(-1);

  relationDropdown.children[0].click();
  assert.deepEqual(requests, ["/user/friend-0"]);
  relationMenu.children[1].click();
  assert.deepEqual(confirmations, [
    "本次新增获取的好友数量过多（401 人），是否继续？",
  ]);
  releaseFirst({ ok: true, text: async () => "profile" });

  for (let attempt = 0; attempt < 20 && status.textContent === ""; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  for (let attempt = 0; attempt < 20 && !status.textContent.includes("获取完成"); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(requests, ["/user/friend-0"]);
  assert.equal(status.textContent, "“喜好契合”获取完成");
  assert.equal(page.list.children[0].textContent, "好友402");
});

test("主页任务按好友用户标识去重重复条目", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A1" },
    { href: "/user/a", name: "A2" },
  ]);
  const requests = [];
  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    now: () => 100_000,
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: true, text: async () => "profile" };
    },
  });

  const sortOptions = page.list.beforeNodes[0].children[0].children[0];
  const relationDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "喜好契合",
  );
  relationDropdown.children[0].click();
  for (let attempt = 0; attempt < 20 && requests.length < 1; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(requests, ["/user/a"]);
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
    (child) => child?.children?.[0]?.textContent === "完成条目数",
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

  directionButtons[0].click();
  assert.deepEqual(page.list.children.map((item) => item.textContent), ["A", "B"]);
  directionButtons[1].click();
  assert.deepEqual(page.list.children.map((item) => item.textContent), ["B", "A"]);
});

test("完成统计范围在刷新期间切换后补取新增缺失好友", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const now = 100_000;
  const requests = [];
  const writes = [];
  let releaseA;
  const responseFor = (userIdentifier) => ({
    ok: true,
    text: async () => userIdentifier,
  });
  const responseA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({
        version: 3,
        records: {
          b: { completion_all: { value: 5, fetchedAt: now } },
        },
      });
    },
    setItem(key, value) {
      writes.push(JSON.parse(value));
    },
    removeItem() {},
  };

  sorter.initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage,
    now: () => now,
    domParser: {
      parseFromString: (userIdentifier) =>
        profileStatsDocument({
          includeBooks: true,
          counts:
            userIdentifier === "a"
              ? { all: 1, "1": 10, "2": 1, "3": 1, "4": 1, "6": 1 }
              : { all: 2, "1": 20, "2": 2, "3": 2, "4": 2, "6": 2 },
        }),
    },
    fetchImpl: (url) => {
      const userIdentifier = url.split("/").pop();
      requests.push(userIdentifier);
      return userIdentifier === "a"
        ? responseA
        : Promise.resolve(responseFor(userIdentifier));
    },
  });

  const filters = page.list.beforeNodes[0].children[0];
  const sortOptions = filters.children[0];
  const completionDropdown = sortOptions.children.find(
    (child) => child?.children?.[0]?.textContent === "完成条目数",
  );
  const completionButton = completionDropdown.children[0];
  const completionMenu = completionDropdown.children[1];

  completionButton.click();
  assert.deepEqual(requests, ["a"]);
  completionMenu.children[2].click();
  releaseA(responseFor("a"));

  for (let attempt = 0; attempt < 10 && requests.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  for (let attempt = 0; attempt < 10 && writes.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(requests, ["a", "b"]);
  assert.deepEqual(writes.at(-1).records.b, {
    completion_all: { value: 2, fetchedAt: now },
    completion_1: { value: 20, fetchedAt: now },
    completion_2: { value: 2, fetchedAt: now },
    completion_3: { value: 2, fetchedAt: now },
    completion_4: { value: 2, fetchedAt: now },
    completion_6: { value: 2, fetchedAt: now },
  });
  assert.deepEqual(page.list.children.map((item) => item.textContent), ["B", "A"]);
});

test("完成条目数两击全量刷新使用实际范围名称并忽略有效缓存", async () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
  const now = 100_000;
  const requests = [];
  sorter.initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage: {
      getItem(key) {
        if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
        return JSON.stringify({
          version: 3,
          records: {
            a: { completion_all: { value: 1, fetchedAt: now } },
          },
        });
      },
      setItem() {},
      removeItem() {},
    },
    now: () => now,
    domParser: { parseFromString: () => profileStatsDocument() },
    fetchImpl: (url) => {
      requests.push(url);
      return Promise.resolve({ ok: true, text: async () => "profile" });
    },
  });

  const sortOptions = page.list.beforeNodes[0].children[0].children[0];
  const completionDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "完成条目数",
  );
  const completionButton = completionDropdown.children[0];
  const status = sortOptions.children.at(-1);

  completionButton.click();
  assert.deepEqual(requests, []);
  completionButton.click();
  assert.equal(status.textContent, "5 秒内再次点击“全部”以全量刷新");
  completionButton.click();
  assert.deepEqual(requests, ["/user/a"]);
  await new Promise((resolve) => setImmediate(resolve));
});

test("完成条目数菜单按钮与菜单项之间保持连续悬停区域", () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
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
  });

  const styleText = page.document.head.children[0].textContent;
  assert.match(
    styleText,
    /\.bangumi-friend-sorter-dropdown:hover[\s\S]*\.bangumi-friend-sorter-dropdown-menu/,
  );
  assert.match(
    styleText,
    /\.bangumi-friend-sorter-dropdown-menu \{[\s\S]*top: 100%;/,
  );
  assert.doesNotMatch(styleText, /top: calc\(100% \+ 3px\)/);
});

test("完成条目数菜单支持悬停、焦点、键盘和触屏点击", () => {
  const selected = [];
  const page = friendPageWith([]);
  const controls = sorter.createSortBar(
    page.document,
    (criterion, scope) => selected.push([criterion, scope]),
  );
  const filters = controls.bar.children[0];
  const sortOptions = filters.children[0];
  const dropdown = sortOptions.children.find(
    (child) => child?.children?.[0]?.textContent === "完成条目数",
  );
  const toggle = dropdown.children[0];
  const menu = dropdown.children[1];
  const bookButton = menu.children[2];

  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  dropdown.dispatchEvent({ type: "pointerenter" });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(dropdown.dataset.open, "true");

  dropdown.dispatchEvent({ type: "pointerleave" });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  toggle.focus();
  assert.equal(page.document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  bookButton.focus();
  const keyboardEvent = { type: "keydown", key: "Enter" };
  bookButton.dispatchEvent(keyboardEvent);
  assert.equal(keyboardEvent.defaultPrevented, true);
  assert.deepEqual(selected, [["completion", "1"]]);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  const musicButton = menu.children[3];
  musicButton.focus();
  const spaceEvent = { type: "keydown", key: " " };
  musicButton.dispatchEvent(spaceEvent);
  assert.equal(spaceEvent.defaultPrevented, true);
  assert.deepEqual(selected, [
    ["completion", "1"],
    ["completion", "3"],
  ]);

  page.document.createElement("div").focus();
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  toggle.click();
  assert.deepEqual(selected, [
    ["completion", "1"],
    ["completion", "3"],
    ["completion", "all"],
  ]);
  assert.equal(page.document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
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
