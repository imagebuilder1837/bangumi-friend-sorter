import test from "node:test";
import assert from "node:assert/strict";
import { initialize } from "../../src/page/initialize.mjs";
import { friendPageWith } from "../support/dom.mjs";
import {
  statusFor,
  mainSortControl,
  dropdownButtonFor,
  menuItemFor,
} from "../support/sort-bar.mjs";
import { friendCacheStorage, storedCompletion } from "../support/cache.mjs";
import {
  refreshResponseFor,
  initializeRefreshPage,
} from "../support/refresh-page.mjs";
import { waitForCondition, fakeTimers } from "../support/timing.mjs";
import { documentFromFixture } from "../support/html.mjs";
import {
  profileStatsDocument,
  relationProfileDocument,
} from "../support/profile.mjs";
test("同一页面任务收到 429 时立即显示全局限流提示", async () => {
  const page = friendPageWith(
    ["a", "b", "c", "d", "e"].map((userIdentifier) => ({
      href: `/user/${userIdentifier}`,
      name: userIdentifier.toUpperCase(),
    })),
  );
  const pending = new Map();
  const started = [];

  await initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/viewed/friends" } },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    domParser: {
      parseFromString: () =>
        documentFromFixture("timeline-active-seconds.html"),
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
  const page = await initializeRefreshPage({
    entries: ["a", "b", "c", "d", "e"].map((userIdentifier) => ({
      href: `/user/${userIdentifier}`,
      name: userIdentifier.toUpperCase(),
    })),
    now: 100_000,
    records: {},
    domParser: {
      parseFromString: (html) =>
        html === "timeline"
          ? documentFromFixture("timeline-active-seconds.html")
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

test("未登录时选择喜好契合不请求且登录提示不会因重复选择续时并允许切换子项", async () => {
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  let requests = 0;
  const clock = fakeTimers();
  await initialize({
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
  assert.equal(requests, 1, "完成条目数不依赖登录或预先具备解析能力");
  assert.equal(status.textContent, "请登录后使用喜好契合排序");
  menuItemFor(page, "喜好契合", "共同喜好数").click();
  assert.equal(requests, 1, "切回契合指标没有新增请求");
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

test("登录提示不会被完成任务完成状态覆盖", async () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
  const clock = fakeTimers();
  let releaseProfile;
  const pendingProfile = new Promise((resolve) => {
    releaseProfile = resolve;
  });
  await initialize({
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

  await initialize({
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
          ? documentFromFixture("timeline-active-seconds.html")
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

  await initialize({
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

  const page = await initializeRefreshPage({
    entries,
    now,
    records: cachedRecords,
    domParser: {
      parseFromString: (html) =>
        html === "timeline"
          ? documentFromFixture("timeline-active-seconds.html")
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
