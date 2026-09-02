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
    const strong = new Element("strong");
    strong.append(anchor);
    const container = new Element("div");
    container.className = "userContainer";
    container.append(strong);
    const item = new Element("li");
    item.textContent = name;
    item.querySelector = (selector) => {
      if (selector === 'a.avatar[href*="/user/"]') return anchor;
      if (selector === ".userContainer strong") return strong;
      assert.fail(`unexpected selector: ${selector}`);
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

function filtersFor(page) {
  return page.list.beforeNodes[0].children[0];
}

function rankFor(item) {
  const strong = item.querySelector(".userContainer strong");
  return strong.children.at(-1).textContent;
}

function sortOptionsFor(page) {
  return filtersFor(page).children[0];
}

function statusFor(page) {
  return sortOptionsFor(page).children.at(-1);
}

function friendCacheStorage(records) {
  return {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({ version: 3, records });
    },
    setItem() {},
    removeItem() {},
  };
}

function refreshResponseFor(url) {
  return {
    ok: true,
    headers: { get: () => null },
    text: async () => (url.endsWith("/timeline") ? "timeline" : "profile"),
  };
}

async function waitForCondition(predicate, maxAttempts = 40) {
  for (let attempt = 0; attempt < maxAttempts && !predicate(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true);
}

function initializeRefreshPage({
  confirm,
  domParser,
  entries,
  fetchImpl,
  now,
  records,
}) {
  const page = friendPageWith(entries);
  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: friendCacheStorage(records),
    now: () => now,
    setTimeout: () => 1,
    clearTimeout() {},
    domParser,
    fetchImpl,
    confirm,
  });
  return page;
}

// Drives the production refresh orchestration (createFriendRefreshTasks) so
// tests exercise the same lifecycle the sorter bar uses at runtime.
function createRefreshHarness({
  cache,
  friends,
  runtime,
  visitorIdentifier = "visitor",
}) {
  const statusElement = { textContent: "" };
  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });
  const refresh = sorter.createFriendRefreshTasks({
    applyActivitySort: () => resolveFinished(),
    applyProfileSort: () => resolveFinished(),
    cache,
    friends,
    now: runtime.now ?? (() => 1_000),
    pageWindow: {},
    runtime,
    statusElement,
    visitorIdentifier,
  });
  return { finished, refresh, statusElement };
}

function mainSortControl(page, label) {
  return sortOptionsFor(page).children.find(
    (child) =>
      (child?.tagName === "button" && child.textContent === label) ||
      child?.children?.[0]?.textContent === label,
  );
}

function directionOptionsFor(page) {
  return filtersFor(page).children[1];
}

function directionButtonsFor(page) {
  return directionOptionsFor(page).children.filter(
    (child) => child?.tagName === "button",
  );
}

function dropdownItems(page, label) {
  return mainSortControl(page, label).children[1].children;
}

function dropdownButtonFor(page, label) {
  return mainSortControl(page, label).children[0];
}

function dropdownForBar(controls, label) {
  const sortOptions = controls.bar.children[0].children[0];
  return sortOptions.children.find(
    (child) => child?.children?.[0]?.textContent === label,
  );
}

// Fake timer wheel shared by status-timing tests: advance fires due timers in
// due order and yields to the microtask queue afterwards.
function fakeTimers(startTime = 0) {
  let now = startTime;
  let nextTimerId = 0;
  const timers = new Map();
  return {
    timers,
    setTimer(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    async advance(milliseconds) {
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
    },
    now: () => now,
    setNow(value) {
      now = value;
    },
  };
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
  const activities = sorter.createFriendCache(null);
  for (const [userIdentifier, record] of [
    ["older", { kind: "active", activityAtSeconds: 1, fetchedAt: 4_000 }],
    ["empty", { kind: "empty", fetchedAt: 4_000 }],
    ["newer-a", { kind: "active", activityAtSeconds: 2, fetchedAt: 4_000 }],
    ["newer-b", { kind: "active", activityAtSeconds: 2, fetchedAt: 4_000 }],
  ]) {
    activities.setField(userIdentifier, "activity", record);
  }

  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "activity",
      friendCache: activities,
    }).map(
      ({ userIdentifier }) => userIdentifier,
    ),
    ["newer-a", "newer-b", "older", "unknown", "empty"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "activity",
      friendCache: activities,
      direction: "asc",
    }).map(
      ({ userIdentifier }) => userIdentifier,
    ),
    ["older", "newer-a", "newer-b", "unknown", "empty"],
  );
});

test("初始化后每个好友项显示网页默认顺序名次", () => {
  const page = friendPageWith([
    { href: "/user/c", name: "Cara" },
    { href: "/user/a", name: "Ann" },
    { href: "/user/b", name: "Ben" },
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

  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2", "#3"]);
});

test("名次随每次重排更新，#1 始终是当前展示顺序的第一位", () => {
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

  const pairs = () =>
    page.list.children.map((item) => [item.textContent, rankFor(item)]);
  const sortOptions = sortOptionsFor(page);
  const directionOptions = directionOptionsFor(page);
  const sortButtons = sortOptions.children.filter(
    (child) => child?.tagName === "button",
  );
  const directionButtons = directionOptions.children.filter(
    (child) => child?.tagName === "button",
  );
  sortButtons[1].click();
  assert.deepEqual(pairs(), [
    ["Ada", "#1"],
    ["Bob", "#2"],
    ["Zed", "#3"],
  ]);

  directionButtons[1].click();
  assert.deepEqual(pairs(), [
    ["Zed", "#1"],
    ["Bob", "#2"],
    ["Ada", "#3"],
  ]);

  sortButtons[0].click();
  assert.deepEqual(pairs(), [
    ["Zed", "#1"],
    ["Bob", "#2"],
    ["Ada", "#3"],
  ]);
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

test("仅为缺失或超过二十四小时的上次活跃缓存安排请求", () => {
  const hour = 60 * 60 * 1_000;
  const now = 30 * hour;
  const friends = [
    { userIdentifier: "fresh-active" },
    { userIdentifier: "fresh-empty" },
    { userIdentifier: "boundary" },
    { userIdentifier: "stale" },
    { userIdentifier: "missing" },
  ];
  const activities = sorter.createFriendCache(null);
  for (const [userIdentifier, record] of [
    ["fresh-active", { kind: "active", activityAtSeconds: 10, fetchedAt: now - hour }],
    ["fresh-empty", { kind: "empty", fetchedAt: now - hour }],
    ["boundary", { kind: "active", activityAtSeconds: 20, fetchedAt: now - 24 * hour }],
    ["stale", { kind: "active", activityAtSeconds: 30, fetchedAt: now - 24 * hour - 1 }],
  ]) {
    activities.setField(userIdentifier, "activity", record);
  }

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
  const dropdownButtons = sortOptions.children
    .filter((child) => child?.className === "bangumi-friend-sorter-dropdown")
    .map((dropdown) => dropdown.children[0]);

  assert.equal(controls.bar.id, "browserTools");
  assert.equal(controls.bar.className, "clearit bangumi-friend-sorter-bar");
  assert.equal(filters.id, "bangumi-friend-sorter");
  assert.equal(filters.className, "filters");
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
  for (const button of [
    ...sortButtons,
    ...dropdownButtons,
    ...directionButtons,
  ]) {
    assert.ok(button.className.split(/\s+/).includes("l"));
  }

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

test("页面初始化提供五个主排序目标、全部子项和各自主按钮方向", () => {
  const page = friendPageWith([
    { href: "/user/z", name: "Zed" },
    { href: "/user/a", name: "Ada" },
  ]);

  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/sai/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
  });

  const sortOptions = sortOptionsFor(page);
  const directionButtons = directionButtonsFor(page);
  const directButtons = sortOptions.children.filter(
    (child) => child?.tagName === "button",
  );
  const dropdowns = sortOptions.children.filter(
    (child) => child?.className === "bangumi-friend-sorter-dropdown",
  );

  assert.deepEqual(
    [...directButtons.map(({ textContent }) => textContent), ...dropdowns.map(
      (dropdown) => dropdown.children[0].textContent,
    )],
    ["加好友时间", "名称", "上次活跃", "喜好契合", "完成条目数"],
  );
  assert.deepEqual(
    dropdownItems(page, "喜好契合").map(({ textContent }) => textContent),
    ["同步率", "共同喜好数"],
  );
  assert.deepEqual(
    dropdownItems(page, "完成条目数").map(({ textContent }) => textContent),
    ["全部", "动画", "书籍", "音乐", "游戏", "三次元"],
  );
  assert.equal(directButtons[0].getAttribute("aria-current"), "true");
  assert.deepEqual(directionButtons.map(({ textContent }) => textContent), [
    "从旧到新",
    "从新到旧",
  ]);

  for (const control of [directButtons[1], directButtons[2], ...dropdowns]) {
    const button = control.tagName === "button" ? control : control.children[0];
    button.click();
    assert.deepEqual(directionButtons.map(({ textContent }) => textContent), [
      ...(button.textContent === "上次活跃"
        ? ["从旧到新", "从新到旧"]
        : button.textContent === "名称"
          ? ["升序", "降序"]
          : ["从低到高", "从高到低"]),
    ]);
    directionButtons[0].click();
    directButtons[0].click();
    button.click();
    assert.equal(directionButtons[0].getAttribute("aria-current"), "true");
    directionButtons[1].click();
    assert.equal(directionButtons[1].getAttribute("aria-current"), "true");
  }
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

  const sortOptions = sortOptionsFor(page);
  const directionOptions = directionOptionsFor(page);
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

test("上次活跃刷新完成后沿用刷新期间选择的方向", async () => {
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
    const sortOptions = sortOptionsFor(page);
    const directionOptions = directionOptionsFor(page);
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

test("远程排序目标点击使用统一的待命和刷新动作", () => {
  assert.deepEqual(
    sorter.nextRemoteSelectionAction(null, { kind: "activity" }, "idle"),
    { kind: "select", clearPrompt: false, refreshMode: "incremental" },
  );
  assert.deepEqual(
    sorter.nextRemoteSelectionAction(
      { kind: "activity" },
      { kind: "activity" },
      "idle",
    ),
    { kind: "arm", clearPrompt: false, refreshMode: null },
  );
  assert.deepEqual(
    sorter.nextRemoteSelectionAction(
      { kind: "activity" },
      { kind: "activity" },
      "armed",
    ),
    { kind: "refresh", clearPrompt: true, refreshMode: "full" },
  );
  assert.deepEqual(
    sorter.nextRemoteSelectionAction(
      { kind: "activity" },
      { kind: "activity" },
      "fetching",
    ),
    { kind: "ignore" },
  );
  assert.deepEqual(
    sorter.nextRemoteSelectionAction(
      { kind: "activity" },
      { kind: "activity" },
      "completed",
    ),
    { kind: "ignore" },
  );
  assert.deepEqual(
    sorter.nextRemoteSelectionAction(
      { kind: "completion", scope: "all" },
      { kind: "relation", metric: "syncRate" },
      "fetching",
    ),
    { kind: "select", clearPrompt: false, refreshMode: "incremental" },
  );
  assert.deepEqual(
    sorter.nextRemoteSelectionAction(
      { kind: "completion", scope: "all" },
      null,
      "armed",
    ),
    { kind: "select", clearPrompt: true, refreshMode: null },
  );
  assert.deepEqual(
    sorter.nextRemoteSelectionAction(
      null,
      { kind: "relation", metric: "syncRate" },
      "completed",
    ),
    { kind: "select", clearPrompt: false, refreshMode: "incremental" },
  );
  assert.deepEqual(
    sorter.nextRemoteSelectionAction(
      { kind: "relation", metric: "syncRate" },
      { kind: "relation", metric: "commonLikes" },
      "idle",
    ),
    { kind: "select", clearPrompt: false, refreshMode: "incremental" },
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

test("活跃时刻保留页面提供的整数 Unix 秒精度", () => {
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

test("“分钟”后缀不阻止分秒文案恢复秒数", () => {
  const document = timelineDocumentFromFixture(
    "timeline-active-minutes-suffix-seconds.html",
  );
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
  });
});

test("含“分钟”的大单位文案不推测秒数", () => {
  const document = timelineDocumentFromFixture(
    "timeline-active-minutes-suffix-large.html",
  );
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 34) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 7, 42) / 1_000,
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

test("收到限流响应时立即停止上次活跃请求批次", () => {
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
    lifecycle: {},
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
    lifecycle: {},
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

test("全量刷新扩充进行中的同页面类型任务且不重试已尝试好友", async () => {
  const scheduler = sorter.createTaskScheduler({ concurrency: 1 });
  const started = [];
  const pending = new Map();
  const finished = [];
  const fetch = (item) =>
    new Promise((resolve) => {
      started.push(item);
      pending.set(item, resolve);
    });
  const options = (target) => ({
    fetch,
    isSuccess: (record, outcome) => outcome.kind === "success" && record,
    lifecycle: {
      onFinished: (result) => finished.push(result),
    },
    target,
  });

  // Incremental task: p1's field parse fails; p2 stays in flight so the
  // task survives until the full-refresh expansion arrives.
  scheduler.setForeground("profile");
  scheduler.enqueue("profile", ["p1", "p2"], options("syncRate"));
  pending.get("p1")({ kind: "parse-error" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["p1", "p2"]);

  // A full refresh requests every friend against the same running task:
  // already attempted (including parse-failed) and queued friends are not
  // re-added, only genuinely new ones join the union.
  scheduler.enqueue("profile", ["p1", "p2", "p3"], options("full"));
  assert.deepEqual(started, ["p1", "p2"]);

  pending.get("p2")({ kind: "success", record: { value: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["p1", "p2", "p3"]);

  pending.get("p3")({ kind: "success", record: { value: 2 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.getTask("profile"), null);
  assert.deepEqual(finished, [
    {
      completed: 3,
      failures: 1,
      globallyStopped: false,
      stopped: false,
      target: "full",
      total: 3,
    },
  ]);
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
    lifecycle: {
      onFinished: (result) => finished.push([type, result]),
    },
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
    lifecycle: {
      onFinished: (result) => finished.push([type, result]),
    },
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

test("停止任务在残余请求完成前重新入队不会留下不可调度队列", async () => {
  const scheduler = sorter.createTaskScheduler({ concurrency: 4 });
  const started = [];
  const pending = new Map();
  const finished = [];
  const options = {
    fetch: (item) =>
      new Promise((resolve) => {
        started.push(item);
        pending.set(item, resolve);
      }),
    isSuccess: () => false,
    lifecycle: {
      onFinished: (result) => finished.push(result),
    },
  };

  scheduler.setForeground("profile");
  scheduler.enqueue(
    "profile",
    ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"],
    options,
  );
  assert.deepEqual(started, ["a1", "a2", "a3", "a4"]);

  const reject = async (item) => {
    const resolve = pending.get(item);
    assert.ok(resolve, `expected a pending request for ${item}`);
    pending.delete(item);
    resolve({ kind: "http-error", status: 500 });
    await new Promise((complete) => setImmediate(complete));
  };

  await reject("a1");
  await reject("a2");
  await reject("a3");
  await reject("a4");
  await reject("a5");

  assert.deepEqual(started, [
    "a1",
    "a2",
    "a3",
    "a4",
    "a5",
    "a6",
    "a7",
    "a8",
  ]);
  const requeue = scheduler.enqueue("profile", ["retry"], options);
  assert.equal(requeue.added, 0);

  await reject("a6");
  await reject("a7");
  await reject("a8");

  assert.equal(finished.length, 1);
  assert.equal(finished[0].failures, 9);
  assert.equal(scheduler.getTask("profile"), null);
  assert.equal(pending.size, 0);
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

  const sortOptions = sortOptionsFor(page);
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
  await waitForCondition(
    () => started.filter((url) => url.endsWith("/timeline")).length === 5,
  );

  for (const userIdentifier of ["b", "c", "d", "e"]) {
    release(`/user/${userIdentifier}/timeline`);
  }
  await waitForCondition(() => pending.size === 0);
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
  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
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

  const sortOptions = sortOptionsFor(page);
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
  await waitForCondition(
    () => started.filter((url) => !url.endsWith("/timeline")).length === 1,
  );
  sortButtons[2].click();
  release("/user/b/timeline");
  await waitForCondition(() => started.includes("/user/e/timeline"));
  completionDropdown.children[0].click();
  release("/user/a");
  await waitForCondition(
    () => started.filter((url) => !url.endsWith("/timeline")).length === 2,
  );

  for (const userIdentifier of ["b", "c", "d"]) {
    release(`/user/${userIdentifier}`);
    await waitForCondition(
      () =>
        started.filter((url) => !url.endsWith("/timeline")).length ===
        ["b", "c", "d"].indexOf(userIdentifier) + 3,
    );
  }
  release("/user/e");

  for (const userIdentifier of ["c", "d", "e"]) {
    release(`/user/${userIdentifier}/timeline`);
  }
  await waitForCondition(() => pending.size === 0);
});

test("页面初始化全局最多四并发且限流会停止两类页面任务", async () => {
  const page = friendPageWith(
    ["a", "b", "c", "d", "e"].map((userIdentifier) => ({
      href: `/user/${userIdentifier}`,
      name: userIdentifier.toUpperCase(),
    })),
  );
  const started = [];
  const pending = new Map();

  sorter.initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/viewed/friends" } },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    domParser: {
      parseFromString: () =>
        timelineDocumentFromFixture("timeline-active-seconds.html"),
    },
    fetchImpl: (url) => {
      started.push(url);
      return new Promise((resolve) => pending.set(url, resolve));
    },
  });

  mainSortControl(page, "上次活跃").click();
  assert.equal(started.length, 4);
  mainSortControl(page, "完成条目数").children[0].click();
  assert.equal(started.length, 4);

  pending.get(started[0])({ ok: false, status: 429 });
  await waitForCondition(
    () => sortOptionsFor(page).children.at(-1).textContent === "请求受限，已停止全部获取",
  );

  assert.equal(started.length, 4);
  assert.equal(sortOptionsFor(page).children.at(-1).textContent, "请求受限，已停止全部获取");
  for (const [url, resolve] of [...pending]) {
    pending.delete(url);
    resolve({ ok: false, status: 429 });
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test("同一页面任务收到 429 时立即显示全局限流提示", async () => {
  const page = friendPageWith(
    ["a", "b", "c", "d", "e"].map((userIdentifier) => ({
      href: `/user/${userIdentifier}`,
      name: userIdentifier.toUpperCase(),
    })),
  );
  const pending = new Map();
  const started = [];

  sorter.initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/viewed/friends" } },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    domParser: {
      parseFromString: () => timelineDocumentFromFixture("timeline-active-seconds.html"),
    },
    fetchImpl: (url) => {
      started.push(url);
      return new Promise((resolve) => pending.set(url, resolve));
    },
  });

  mainSortControl(page, "上次活跃").click();
  assert.equal(started.length, 4);

  const firstRequest = pending.get(started[0]);
  pending.delete(started[0]);
  firstRequest({ ok: false, status: 429 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(statusFor(page).textContent, "请求受限，已停止全部获取");
  assert.equal(started.length, 4);

  for (const [url, resolve] of [...pending]) {
    pending.delete(url);
    resolve({
      ok: true,
      headers: { get: () => null },
      text: async () => "timeline",
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test("已有完成提示时收到 429 会立即抢占完成队列", async () => {
  const page = initializeRefreshPage({
    entries: ["a", "b", "c", "d", "e"].map((userIdentifier) => ({
      href: `/user/${userIdentifier}`,
      name: userIdentifier.toUpperCase(),
    })),
    now: 100_000,
    records: {},
    domParser: {
      parseFromString: (html) =>
        html === "timeline"
          ? timelineDocumentFromFixture("timeline-active-seconds.html")
          : profileStatsDocument(),
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/timeline")) return refreshResponseFor(url);
      return { ok: false, status: 429 };
    },
  });

  const status = statusFor(page);
  mainSortControl(page, "上次活跃").click();
  await waitForCondition(
    () => status.textContent === "“上次活跃”获取完成",
  );

  mainSortControl(page, "完成条目数").children[0].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(status.textContent, "请求受限，已停止全部获取");
});

test("本地排序不改变当前远程任务的前台优先级", async () => {
  const page = friendPageWith(
    ["a", "b", "c", "d", "e"].map((userIdentifier) => ({
      href: `/user/${userIdentifier}`,
      name: userIdentifier.toUpperCase(),
    })),
  );
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

  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
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

  mainSortControl(page, "上次活跃").click();
  dropdownButtonFor(page, "完成条目数").click();
  release("/user/a/timeline");
  await waitForCondition(() => started.includes("/user/a"));
  assert.equal(started.at(-1), "/user/a");

  mainSortControl(page, "名称").click();
  release("/user/b/timeline");
  await waitForCondition(() => started.length >= 6);
  assert.equal(started[5], "/user/b");

  for (let attempt = 0; attempt < 20 && pending.size > 0; attempt += 1) {
    for (const url of [...pending.keys()]) release(url);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pending.size, 0);
  await new Promise((resolve) => setImmediate(resolve));
});

test("主页连续五次服务端错误后停止并恢复暂停的时间胶囊任务", async () => {
  const identifiers = ["a", "b", "c", "d", "e"];
  const page = friendPageWith(
    identifiers.map((userIdentifier) => ({
      href: `/user/${userIdentifier}`,
      name: userIdentifier.toUpperCase(),
    })),
  );
  const started = [];
  const pending = new Map();
  sorter.initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/viewed/friends" } },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
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

  mainSortControl(page, "上次活跃").click();
  mainSortControl(page, "完成条目数").children[0].click();
  pending.get("/user/a/timeline")({
    ok: true,
    headers: { get: () => null },
    text: async () => "timeline",
  });
  await waitForCondition(() => pending.has("/user/a"));

  // Resolve failures one at a time because the three in-flight timeline
  // requests leave one global slot for the foreground profile task.
  for (const userIdentifier of identifiers) {
    const url = `/user/${userIdentifier}`;
    await waitForCondition(() => pending.has(url));
    const resolve = pending.get(url);
    pending.delete(url);
    resolve({ ok: false, status: 500 });
  }
  await waitForCondition(() => started.includes("/user/e/timeline"));

  assert.equal(
    sortOptionsFor(page).children.at(-1).textContent,
    "“完成条目数”获取完成，5 人失败",
  );
  for (const [url, resolve] of [...pending]) {
    pending.delete(url);
    resolve({
      ok: true,
      headers: { get: () => null },
      text: async () => (url.endsWith("/timeline") ? "timeline" : "profile"),
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test("持久存储不可用时上次活跃缓存仍在当前页面内工作", () => {
  const unavailableStorage = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    },
  };
  const cache = sorter.createFriendCache(unavailableStorage);
  const record = { kind: "active", activityAtSeconds: 1, fetchedAt: 2_000 };

  cache.setField("sai", "activity", record);

  assert.equal(cache.getField("sai", "activity"), record);
  assert.deepEqual([...cache.entries()], [["sai", { activity: record }]]);
});

test("升级缓存版本时迁移有效的 v2 上次活跃记录到 v3", () => {
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

  const cache = sorter.createFriendCache(storage, { now: () => 3_000 });

  assert.deepEqual(cache.getField("sai", "activity"), record);
  assert.deepEqual(writes, [[
    "bangumi-friend-sorter:activity-cache:v3",
    { version: 3, records: { sai: { activity: record } } },
  ]]);
  assert.deepEqual(removedKeys, [
    "bangumi-friend-sorter:activity-cache:v2",
    "bangumi-friend-sorter:activity-cache:v1",
  ]);
});

test("v2 上次活跃记录迁移遵守二十四小时有效期边界", () => {
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

  const cache = sorter.createFriendCache(storage, { now: () => now });

  assert.deepEqual([...cache.entries()], [
    ["fresh", { activity: records.fresh }],
    ["boundary", { activity: records.boundary }],
  ]);
});

test("v3 缓存不完整时仍合并尚未迁移的 v2 上次活跃记录", () => {
  const activity = { kind: "active", activityAtSeconds: 1_000, fetchedAt: 2_000 };
  const writes = [];
  const storage = {
    getItem(key) {
      if (key === "bangumi-friend-sorter:activity-cache:v3") {
        return JSON.stringify({
          version: 3,
          // 无法识别的字段在加载时被丢弃，因此 sai 缺少上次活跃记录。
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

  const cache = sorter.createFriendCache(storage, { now: () => 3_000 });

  assert.deepEqual(cache.get("sai"), { activity });
  assert.deepEqual(writes, [[
    "bangumi-friend-sorter:activity-cache:v3",
    { version: 3, records: { sai: { activity } } },
  ]]);
});

test("v3 缓存独立校验每个好友的完成字段", () => {
  const activity = {
    kind: "active",
    activityAtSeconds: 1_000,
    fetchedAt: 2_000,
  };
  const completion = { value: 87, fetchedAt: 3_000 };
  const completionField = sorter.completionFieldFor("all");
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({
        version: 3,
        records: {
          sai: { activity, [completionField]: completion },
          broken: {
            activity,
            [completionField]: { value: -1, fetchedAt: 3_000 },
          },
        },
      });
    },
  };

  const cache = sorter.createFriendCache(storage);

  assert.deepEqual(cache.get("sai"), { activity, [completionField]: completion });
  assert.deepEqual(cache.get("broken"), { activity });
  assert.deepEqual(cache.getField("sai", completionField), completion);
  assert.deepEqual([...cache.entries()], [
    ["sai", { activity, [completionField]: completion }],
    ["broken", { activity }],
  ]);
});

test("v3 缓存把喜好契合记录按访问者嵌套保存", () => {
  const writes = [];
  const storage = {
    getItem: () => null,
    setItem(key, value) {
      writes.push([key, JSON.parse(value)]);
    },
    removeItem() {},
  };
  const cache = sorter.createFriendCache(storage);
  const syncRecord = { value: 42.5, fetchedAt: 1_000 };
  const likesRecord = { value: 3, fetchedAt: 2_000 };

  cache.setRelationField("sai", "visitor", "syncRate", syncRecord, {
    persist: false,
  });
  cache.setRelationField("sai", "visitor", "commonLikes", likesRecord);
  cache.setField(
    "sai",
    sorter.completionFieldFor("all"),
    { value: 9, fetchedAt: 3_000 },
    false,
  );
  cache.persist();

  assert.deepEqual(writes.at(-1)[1], {
    version: 3,
    records: {
      sai: {
        completion_all: { value: 9, fetchedAt: 3_000 },
        relation: {
          visitor: { syncRate: syncRecord, commonLikes: likesRecord },
        },
      },
    },
  });
  assert.equal(
    cache.getRelationField("sai", {
      visitorIdentifier: "visitor",
      metric: "syncRate",
    }),
    syncRecord,
  );
  assert.equal(
    cache.getRelationField("sai", {
      visitorIdentifier: "other",
      metric: "syncRate",
    }),
    undefined,
  );
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

  const cache = sorter.createFriendCache(storage);

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
  const cache = sorter.createFriendCache(storage);
  const record = { kind: "active", activityAtSeconds: 1, fetchedAt: 2_000 };

  cache.setField("sai", "activity", record);

  assert.equal(cache.getField("sai", "activity"), record);
});

test("请求响应头的时间按整秒传给活跃时刻解析并写入整数 Unix 秒缓存", async () => {
  const document = timelineDocumentFromFixture("timeline-active-seconds.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36);
  const cache = sorter.createFriendCache(null);
  const { finished, refresh } = createRefreshHarness({
    cache,
    friends: [{ userIdentifier: "sai" }],
    runtime: {
      domParser: { parseFromString: () => document },
      fetchImpl: async () => ({
        ok: true,
        headers: { get: (name) => (name === "date" ? new Date(responseTime).toUTCString() : null) },
        text: async () => "fixture",
      }),
      now: () => responseTime,
    },
  });

  refresh.startActivity("incremental");
  await finished;

  assert.deepEqual(cache.getField("sai", "activity"), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
    fetchedAt: responseTime,
  });
});

test("时间胶囊返回四零四时计入失败且不覆盖缓存", async () => {
  const progress = [];
  const cache = sorter.createFriendCache(null);
  const { finished, refresh, statusElement } = createRefreshHarness({
    cache,
    friends: [{ userIdentifier: "missing" }],
    runtime: {
      domParser: {},
      fetchImpl: async () => ({ ok: false, status: 404 }),
      now: () => 1_000,
      onProgress: (completed, total) => progress.push([completed, total]),
    },
  });

  refresh.startActivity("incremental");
  await finished;

  assert.equal(statusElement.textContent, "“上次活跃”获取完成，1 人失败");
  assert.equal(cache.getField("missing", "activity"), undefined);
  assert.deepEqual(progress, [[0, 1], [1, 1]]);
});

test("用户主页返回四零四时计入失败且保留旧缓存", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const oldRecord = {
    [sorter.completionFieldFor("all")]: { value: 7, fetchedAt: staleFetchedAt },
    relation: {
      visitor: { syncRate: { value: 55, fetchedAt: staleFetchedAt } },
    },
  };
  const cache = sorter.createFriendCache(
    friendCacheStorage({ friend: oldRecord }),
  );
  const progress = [];
  const { finished, refresh, statusElement } = createRefreshHarness({
    cache,
    friends: [{ userIdentifier: "friend" }],
    runtime: {
      domParser: {},
      fetchImpl: async () => ({ ok: false, status: 404 }),
      now: () => now,
      onProgress: (completed, total) => progress.push([completed, total]),
    },
  });

  refresh.startProfile({ kind: "completion", scope: "all" });
  await finished;

  assert.equal(statusElement.textContent, "“完成条目数”获取完成，1 人失败");
  assert.deepEqual(progress, [[0, 1], [1, 1]]);
  assert.deepEqual(cache.get("friend"), oldRecord);
});

test("无效用户主页计入失败且保留旧缓存", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const oldRecord = {
    [sorter.completionFieldFor("all")]: { value: 7, fetchedAt: staleFetchedAt },
    relation: {
      visitor: { syncRate: { value: 55, fetchedAt: staleFetchedAt } },
    },
  };
  const cache = sorter.createFriendCache(
    friendCacheStorage({ friend: oldRecord }),
  );
  const { finished, refresh, statusElement } = createRefreshHarness({
    cache,
    friends: [{ userIdentifier: "friend" }],
    runtime: {
      domParser: { parseFromString: () => ({ querySelector: () => null }) },
      fetchImpl: async () => ({ ok: true, text: async () => "invalid profile" }),
      now: () => now,
    },
  });

  refresh.startProfile({ kind: "completion", scope: "all" });
  await finished;

  assert.equal(statusElement.textContent, "“完成条目数”获取完成，1 人失败");
  assert.deepEqual(cache.get("friend"), oldRecord);
});

test("用户主页请求超过十五秒时计入失败且保留旧缓存", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const oldRecord = {
    [sorter.completionFieldFor("all")]: { value: 7, fetchedAt: staleFetchedAt },
  };
  const cache = sorter.createFriendCache(
    friendCacheStorage({ friend: oldRecord }),
  );
  const scheduled = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let requestSignal;

  globalThis.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  globalThis.clearTimeout = () => {};

  try {
    const { finished, refresh, statusElement } = createRefreshHarness({
      cache,
      friends: [{ userIdentifier: "friend" }],
      runtime: {
        clearTimeout: () => {},
        domParser: {},
        fetchImpl: (_url, { signal }) => {
          requestSignal = signal;
          return new Promise((resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("request aborted"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(new Error("request aborted")),
              { once: true },
            );
          });
        },
        now: () => now,
        setTimeout: () => 0,
      },
    });

    refresh.startProfile({ kind: "completion", scope: "all" });

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 15_000);
    scheduled[0].callback();

    await finished;
    assert.equal(requestSignal.aborted, true);
    assert.equal(statusElement.textContent, "“完成条目数”获取完成，1 人失败");
    assert.deepEqual(cache.get("friend"), oldRecord);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("时间胶囊刷新任务通过请求结果、缓存写入和进度回调驱动", async () => {
  const requested = [];
  const progress = [];
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36);
  const cache = sorter.createFriendCache(null);
  const { finished, refresh, statusElement } = createRefreshHarness({
    cache,
    friends: [{ userIdentifier: "sai" }, { userIdentifier: "tom" }],
    runtime: {
      domParser: {
        parseFromString: () =>
          timelineDocumentFromFixture("timeline-active-seconds.html"),
      },
      fetchImpl: async (url) => {
        requested.push(url);
        return {
          ok: true,
          headers: {
            get: (name) =>
              name === "date" ? new Date(responseTime).toUTCString() : null,
          },
          text: async () => "fixture",
        };
      },
      now: () => responseTime,
      onProgress: (completed, total) => progress.push([completed, total]),
    },
  });

  refresh.startActivity("incremental");
  await finished;

  assert.deepEqual(requested.sort(), ["/user/sai/timeline", "/user/tom/timeline"]);
  const expectedActivity = {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
    fetchedAt: responseTime,
  };
  assert.deepEqual(cache.getField("sai", "activity"), expectedActivity);
  assert.deepEqual(cache.getField("tom", "activity"), expectedActivity);
  assert.deepEqual(
    progress.sort(([left], [right]) => left - right),
    [[0, 2], [1, 2], [2, 2]],
  );
  assert.equal(statusElement.textContent, "“上次活跃”获取完成");
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

  const sortButtons = sortOptionsFor(page).children.filter(
    (child) => child?.tagName === "button",
  );
  sortButtons[2].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests, 1);
  assert.equal(nowCalls, 3);
  assert.deepEqual(progress, [[0, 1], [1, 1]]);
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

test("三个支持站点都使用隔离存储和同源请求刷新两类页面", async () => {
  const domainWrites = new Map();
  for (const host of ["bgm.tv", "bangumi.tv", "chii.in"]) {
    const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
    const requests = [];
    const writes = [];
    domainWrites.set(host, writes);
    sorter.initialize({
      document: page.document,
      window: {
        location: { href: `https://${host}/user/viewed/friends` },
        localStorage: {
          getItem: () => null,
          setItem: (key, value) => writes.push([key, value]),
          removeItem() {},
        },
      },
      setTimeout: () => 1,
      clearTimeout() {},
      domParser: {
        parseFromString: (html) =>
          html === "timeline"
            ? timelineDocumentFromFixture("timeline-active-seconds.html")
            : profileStatsDocument(),
      },
      fetchImpl: async (url, options) => {
        const request = [url, options];
        requests.push(request);
        return {
          ok: true,
          headers: { get: () => null },
          text: async () => (url.endsWith("/timeline") ? "timeline" : "profile"),
        };
      },
    });

    mainSortControl(page, "上次活跃").click();
    mainSortControl(page, "完成条目数").children[0].click();
    for (
      let attempt = 0;
      attempt < 10 && (requests.length < 2 || writes.length === 0);
      attempt += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(requests.length, 2, host);
    assert.equal(requests[0][0], "/user/friend/timeline", host);
    assert.equal(requests[0][1].credentials, "same-origin", host);
    assert.equal(requests[1][0], "/user/friend", host);
    assert.equal(requests[1][1].credentials, "same-origin", host);
    assert.ok(writes.length > 0, host);
  }
  assert.notEqual(domainWrites.get("bgm.tv"), domainWrites.get("bangumi.tv"));
  assert.notEqual(domainWrites.get("bangumi.tv"), domainWrites.get("chii.in"));
});

test("单文件 userscript 元数据匹配三个站点的双好友页", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "index.user.js"),
    "utf8",
  );
  const matches = [...source.matchAll(/^\/\/ @match\s+(\S+)$/gm)].map(
    ([, value]) => value,
  );

  assert.deepEqual(matches, [
    "https://bgm.tv/user/*/friends",
    "https://bgm.tv/user/*/rev_friends",
    "https://bangumi.tv/user/*/friends",
    "https://bangumi.tv/user/*/rev_friends",
    "https://chii.in/user/*/friends",
    "https://chii.in/user/*/rev_friends",
  ]);
  // @description 等声明性字段由人工管理，测试只确认其存在，不断言内容。
  assert.match(source, /^\/\/ @description\s+\S.*$/m);
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
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

  const sortButtons = sortOptionsFor(page).children.filter(
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
    { kind: "success", parsedRelation: { syncRate: -3.5, commonLikes: 0 } },
  );
  assert.deepEqual(
    sorter.parseProfileDocument(relationProfileDocument({ syncRate: "2.25%" })),
    { kind: "success", parsedRelation: { syncRate: 2.25 } },
  );
  assert.deepEqual(
    sorter.parseProfileDocument(
      relationProfileDocument({ syncRate: "2.25%", commonLikes: "-3" }),
    ),
    { kind: "success", parsedRelation: { syncRate: 2.25 } },
  );
  assert.deepEqual(
    sorter.parseProfileDocument(
      relationProfileDocument({ syncRate: "2.25%", commonLikes: "1.5" }),
    ),
    { kind: "success", parsedRelation: { syncRate: 2.25 } },
  );
  const beyondSafeInteger = Number.MAX_SAFE_INTEGER + 1;
  assert.deepEqual(
    sorter.parseProfileDocument(
      relationProfileDocument({ commonLikes: beyondSafeInteger }),
    ),
    { kind: "success", parsedRelation: { commonLikes: beyondSafeInteger } },
  );
});

test("主页完成统计按完成描述定位六个统计范围", () => {
  const parsed = sorter.parseProfileDocument(
    profileStatsDocumentFromFixture("profile-stats.html"),
  );

  assert.deepEqual(parsed, {
    kind: "success",
    completion: { all: 20, "2": 8, "1": 10, "3": 6, "4": 4, "6": 2 },
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
    completion: { all: 20, "1": 0, "2": 8, "3": 6, "4": 4, "6": 2 },
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
    completion: { all: 0, "1": 0, "2": 0, "3": 0, "4": 0, "6": 0 },
  });

  const partial = sorter.parseProfileDocument(
    profileStatsDocument({ includeBooks: true, malformedBooks: true }),
  );
  assert.equal(partial.completion["1"], undefined);
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
  const values = sorter.createFriendCache(null);
  for (const [userIdentifier, value] of [
    ["same-b", 5],
    ["high", 10],
    ["zero", 0],
    ["same-a", 5],
  ]) {
    values.setField(userIdentifier, sorter.completionFieldFor("all"), {
      value,
      fetchedAt: 1,
    });
  }

  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "completion",
      friendCache: values,
      direction: "desc",
      completionScope: "all",
    })
      .map(({ userIdentifier }) => userIdentifier),
    ["high", "same-b", "same-a", "zero", "unknown"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "completion",
      friendCache: values,
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
    cache.setRelationField(userIdentifier, "visitor-a", "commonLikes", {
      value,
      fetchedAt: now,
    });
  }
  cache.setRelationField("unknown", "visitor-b", "commonLikes", {
    value: 99,
    fetchedAt: now,
  });

  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "relation",
      relationSelection: {
        metric: "commonLikes",
        visitorIdentifier: "visitor-a",
      },
      friendCache: cache,
      direction: "desc",
    }).map(({ userIdentifier }) => userIdentifier),
    ["high", "same-b", "same-a", "zero", "unknown"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "relation",
      relationSelection: {
        metric: "commonLikes",
        visitorIdentifier: "visitor-a",
      },
      friendCache: cache,
      direction: "asc",
    }).map(({ userIdentifier }) => userIdentifier),
    ["zero", "same-b", "same-a", "high", "unknown"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "relation",
      relationSelection: {
        metric: "commonLikes",
        visitorIdentifier: "visitor-b",
      },
      friendCache: cache,
    }).map(({ userIdentifier }) => userIdentifier),
    ["unknown", "same-b", "high", "zero", "same-a"],
  );
});

test("同步率排序支持负值并按方向稳定排列", () => {
  const friends = [
    { userIdentifier: "negative", originalIndex: 0 },
    { userIdentifier: "same-a", originalIndex: 1 },
    { userIdentifier: "positive", originalIndex: 2 },
    { userIdentifier: "same-b", originalIndex: 3 },
    { userIdentifier: "zero", originalIndex: 4 },
  ];
  const cache = sorter.createFriendCache(null);
  cache.setRelationField("negative", "visitor", "syncRate", {
    value: -3.5,
    fetchedAt: 1,
  });
  cache.setRelationField("positive", "visitor", "syncRate", {
    value: 2.25,
    fetchedAt: 1,
  });
  cache.setRelationField("zero", "visitor", "syncRate", {
    value: 0,
    fetchedAt: 1,
  });
  for (const userIdentifier of ["same-a", "same-b"]) {
    cache.setRelationField(userIdentifier, "visitor", "syncRate", {
      value: 1,
      fetchedAt: 1,
    });
  }

  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "relation",
      relationSelection: {
        metric: "syncRate",
        visitorIdentifier: "visitor",
      },
      friendCache: cache,
      direction: "desc",
    }).map(({ userIdentifier }) => userIdentifier),
    ["positive", "same-a", "same-b", "zero", "negative"],
  );
  assert.deepEqual(
    sorter.sortFriends(friends, {
      criterion: "relation",
      relationSelection: {
        metric: "syncRate",
        visitorIdentifier: "visitor",
      },
      friendCache: cache,
      direction: "asc",
    }).map(({ userIdentifier }) => userIdentifier),
    ["negative", "zero", "same-a", "same-b", "positive"],
  );
});

test("过期同步率仍参与即时排序并触发刷新", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const pending = new Map();
  const requests = [];
  const page = initializeRefreshPage({
    entries: [
      { href: "/user/low", name: "低" },
      { href: "/user/high", name: "高" },
    ],
    now,
    records: {
      low: {
        relation: {
          visitor: { syncRate: { value: -5, fetchedAt: staleFetchedAt } },
        },
      },
      high: {
        relation: {
          visitor: { syncRate: { value: 80, fetchedAt: staleFetchedAt } },
        },
      },
    },
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "0%" }),
    },
    fetchImpl: (url) => {
      requests.push(url);
      return new Promise((resolve) => pending.set(url, resolve));
    },
  });

  dropdownButtonFor(page, "喜好契合").click();

  assert.deepEqual(page.list.children.map(({ textContent }) => textContent), [
    "高",
    "低",
  ]);
  assert.deepEqual(requests, ["/user/low", "/user/high"]);

  for (const [url, resolve] of [...pending]) {
    pending.delete(url);
    resolve(refreshResponseFor(url));
  }
  await waitForCondition(() => statusFor(page).textContent.includes("获取完成"));
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
  const values = sorter.createFriendCache(null);
  for (const [userIdentifier, value] of [
    ["fresh", 1],
    ["boundary", 2],
    ["stale", 3],
  ]) {
    values.setField(userIdentifier, sorter.completionFieldFor("all"), {
      value,
      fetchedAt:
        userIdentifier === "fresh"
          ? now - hour
          : userIdentifier === "boundary"
            ? now - 72 * hour
            : now - 72 * hour - 1,
    });
  }

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
  cache.setRelationField("fresh", "visitor", "syncRate", {
    value: 1.5,
    fetchedAt: now - hour,
  });
  cache.setRelationField("boundary", "visitor", "syncRate", {
    value: 2,
    fetchedAt: now - 72 * hour,
  });
  cache.setRelationField("stale", "visitor", "syncRate", {
    value: 3,
    fetchedAt: now - 72 * hour - 1,
  });

  assert.deepEqual(
    sorter.findFriendsNeedingRelation(
      friends,
      cache,
      { metric: "syncRate", visitorIdentifier: "visitor" },
      now,
    ).map(({ userIdentifier }) => userIdentifier),
    ["stale", "missing"],
  );
  assert.deepEqual(
    sorter.findFriendsNeedingRelation(
      friends,
      cache,
      { metric: "syncRate", visitorIdentifier: "other-visitor" },
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
            relation: {
              [visitorA]: { syncRate: { value: 90, fetchedAt: now } },
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
  const sortOptionsA = sortOptionsFor(pageA);
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
  const sortOptionsB = sortOptionsFor(pageB);
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
  const cache = sorter.createFriendCache(storage);

  const { finished, refresh } = createRefreshHarness({
    cache,
    friends: [{ userIdentifier: "sai" }],
    runtime: {
      domParser: { parseFromString: () => profileStatsDocument({ includeBooks: true, malformedBooks: true }) },
      fetchImpl: async () => ({ ok: true, text: async () => "profile" }),
      now: () => now,
    },
  });

  refresh.startProfile({ kind: "completion", scope: "all" });
  await finished;

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

test("未登录时选择喜好契合不请求且登录提示不会因重复选择续时并允许切换子项", () => {
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  let requests = 0;
  const clock = fakeTimers();
  sorter.initialize({
    document: page.document,
    window: {
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    now: clock.now,
    setTimeout: clock.setTimer,
    clearTimeout: clock.clearTimer,
    fetchImpl: async () => {
      requests += 1;
      return { ok: false, status: 500 };
    },
  });

  const sortOptions = sortOptionsFor(page);
  const relationDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "喜好契合",
  );
  const relationButton = relationDropdown.children[0];
  const relationMenu = relationDropdown.children[1];
  const status = statusFor(page);

  relationButton.click();
  assert.equal(requests, 0);
  assert.equal(status.textContent, "请登录后使用喜好契合排序");
  assert.equal(relationButton.getAttribute("aria-current"), "true");
  assert.equal(relationMenu.children[0].getAttribute("aria-current"), "true");
  assert.deepEqual([...clock.timers.values()].map(({ due }) => due), [5_000]);
  const completionDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "完成条目数",
  );
  completionDropdown.children[0].click();
  assert.equal(status.textContent, "请登录后使用喜好契合排序");
  relationMenu.children[1].click();
  assert.equal(requests, 0);
  assert.equal(status.textContent, "请登录后使用喜好契合排序");
  assert.equal(relationButton.getAttribute("aria-current"), "true");
  assert.equal(relationMenu.children[0].getAttribute("aria-current"), null);
  assert.equal(relationMenu.children[1].getAttribute("aria-current"), "true");
  assert.deepEqual([...clock.timers.values()].map(({ due }) => due), [5_000]);
  relationMenu.children[1].click();
  assert.deepEqual([...clock.timers.values()].map(({ due }) => due), [5_000]);
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

  const sortOptions = sortOptionsFor(page);
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
  const clock = fakeTimers();
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
    now: clock.now,
    setTimeout: clock.setTimer,
    clearTimeout: clock.clearTimer,
    domParser: { parseFromString: () => profileStatsDocument() },
    fetchImpl: () => pendingProfile,
  });

  const sortOptions = sortOptionsFor(page);
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

  clock.setNow(1_000);
  releaseProfile({ ok: true, text: async () => "profile" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.textContent, "请登录后使用喜好契合排序");

  await clock.advance(4_000);
  assert.equal(status.textContent, "“完成条目数”获取完成");
  await clock.advance(1_000);
  assert.equal(status.textContent, "");
});

test("不同页面类型的完成提示按队头出现时间各保持五秒", async () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
  const clock = fakeTimers();
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
    now: clock.now,
    setTimeout: clock.setTimer,
    clearTimeout: clock.clearTimer,
    domParser: {
      parseFromString: (html) =>
        html === "timeline"
          ? timelineDocumentFromFixture("timeline-active-seconds.html")
          : profileStatsDocument(),
    },
    fetchImpl: (url) =>
      url.endsWith("/timeline") ? activityResponse : profileResponse,
  });

  const sortOptions = sortOptionsFor(page);
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

  clock.setNow(1_000);
  releaseProfile({
    ok: true,
    headers: { get: () => null },
    text: async () => "profile",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.textContent, "“上次活跃”获取完成");

  await clock.advance(3_999);
  assert.equal(status.textContent, "“上次活跃”获取完成");
  await clock.advance(1);
  assert.equal(status.textContent, "“完成条目数”获取完成");
  await clock.advance(4_999);
  assert.equal(status.textContent, "“完成条目数”获取完成");
  await clock.advance(1);
  assert.equal(status.textContent, "");
});

test("主页同步率与共同喜好数切换复用任务、去重请求并按最后字段统计失败", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const now = 100_000;
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
            relation: {
              visitor: { commonLikes: { value: 1, fetchedAt: now } },
            },
          },
          b: {
            relation: {
              visitor: { syncRate: { value: 10, fetchedAt: now } },
            },
          },
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

  const sortOptions = sortOptionsFor(page);
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

  await waitForCondition(() => requests.length >= 2);
  await waitForCondition(() => writes.length >= 1);

  assert.deepEqual(requests, ["a", "b"]);
  assert.ok(progress.some(([completed, total]) => completed === 0 && total === 2));
  assert.ok(progress.some(([completed, total]) => completed === 2 && total === 2));
  assert.equal(status.textContent, "“喜好契合”获取完成，1 人失败");
  assert.deepEqual(page.list.children.map((item) => item.textContent), ["B", "A"]);
  assert.deepEqual(writes.at(-1)[1].records.a.relation.visitor.syncRate, {
    value: 50,
    fetchedAt: now,
  });
  assert.deepEqual(writes.at(-1)[1].records.a.relation.visitor.commonLikes, {
    value: 1,
    fetchedAt: now,
  });
  assert.deepEqual(writes.at(-1)[1].records.b.relation.visitor.commonLikes, {
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
          b: {
            relation: {
              visitor: { syncRate: { value: 10, fetchedAt: now } },
            },
          },
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

  const sortOptions = sortOptionsFor(page);
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

  await waitForCondition(() => requests.length >= 2);
  await waitForCondition(() => page.list.children[0].textContent === "B");

  assert.deepEqual(requests, ["a", "b"]);
  assert.deepEqual(page.list.children.map((item) => item.textContent), ["B", "A"]);
});

test("切换字段但未新增好友时立即更新进行中提示的主按钮名称", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const now = 100_000;
  const cachedRecords = {
    a: {
      [sorter.completionFieldFor("all")]: { value: 1, fetchedAt: now },
    },
    b: {
      [sorter.completionFieldFor("all")]: { value: 2, fetchedAt: now },
      relation: { visitor: { syncRate: { value: 10, fetchedAt: now } } },
    },
  };
  let releaseA;
  const pendingA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const requests = [];

  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: friendCacheStorage(cachedRecords),
    now: () => now,
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: (url) => {
      requests.push(url);
      return url.endsWith("/a") ? pendingA : Promise.resolve({
        ok: true,
        text: async () => "b",
      });
    },
  });

  const completionButton = dropdownButtonFor(page, "完成条目数");
  const status = statusFor(page);

  dropdownButtonFor(page, "喜好契合").click();
  assert.deepEqual(requests, ["/user/a"]);
  assert.equal(status.textContent, "正在获取“喜好契合” 0/1");

  // 完成条目数（全部）没有缺失或过期好友：只改提示名称，进度数字不变。
  completionButton.click();
  assert.deepEqual(requests, ["/user/a"]);
  assert.equal(status.textContent, "正在获取“完成条目数” 0/1");

  releaseA({ ok: true, text: async () => "a" });
  await waitForCondition(() =>
    status.textContent.includes("“完成条目数”获取完成"),
  );
  assert.deepEqual(requests, ["/user/a"]);
});

test("取消大批量扩充后恢复旧主页任务目标", async () => {
  const entries = Array.from({ length: 403 }, (_, index) => ({
    href: `/user/friend-${index}`,
    name: `好友${index}`,
  }));
  const now = 100_000;
  const cachedRecords = {};
  for (let index = 1; index < entries.length; index += 1) {
    cachedRecords[`friend-${index}`] = {
      relation: {
        visitor: { syncRate: { value: 10, fetchedAt: now } },
      },
    };
  }
  cachedRecords["friend-402"].relation.visitor.commonLikes = {
    value: 20,
    fetchedAt: now,
  };
  let releaseFirst;
  const firstResponse = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const requests = [];
  const confirmations = [];

  const page = initializeRefreshPage({
    entries,
    now,
    records: cachedRecords,
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

  const relationButton = dropdownButtonFor(page, "喜好契合");
  const relationChoices = dropdownItems(page, "喜好契合");
  const status = statusFor(page);

  relationButton.click();
  assert.deepEqual(requests, ["/user/friend-0"]);
  relationChoices[1].click();
  assert.deepEqual(confirmations, [
    "本次新增获取的好友数量过多（401 人），是否继续？",
  ]);
  releaseFirst({ ok: true, text: async () => "profile" });

  await waitForCondition(() => status.textContent !== "");
  await waitForCondition(() => status.textContent.includes("获取完成"));

  assert.deepEqual(requests, ["/user/friend-0"]);
  assert.equal(status.textContent, "“喜好契合”获取完成");
  assert.equal(page.list.children[0].textContent, "好友402");
});

test("取消大批量主页扩充后恢复先前时间胶囊任务", async () => {
  const entries = Array.from({ length: 402 }, (_, index) => ({
    href: `/user/friend-${index}`,
    name: `好友${index}`,
  }));
  const now = 100_000;
  const cachedRecords = Object.fromEntries(
    entries.slice(5).map(({ href }) => [
      href.split("/").pop(),
      { activity: { kind: "active", activityAtSeconds: 1, fetchedAt: now } },
    ]),
  );
  const started = [];
  const pending = new Map();
  const confirmations = [];

  const page = initializeRefreshPage({
    entries,
    now,
    records: cachedRecords,
    domParser: {
      parseFromString: (html) =>
        html === "timeline"
          ? timelineDocumentFromFixture("timeline-active-seconds.html")
          : relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: (url) => {
      started.push(url);
      return new Promise((resolve) => pending.set(url, resolve));
    },
    confirm: (message) => {
      confirmations.push(message);
      return false;
    },
  });

  const activityButton = mainSortControl(page, "上次活跃");
  const relationButton = dropdownButtonFor(page, "喜好契合");
  const status = statusFor(page);

  activityButton.click();
  assert.equal(
    started.filter((url) => url.endsWith("/timeline")).length,
    4,
  );
  relationButton.click();
  assert.deepEqual(confirmations, [
    "本次新增获取的好友数量过多（402 人），是否继续？",
  ]);
  assert.equal(started.filter((url) => !url.endsWith("/timeline")).length, 0);

  const firstActivity = pending.get("/user/friend-0/timeline");
  pending.delete("/user/friend-0/timeline");
  firstActivity(refreshResponseFor("/user/friend-0/timeline"));
  await waitForCondition(
    () => started.filter((url) => url.endsWith("/timeline")).length === 5,
  );

  assert.equal(status.textContent, "正在获取“上次活跃” 1/5");
  for (const [url, resolve] of [...pending]) {
    pending.delete(url);
    resolve(refreshResponseFor(url));
  }
  await waitForCondition(() => pending.size === 0);
});

test("取消大批量主页扩充后保留前台时间胶囊进度提示", async () => {
  const entries = Array.from({ length: 403 }, (_, index) => ({
    href: `/user/friend-${index}`,
    name: `好友${index}`,
  }));
  const now = 100_000;
  const cachedRecords = Object.fromEntries(
    entries.slice(1).map(({ href }, index) => [
      href.split("/").pop(),
      {
        ...(index > 0
          ? {
              relation: {
                visitor: { syncRate: { value: 10, fetchedAt: now } },
              },
            }
          : {}),
        activity: { kind: "active", activityAtSeconds: 1, fetchedAt: now },
      },
    ]),
  );
  const started = [];
  const pending = new Map();
  const confirmations = [];

  const page = initializeRefreshPage({
    entries,
    now,
    records: cachedRecords,
    domParser: {
      parseFromString: (html) =>
        html === "timeline"
          ? timelineDocumentFromFixture("timeline-active-seconds.html")
          : relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: (url) => {
      started.push(url);
      return new Promise((resolve) => pending.set(url, resolve));
    },
    confirm: (message) => {
      confirmations.push(message);
      return false;
    },
  });

  const activityButton = mainSortControl(page, "上次活跃");
  const relationButton = dropdownButtonFor(page, "喜好契合");
  const relationChoices = dropdownItems(page, "喜好契合");
  const status = statusFor(page);

  relationButton.click();
  assert.deepEqual(started, ["/user/friend-0", "/user/friend-1"]);
  activityButton.click();
  assert.equal(status.textContent, "正在获取“上次活跃” 0/1");

  relationChoices[1].click();
  assert.deepEqual(confirmations, [
    "本次新增获取的好友数量过多（401 人），是否继续？",
  ]);
  assert.equal(status.textContent, "正在获取“上次活跃” 0/1");

  const firstProfile = pending.get("/user/friend-0");
  pending.delete("/user/friend-0");
  firstProfile(refreshResponseFor("/user/friend-0"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.textContent, "正在获取“上次活跃” 0/1");

  const activityResponse = pending.get("/user/friend-0/timeline");
  pending.delete("/user/friend-0/timeline");
  activityResponse(refreshResponseFor("/user/friend-0/timeline"));
  const secondProfile = pending.get("/user/friend-1");
  pending.delete("/user/friend-1");
  secondProfile(refreshResponseFor("/user/friend-1"));
  await new Promise((resolve) => setImmediate(resolve));
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

  const sortOptions = sortOptionsFor(page);
  const relationDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "喜好契合",
  );
  relationDropdown.children[0].click();
  await waitForCondition(() => requests.length >= 1);

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

  const sortOptions = sortOptionsFor(page);
  const completionDropdown = sortOptions.children.find(
    (child) => child?.children?.[0]?.textContent === "完成条目数",
  );
  const completionButton = completionDropdown.children[0];
  const completionMenu = completionDropdown.children[1];

  completionButton.click();
  assert.deepEqual(requests, ["a"]);
  completionMenu.children[2].click();
  releaseA(responseFor("a"));

  await waitForCondition(() => requests.length >= 2);
  await waitForCondition(() => writes.length > 0);

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
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
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
            b: { completion_all: { value: 2, fetchedAt: now } },
          },
        });
      },
      setItem() {},
      removeItem() {},
    },
    now: () => now,
    setTimeout: () => 1,
    clearTimeout() {},
    domParser: {
      parseFromString: (url) =>
        profileStatsDocument({
          counts: url.endsWith("/a")
            ? { all: 10, "1": 10, "2": 10, "3": 10, "4": 10, "6": 10 }
            : { all: 1, "1": 1, "2": 1, "3": 1, "4": 1, "6": 1 },
        }),
    },
    fetchImpl: (url) => {
      requests.push(url);
      return Promise.resolve({ ok: true, text: async () => url });
    },
  });

  const sortOptions = sortOptionsFor(page);
  const completionDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "完成条目数",
  );
  const completionButton = completionDropdown.children[0];
  const status = sortOptions.children.at(-1);

  completionButton.click();
  assert.deepEqual(requests, []);
  assert.deepEqual(page.list.children.map(({ textContent }) => textContent), [
    "B",
    "A",
  ]);
  completionButton.click();
  assert.equal(status.textContent, "5 秒内再次点击“全部”以全量刷新");
  completionButton.click();
  await waitForCondition(() => status.textContent.includes("获取完成"));
  assert.deepEqual(requests, ["/user/a", "/user/b"]);
  assert.equal(status.textContent, "“完成条目数”获取完成");
  assert.deepEqual(page.list.children.map(({ textContent }) => textContent), [
    "A",
    "B",
  ]);
});

test("取消全量刷新后必须重新两击才会再次触发", () => {
  const entries = Array.from({ length: 401 }, (_, index) => ({
    href: `/user/friend-${index}`,
    name: `好友${index}`,
  }));
  const now = 100_000;
  const records = Object.fromEntries(
    entries.map(({ href }) => [
      href.split("/").pop(),
      {
        relation: {
          visitor: { syncRate: { value: 10, fetchedAt: now } },
        },
      },
    ]),
  );
  const requests = [];
  const confirmations = [];
  const page = initializeRefreshPage({
    entries,
    now,
    records,
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: (url) => {
      requests.push(url);
      return Promise.resolve({ ok: true, text: async () => "profile" });
    },
    confirm: (message) => {
      confirmations.push(message);
      return false;
    },
  });

  const relationButton = dropdownButtonFor(page, "喜好契合");
  const status = statusFor(page);
  const confirmationMessage =
    "本次新增获取的好友数量过多（401 人），是否继续？";

  relationButton.click();
  relationButton.click();
  assert.equal(status.textContent, "5 秒内再次点击“同步率”以全量刷新");
  relationButton.click();
  assert.deepEqual(confirmations, [confirmationMessage]);
  assert.equal(status.textContent, "");
  assert.deepEqual(requests, []);

  relationButton.click();
  assert.equal(status.textContent, "5 秒内再次点击“同步率”以全量刷新");
  relationButton.click();
  assert.deepEqual(confirmations, [confirmationMessage, confirmationMessage]);
  assert.equal(status.textContent, "");
  assert.deepEqual(requests, []);
});

test("页面增量刷新恰好新增四百个请求时不确认", async () => {
  const page = friendPageWith(
    Array.from({ length: 400 }, (_, index) => ({
      href: `/user/friend-${index}`,
      name: `好友${index}`,
    })),
  );
  const requests = [];
  const confirmations = [];
  sorter.initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    now: () => 100_000,
    setTimeout: () => 1,
    clearTimeout() {},
    confirm: (message) => {
      confirmations.push(message);
      return true;
    },
    domParser: { parseFromString: () => profileStatsDocument() },
    fetchImpl: (url) => {
      requests.push(url);
      return Promise.resolve({ ok: true, text: async () => "profile" });
    },
  });

  const sortOptions = sortOptionsFor(page);
  const completionDropdown = sortOptions.children.find(
    (child) => child.children?.[0]?.textContent === "完成条目数",
  );
  completionDropdown.children[0].click();
  await waitForCondition(() => requests.length >= 400, 500);

  assert.equal(requests.length, 400);
  assert.deepEqual(confirmations, []);
});

test("完成条目数菜单悬停时打开、移开时关闭", () => {
  const page = friendPageWith([]);
  const controls = sorter.createSortBar(page.document, () => {});
  const dropdown = dropdownForBar(controls, "完成条目数");
  const toggle = dropdown.children[0];

  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  dropdown.dispatchEvent({ type: "pointerenter", pointerType: "mouse" });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(dropdown.dataset.open, "true");

  dropdown.dispatchEvent({ type: "pointerleave", pointerType: "mouse" });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("完成条目数菜单的键盘焦点不因鼠标移出而关闭", () => {
  const selected = [];
  const page = friendPageWith([]);
  const controls = sorter.createSortBar(
    page.document,
    (criterion, scope) => selected.push([criterion, scope]),
  );
  const dropdown = dropdownForBar(controls, "完成条目数");
  const toggle = dropdown.children[0];
  const menu = dropdown.children[1];
  const bookButton = menu.children[2];
  const musicButton = menu.children[3];

  toggle.focus();
  assert.equal(page.document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  dropdown.dispatchEvent({ type: "pointerleave", pointerType: "mouse" });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  bookButton.focus();
  const keyboardEvent = { type: "keydown", key: "Enter" };
  bookButton.dispatchEvent(keyboardEvent);
  assert.equal(keyboardEvent.defaultPrevented, true);
  assert.deepEqual(selected, [["completion", "1"]]);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

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
});

function assertPointerKeepsCompletionMenuOpen(pointerType) {
  const selected = [];
  const page = friendPageWith([]);
  const controls = sorter.createSortBar(
    page.document,
    (criterion, scope) => selected.push([criterion, scope]),
  );
  const dropdown = dropdownForBar(controls, "完成条目数");
  const toggle = dropdown.children[0];

  dropdown.dispatchEvent({ type: "pointerdown", pointerType });
  toggle.click();
  assert.deepEqual(selected, [["completion", "all"]]);
  assert.equal(page.document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  dropdown.dispatchEvent({ type: "pointerleave", pointerType });
  assert.equal(page.document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  return { dropdown, selected, toggle };
}

test("完成条目数菜单支持触屏点击后保留菜单", () => {
  const { dropdown, selected, toggle } =
    assertPointerKeepsCompletionMenuOpen("touch");
  const menu = dropdown.children[1];
  const musicButton = menu.children[3];

  musicButton.focus();
  musicButton.click();
  assert.deepEqual(selected, [
    ["completion", "all"],
    ["completion", "3"],
  ]);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
});

test("完成条目数菜单支持触控笔点击后保留菜单", () => {
  assertPointerKeepsCompletionMenuOpen("pen");
});

test("完成条目数菜单在鼠标点击后移开指针时释放焦点并收起", () => {
  const selected = [];
  const page = friendPageWith([]);
  const controls = sorter.createSortBar(
    page.document,
    (criterion, scope) => selected.push([criterion, scope]),
  );
  const dropdown = dropdownForBar(controls, "完成条目数");
  const toggle = dropdown.children[0];

  dropdown.dispatchEvent({ type: "pointerenter", pointerType: "mouse" });
  dropdown.dispatchEvent({ type: "pointerdown", pointerType: "mouse" });
  toggle.click();
  assert.deepEqual(selected, [["completion", "all"]]);
  assert.equal(page.document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  dropdown.dispatchEvent({ type: "pointerleave", pointerType: "mouse" });
  assert.equal(page.document.activeElement, null);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
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

// Mirrors browser CSS error recovery closely enough to catch the class of bug
// where a stray token (e.g. a `//` line comment, which CSS does not support)
// gets absorbed into the next rule's selector and silently drops that rule.
function topLevelCssRules(css) {
  const rules = [];
  let prelude = "";
  let block = null;
  let depth = 0;
  let inComment = false;
  let quote = null;

  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    const next = css[i + 1];
    if (inComment) {
      if (char === "*" && next === "/") {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      (block ??= prelude, block += char);
      continue;
    }
    if (char === "/" && next === "*") {
      inComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      throw new Error(
        `CSS does not support // comments (offset ${i}); the browser absorbs them into the next selector and drops the rule`,
      );
    }
    if (char === '"' || char === "'") quote = char;
    if (block === null) {
      if (char === "{") {
        block = "";
        depth = 1;
      } else {
        prelude += char;
      }
    } else if (char === "{") {
      depth += 1;
      block += char;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        rules.push({ block, prelude });
        block = null;
        prelude = "";
      } else {
        block += char;
      }
    } else {
      block += char;
    }
  }
  return rules;
}

function normalizeCssSelector(selector) {
  return selector.replace(/\s+/g, " ").trim();
}

test("注入样式支持固定标签与相邻按钮之间的空隙", () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
  sorter.initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
  });

  const style = page.document.head.children.find(
    (child) => child?.tagName === "style",
  );
  assert.ok(style, "样式元素应已注入");
  const rules = topLevelCssRules(style.textContent);

  const expected = [
    ["#bangumi-friend-sorter .bangumi-friend-sorter-prefix", "margin-right: .25em;"],
    ["#bangumi-friend-sorter .bangumi-friend-sorter-suffix", "margin-left: .25em;"],
  ];
  for (const [selector, declaration] of expected) {
    const rule = rules.find(
      ({ prelude }) => normalizeCssSelector(prelude) === selector,
    );
    assert.ok(
      rule,
      `${selector} 规则应作为独立规则存活（而不是被上一行非法注释吞掉）`,
    );
    assert.ok(rule.block.includes(declaration), `${selector} 应声明 ${declaration}`);
  }
});
