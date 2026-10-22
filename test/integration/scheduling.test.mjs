import test from "node:test";
import assert from "node:assert/strict";
import { initialize } from "../../src/page/initialize.mjs";
import { friendPageWith } from "../support/dom.mjs";
import {
  mainSortControl,
  dropdownButtonFor,
  statusFor,
} from "../support/sort-bar.mjs";
import { storedCompletion } from "../support/cache.mjs";
import { waitForCondition } from "../support/timing.mjs";
import { documentFromFixture } from "../support/html.mjs";
import { profileStatsDocument } from "../support/profile.mjs";
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
      storedCompletion(1, now),
    ]),
  );

  await initialize({
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
          ? documentFromFixture("timeline-active-seconds.html")
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
  await initialize({
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
          ? documentFromFixture("timeline-active-seconds.html")
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

  await initialize({
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
          ? documentFromFixture("timeline-active-seconds.html")
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
  await initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/viewed/friends" } },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    domParser: {
      parseFromString: (html) =>
        html === "timeline"
          ? documentFromFixture("timeline-active-seconds.html")
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
