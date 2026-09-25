import test from "node:test";
import assert from "node:assert/strict";
import { createFriendCache } from "../src/cache.mjs";
import { initialize } from "../src/entry.mjs";
import { friendPageWith } from "./support/dom.mjs";
import {
  mountedSortBar,
  statusFor,
  mainSortControl,
  directionButtonsFor,
  dropdownButtonFor,
  menuItemFor,
} from "./support/sort-bar.mjs";
import {
  friendCacheStorage,
  storedCompletion,
  completionSnapshotFor,
} from "./support/cache.mjs";
import {
  refreshResponseFor,
  initializeRefreshPage,
} from "./support/session.mjs";
import { waitForCondition, fakeTimers } from "./support/timing.mjs";
import { timelineDocumentFromFixture } from "./support/timeline.mjs";
import {
  profileStatsDocument,
  relationProfileDocument,
  profileDocumentWithRelation,
} from "./support/profile.mjs";

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
  initialize({
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
  assert.equal(started.filter((url) => url.endsWith("/timeline")).length, 4);
  dropdownButtonFor(page, "完成条目数").click();
  assert.equal(started.filter((url) => !url.endsWith("/timeline")).length, 0);

  release("/user/a/timeline");
  await waitForCondition(
    () => started.filter((url) => !url.endsWith("/timeline")).length === 1,
  );
  mainSortControl(page, "上次活跃").click();
  release("/user/b/timeline");
  await waitForCondition(() => started.includes("/user/e/timeline"));
  dropdownButtonFor(page, "完成条目数").click();
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

  initialize({
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
  dropdownButtonFor(page, "完成条目数").click();
  assert.equal(started.length, 4);

  pending.get(started[0])({ ok: false, status: 429 });
  await waitForCondition(
    () => statusFor(page).textContent === "请求受限，已停止全部获取",
  );

  assert.equal(started.length, 4);
  assert.equal(statusFor(page).textContent, "请求受限，已停止全部获取");
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

  initialize({
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
  await waitForCondition(() => status.textContent === "“上次活跃”获取完成");

  dropdownButtonFor(page, "完成条目数").click();
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

  initialize({
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
  initialize({
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
  dropdownButtonFor(page, "完成条目数").click();
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

  assert.equal(statusFor(page).textContent, "“完成条目数”获取完成，5 人失败");
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

test("未登录时选择喜好契合不请求且登录提示不会因重复选择续时并允许切换子项", () => {
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  let requests = 0;
  const clock = fakeTimers();
  initialize({
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

  const relationButton = dropdownButtonFor(page, "喜好契合");
  const status = statusFor(page);

  relationButton.click();
  assert.equal(requests, 0);
  assert.equal(status.textContent, "请登录后使用喜好契合排序");
  assert.equal(relationButton.getAttribute("aria-current"), "true");
  assert.equal(
    menuItemFor(page, "喜好契合", "同步率").getAttribute("aria-current"),
    "true",
  );
  assert.deepEqual(
    [...clock.timers.values()].map(({ due }) => due),
    [5_000],
  );
  dropdownButtonFor(page, "完成条目数").click();
  assert.equal(status.textContent, "请登录后使用喜好契合排序");
  menuItemFor(page, "喜好契合", "共同喜好数").click();
  assert.equal(requests, 0);
  assert.equal(status.textContent, "请登录后使用喜好契合排序");
  assert.equal(relationButton.getAttribute("aria-current"), "true");
  assert.equal(
    menuItemFor(page, "喜好契合", "同步率").getAttribute("aria-current"),
    null,
  );
  assert.equal(
    menuItemFor(page, "喜好契合", "共同喜好数").getAttribute("aria-current"),
    "true",
  );
  assert.deepEqual(
    [...clock.timers.values()].map(({ due }) => due),
    [5_000],
  );
  menuItemFor(page, "喜好契合", "共同喜好数").click();
  assert.deepEqual(
    [...clock.timers.values()].map(({ due }) => due),
    [5_000],
  );
});

test("选择喜好契合会清除已激活的上次活跃全量刷新提示", () => {
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
  });

  const status = statusFor(page);

  mainSortControl(page, "上次活跃").click();
  mainSortControl(page, "上次活跃").click();
  assert.equal(status.textContent, "5 秒内再次点击“上次活跃”以全量刷新");
  dropdownButtonFor(page, "喜好契合").click();
  assert.equal(status.textContent, "");
});

test("登录提示不会被完成任务完成状态覆盖", async () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
  const clock = fakeTimers();
  let releaseProfile;
  const pendingProfile = new Promise((resolve) => {
    releaseProfile = resolve;
  });
  initialize({
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

  const status = statusFor(page);

  dropdownButtonFor(page, "完成条目数").click();
  dropdownButtonFor(page, "喜好契合").click();
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

  initialize({
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

  const status = statusFor(page);

  mainSortControl(page, "上次活跃").click();
  dropdownButtonFor(page, "完成条目数").click();
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
      // Serve the latest persisted state so the test can reload the cache
      // through the domain interface instead of reading raw write payloads.
      if (writes.length) return JSON.stringify(writes.at(-1)[1]);
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

  initialize({
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
              counts: { all: 1, 2: 1, 3: 1, 4: 1, 6: 1 },
            })
          : profileDocumentWithRelation({
              syncRate: "70%",
              commonLikes: 20,
              counts: { all: 2, 2: 2, 3: 2, 4: 2, 6: 2 },
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

  const relationButton = dropdownButtonFor(page, "喜好契合");
  const status = statusFor(page);

  relationButton.click();
  assert.deepEqual(requests, ["a"]);
  menuItemFor(page, "喜好契合", "共同喜好数").click();
  releaseA({ ok: true, text: async () => "a" });

  await waitForCondition(() => requests.length >= 2);
  await waitForCondition(() => writes.length >= 1);

  assert.deepEqual(requests, ["a", "b"]);
  assert.ok(
    progress.some(([completed, total]) => completed === 0 && total === 2),
  );
  assert.ok(
    progress.some(([completed, total]) => completed === 2 && total === 2),
  );
  assert.equal(status.textContent, "“喜好契合”获取完成，1 人失败");
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["B", "A"],
  );

  // 完成批次后重建缓存，通过领域读取接口验证最终缓存结果，不读取原始
  // 写入 payload 或 raw cache field。
  const reloaded = createFriendCache(storage, { now: () => now });
  assert.deepEqual(
    reloaded.relationFor("a", {
      metric: "syncRate",
      visitorIdentifier: "visitor",
    }),
    { value: 50, fetchedAt: now },
  );
  assert.deepEqual(
    reloaded.relationFor("a", {
      metric: "commonLikes",
      visitorIdentifier: "visitor",
    }),
    { value: 1, fetchedAt: now },
  );
  assert.deepEqual(
    reloaded.relationFor("b", {
      metric: "commonLikes",
      visitorIdentifier: "visitor",
    }),
    { value: 20, fetchedAt: now },
  );
  assert.deepEqual(reloaded.completionFor("a", "all"), {
    value: 1,
    fetchedAt: now,
  });
  assert.deepEqual(reloaded.completionFor("b", "all"), {
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

  initialize({
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
            2: 1,
            3: 1,
            4: 1,
            6: 1,
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

  dropdownButtonFor(page, "喜好契合").click();
  assert.deepEqual(requests, ["a"]);
  dropdownButtonFor(page, "完成条目数").click();
  assert.deepEqual(requests, ["a", "b"]);
  releaseA({ ok: true, text: async () => "a" });

  await waitForCondition(() => requests.length >= 2);
  await waitForCondition(() => page.list.children[0].textContent === "B");

  assert.deepEqual(requests, ["a", "b"]);
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["B", "A"],
  );
});

test("切换字段但未新增好友时立即更新进行中提示的主按钮名称", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const now = 100_000;
  const cachedRecords = {
    a: storedCompletion(1, now),
    b: {
      ...storedCompletion(2, now),
      relation: { visitor: { syncRate: { value: 10, fetchedAt: now } } },
    },
  };
  let releaseA;
  const pendingA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const requests = [];

  initialize({
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
      return url.endsWith("/a")
        ? pendingA
        : Promise.resolve({
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

test("获取中重复选择同一远程目标被忽略且不打断进行中任务", async () => {
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

  initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: friendCacheStorage({
      b: { relation: { visitor: { syncRate: { value: 10, fetchedAt: now } } } },
    }),
    now: () => now,
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: (url) => {
      requests.push(url);
      return url.endsWith("/a")
        ? pendingA
        : Promise.resolve({ ok: true, text: async () => "b" });
    },
  });

  const relationButton = dropdownButtonFor(page, "喜好契合");
  const status = statusFor(page);

  relationButton.click();
  assert.deepEqual(requests, ["/user/a"]);
  assert.equal(status.textContent, "正在获取“喜好契合” 0/1");

  // 获取中再次选择同一目标：忽略，不新增请求也不清掉进行中提示。
  relationButton.click();
  assert.deepEqual(requests, ["/user/a"]);
  assert.equal(status.textContent, "正在获取“喜好契合” 0/1");

  releaseA({ ok: true, text: async () => "a" });
  await waitForCondition(() =>
    status.textContent.includes("“喜好契合”获取完成"),
  );
  assert.deepEqual(requests, ["/user/a"]);
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["A", "B"],
  );
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
  const status = statusFor(page);

  relationButton.click();
  assert.deepEqual(requests, ["/user/friend-0"]);
  menuItemFor(page, "喜好契合", "共同喜好数").click();
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
    entries
      .slice(5)
      .map(({ href }) => [
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
  assert.equal(started.filter((url) => url.endsWith("/timeline")).length, 4);
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
  const status = statusFor(page);

  relationButton.click();
  assert.deepEqual(started, ["/user/friend-0", "/user/friend-1"]);
  activityButton.click();
  assert.equal(status.textContent, "正在获取“上次活跃” 0/1");

  menuItemFor(page, "喜好契合", "共同喜好数").click();
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
  initialize({
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

  initialize({
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
      // Serve the latest persisted state so the final cache can be verified
      // through a reloaded cache's domain reads instead of raw payloads.
      if (writes.length) return JSON.stringify(writes.at(-1)[1]);
      return JSON.stringify({
        version: 3,
        records: {
          b: storedCompletion(5, now),
        },
      });
    },
    setItem(key, value) {
      writes.push([key, JSON.parse(value)]);
    },
    removeItem() {},
  };

  initialize({
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
              ? { all: 1, 1: 10, 2: 1, 3: 1, 4: 1, 6: 1 }
              : { all: 2, 1: 20, 2: 2, 3: 2, 4: 2, 6: 2 },
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

  dropdownButtonFor(page, "完成条目数").click();
  assert.deepEqual(requests, ["a"]);
  menuItemFor(page, "完成条目数", "书籍").click();
  releaseA(responseFor("a"));

  await waitForCondition(() => requests.length >= 2);
  await waitForCondition(() => writes.length > 0);
  // b 的结果在任务结束的批次完成时落盘；轮询领域读取直到最终值可见。
  await waitForCondition(() => {
    const probe = createFriendCache(storage, { now: () => now });
    return probe.completionFor("b", "1")?.value === 20;
  });

  assert.deepEqual(requests, ["a", "b"]);
  const reloaded = createFriendCache(storage, { now: () => now });
  assert.deepEqual(completionSnapshotFor(reloaded, "b"), {
    all: { value: 2, fetchedAt: now },
    1: { value: 20, fetchedAt: now },
    2: { value: 2, fetchedAt: now },
    3: { value: 2, fetchedAt: now },
    4: { value: 2, fetchedAt: now },
    6: { value: 2, fetchedAt: now },
  });
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["B", "A"],
  );
});

test("完成条目数两击全量刷新使用实际范围名称并忽略有效缓存", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const now = 100_000;
  const requests = [];
  initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage: {
      getItem(key) {
        if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
        return JSON.stringify({
          version: 3,
          records: {
            a: storedCompletion(1, now),
            b: storedCompletion(2, now),
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
            ? { all: 10, 1: 10, 2: 10, 3: 10, 4: 10, 6: 10 }
            : { all: 1, 1: 1, 2: 1, 3: 1, 4: 1, 6: 1 },
        }),
    },
    fetchImpl: (url) => {
      requests.push(url);
      return Promise.resolve({ ok: true, text: async () => url });
    },
  });

  const status = statusFor(page);

  const completionButton = dropdownButtonFor(page, "完成条目数");
  completionButton.click();
  assert.deepEqual(requests, []);
  assert.deepEqual(
    page.list.children.map(({ textContent }) => textContent),
    ["B", "A"],
  );
  completionButton.click();
  assert.equal(status.textContent, "5 秒内再次点击“全部”以全量刷新");
  completionButton.click();
  await waitForCondition(() => status.textContent.includes("获取完成"));
  assert.deepEqual(requests, ["/user/a", "/user/b"]);
  assert.equal(status.textContent, "“完成条目数”获取完成");
  assert.deepEqual(
    page.list.children.map(({ textContent }) => textContent),
    ["A", "B"],
  );
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
  initialize({
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

  dropdownButtonFor(page, "完成条目数").click();
  await waitForCondition(() => requests.length >= 400, 500);

  assert.equal(requests.length, 400);
  assert.deepEqual(confirmations, []);
});
