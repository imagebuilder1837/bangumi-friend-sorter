import test from "node:test";
import assert from "node:assert/strict";
import {
  persistentFriendCacheStorage,
  openPersistentCache,
  friendCacheStorage,
} from "../support/cache.mjs";
import { waitForCondition } from "../support/timing.mjs";
import { initialize } from "../../src/page/initialize.mjs";
import { friendPageWith } from "../support/dom.mjs";
import {
  mainSortControl,
  dropdownButtonFor,
  statusFor,
  mountedSortBar,
  rankFor,
  directionButtonsFor,
  dropdownItems,
  fakeMutationObserverClass,
} from "../support/sort-bar.mjs";
import { documentFromFixture } from "../support/html.mjs";
import {
  profileStatsDocument,
  relationProfileDocument,
} from "../support/profile.mjs";
import { topLevelCssRules, normalizeCssSelector } from "../support/css.mjs";
test("页面初始化可以注入获取任务所需的运行时依赖", async () => {
  const page = friendPageWith([{ href: "/user/sai", name: "Sai" }]);
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36);
  let requests = 0;
  const progress = [];
  const storage = persistentFriendCacheStorage();
  await initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage,
    indexedDB: storage.indexedDB,
    domParser: {
      parseFromString: () =>
        documentFromFixture("timeline-active-seconds.html"),
    },
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        headers: { get: () => new Date(responseTime).toUTCString() },
        text: async () => "fixture",
      };
    },
    now: () => responseTime,
    onProgress: (completed, total) => progress.push([completed, total]),
  });
  mainSortControl(page, "上次活跃").click();
  await waitForCondition(() =>
    statusFor(page).textContent.includes("获取完成"),
  );
  const reopened = await openPersistentCache(storage);
  assert.equal(requests, 1);
  assert.deepEqual(progress, [
    [0, 1],
    [1, 1],
  ]);
  assert.deepEqual(reopened.activityFor("sai"), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
    fetchedAt: responseTime,
  });
});

test("三个支持站点都使用各自浏览器存储和同源请求刷新两类页面", async () => {
  for (const host of ["bgm.tv", "bangumi.tv", "chii.in"]) {
    const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
    const requests = [];
    const storage = persistentFriendCacheStorage();
    await initialize({
      document: page.document,
      window: {
        location: { href: `https://${host}/user/viewed/friends` },
        localStorage: storage,
        indexedDB: storage.indexedDB,
      },
      setTimeout: () => 1,
      clearTimeout() {},
      domParser: {
        parseFromString: (html) =>
          html === "timeline"
            ? documentFromFixture("timeline-active-seconds.html")
            : profileStatsDocument(),
      },
      fetchImpl: async (url, options) => {
        requests.push([url, options]);
        return {
          ok: true,
          headers: { get: () => null },
          text: async () =>
            url.endsWith("/timeline") ? "timeline" : "profile",
        };
      },
    });
    mainSortControl(page, "上次活跃").click();
    dropdownButtonFor(page, "完成条目数").click();
    await waitForCondition(
      () =>
        requests.length === 2 &&
        statusFor(page).textContent.includes("获取完成"),
    );
    const reopened = await openPersistentCache(storage);
    assert.equal(requests[0][0], "/user/friend/timeline", host);
    assert.equal(requests[0][1].credentials, "same-origin", host);
    assert.equal(requests[1][0], "/user/friend", host);
    assert.equal(requests[1][1].credentials, "same-origin", host);
    assert.equal(reopened.activityFor("friend")?.kind, "active", host);
    assert.equal(reopened.completionFor("friend", "all")?.value, 20, host);
  }
});

test("页面初始化完全忽略 v2 缓存，全部好友仍需增量获取", async () => {
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

  await initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage,
    domParser: {
      parseFromString: () =>
        documentFromFixture("timeline-active-seconds.html"),
    },
    fetchImpl: async () => {
      requests += 1;
      return { ok: false, status: 404 };
    },
    now: () => now,
  });

  mainSortControl(page, "上次活跃").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests, 3);
});

test("初始化按当前访问者隔离喜好契合缓存", async () => {
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
  await initialize({
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
  dropdownButtonFor(pageA, "喜好契合").click();
  assert.equal(requestsA, 0);

  const pageB = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  let requestsB = 0;
  await initialize({
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
  dropdownButtonFor(pageB, "喜好契合").click();
  assert.equal(requestsB, 1);
});

test("纯空白展示名称不会阻止排序栏初始化", async () => {
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
    await initialize();
  } finally {
    global.document = previousDocument;
    global.window = previousWindow;
  }

  assert.equal(page.list.beforeNodes.length, 1);
  assert.equal(page.list.beforeNodes[0].dataset.friendSorter, "");
});

test("初始化后每个好友项显示网页默认顺序名次", async () => {
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
    await initialize();
  } finally {
    global.document = previousDocument;
    global.window = previousWindow;
  }

  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2", "#3"]);
});

test("页面初始化提供六个主排序目标、全部子项和各自主按钮方向", async () => {
  const failedRequest = async () => ({ kind: "http-error", status: 404 });
  const page = friendPageWith([
    { href: "/user/z", name: "Zed" },
    { href: "/user/a", name: "Ada" },
  ]);

  await initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/sai/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    http: {
      fetchActivity: failedRequest,
      fetchProfile: failedRequest,
      fetchTietiePage: failedRequest,
    },
    setTimeout: () => 1,
    clearTimeout() {},
  });

  const directionButtons = directionButtonsFor(page);
  const directButtons = ["加好友时间", "名称", "上次活跃", "和我贴贴"].map(
    (label) => mainSortControl(page, label),
  );
  const relationToggle = dropdownButtonFor(page, "喜好契合");
  const completionToggle = dropdownButtonFor(page, "完成条目数");

  assert.deepEqual(
    [
      ...directButtons.map(({ textContent }) => textContent),
      relationToggle.textContent,
      completionToggle.textContent,
    ],
    ["加好友时间", "名称", "上次活跃", "和我贴贴", "喜好契合", "完成条目数"],
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
  assert.deepEqual(
    directionButtons.map(({ textContent }) => textContent),
    ["从旧到新", "从新到旧"],
  );

  for (const button of [
    directButtons[1],
    directButtons[2],
    directButtons[3],
    relationToggle,
    completionToggle,
  ]) {
    button.click();
    assert.deepEqual(
      directionButtons.map(({ textContent }) => textContent),
      [
        ...(button.textContent === "上次活跃"
          ? ["从旧到新", "从新到旧"]
          : button.textContent === "名称"
            ? ["升序", "降序"]
            : ["从低到高", "从高到低"]),
      ],
    );
    directionButtons[0].click();
    directButtons[0].click();
    button.click();
    assert.equal(directionButtons[0].getAttribute("aria-current"), "true");
    directionButtons[1].click();
    assert.equal(directionButtons[1].getAttribute("aria-current"), "true");
  }
});

test("页面初始化把可见性观察器接到好友列表上", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const { instances, FakeMutationObserver } = fakeMutationObserverClass();
  await initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: friendCacheStorage({}),
    now: () => 1_000,
    setTimeout: () => 1,
    clearTimeout() {},
    mutationObserver: FakeMutationObserver,
  });
  // 子树观察器接列表；祖先观察器在测试替身 DOM 无祖先时无目标，
  // 目标拓扑由专门测试断言。
  assert.equal(instances.length, 2);
  assert.equal(instances[0].observedTarget, page.list);
  assert.deepEqual(instances[1].observations, []);
});

test("非空好友列表缺少挂载布局时明确报错，保留列表且不注入样式", async () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
  const original = [...page.list.children];
  const errors = [];
  page.list.closest = () => null;

  await assert.rejects(
    initialize({
      document: page.document,
      window: {
        location: { href: "https://bgm.tv/user/sai/friends" },
        console: { error: (...args) => errors.push(args) },
      },
      storage: { getItem: () => null, setItem() {}, removeItem() {} },
    }),
    /排序栏挂载/,
  );

  assert.deepEqual(page.list.children, original);
  assert.equal(page.list.beforeNodes[0].getAttribute("role"), "alert");
  assert.match(page.list.beforeNodes[0].textContent, /排序栏挂载/);
  assert.equal(errors.length, 1);
  assert.equal(page.document.head.children.length, 0);
});

test("注入样式支持固定标签与相邻按钮之间的空隙", async () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
  await initialize({
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
    [
      "#bangumi-friend-sorter .bangumi-friend-sorter-prefix",
      "margin-right: .25em;",
    ],
    [
      "#bangumi-friend-sorter .bangumi-friend-sorter-suffix",
      "margin-left: .25em;",
    ],
  ];
  for (const [selector, declaration] of expected) {
    const rule = rules.find(
      ({ prelude }) => normalizeCssSelector(prelude) === selector,
    );
    assert.ok(
      rule,
      `${selector} 规则应作为独立规则存活（而不是被上一行非法注释吞掉）`,
    );
    assert.ok(
      rule.block.includes(declaration),
      `${selector} 应声明 ${declaration}`,
    );
  }
});

test("页面按用户标识去重后主页任务只请求保留的好友", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A1" },
    { href: "/user/a", name: "A2" },
  ]);
  const requests = [];
  await initialize({
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

  dropdownButtonFor(page, "喜好契合").click();
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
      // 与 list.before 一样登记到 beforeNodes，让既有契约助手能定位排序栏。
      page.list.beforeNodes.push(node);
    },
  };
  page.list.closest = (selector) =>
    selector === ".mainWrapper" ? wrapper : null;

  await initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    domParser: {
      parseFromString: (html) =>
        profileStatsDocument({
          counts: html.includes("/user/a")
            ? { all: 2, 2: 2, 1: 2, 3: 2, 4: 2, 6: 2 }
            : { all: 20, 2: 20, 1: 20, 3: 20, 4: 20, 6: 20 },
        }),
    },
    fetchImpl: async (url) => ({
      ok: true,
      text: async () => url,
    }),
  });

  dropdownButtonFor(page, "完成条目数").click();
  await new Promise((resolve) => setImmediate(resolve));
  const directionButtons = directionButtonsFor(page);

  assert.equal(mountedSortBar(page).dataset.friendSorter, "");
  // 排序栏挂在主内容列之前，不依赖内部节点序号。
  assert.equal(
    wrapper.children.indexOf(mountedSortBar(page)) <
      wrapper.children.indexOf(columns),
    true,
  );
  assert.deepEqual(
    directionButtons.map(({ textContent }) => textContent),
    ["从低到高", "从高到低"],
  );
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["B", "A"],
  );

  directionButtons[0].click();
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["A", "B"],
  );
  directionButtons[1].click();
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["B", "A"],
  );
});
