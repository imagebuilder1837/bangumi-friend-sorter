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
import {
  persistentFriendCacheStorage,
  openPersistentCache,
  storedCompletion,
  completionSnapshotFor,
} from "../support/cache.mjs";
import {
  refreshResponseFor,
  initializeRefreshPage,
} from "../support/refresh-page.mjs";
import { waitForCondition } from "../support/timing.mjs";
import { documentFromFixture } from "../support/html.mjs";
import {
  profileStatsDocument,
  relationProfileDocument,
  profileDocumentWithRelation,
} from "../support/profile.mjs";
test("主页同步率与共同喜好数切换复用任务、去重请求并按最后字段统计失败", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const now = 100_000;
  const requests = [];
  const progress = [];
  let releaseA;
  const pendingA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const storage = persistentFriendCacheStorage(
    JSON.stringify({
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
    }),
  );

  await initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage,
    indexedDB: storage.indexedDB,
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
  await waitForCondition(() =>
    statusFor(page).textContent.includes("获取完成"),
  );

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
  const reloaded = await openPersistentCache(storage, { now: () => now });
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

  await initialize({
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

  const page = await initializeRefreshPage({
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

test("完成统计范围在刷新期间切换后补取新增缺失好友", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const now = 100_000;
  const requests = [];
  let releaseA;
  const responseFor = (userIdentifier) => ({
    ok: true,
    text: async () => userIdentifier,
  });
  const responseA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const storage = persistentFriendCacheStorage(
    JSON.stringify({
      version: 3,
      records: {
        b: storedCompletion(5, now),
      },
    }),
  );

  await initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage,
    indexedDB: storage.indexedDB,
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
  await waitForCondition(() =>
    statusFor(page).textContent.includes("获取完成"),
  );

  assert.deepEqual(requests, ["a", "b"]);
  const reloaded = await openPersistentCache(storage, { now: () => now });
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

test("页面增量刷新恰好新增四百个请求时不确认", async () => {
  const page = friendPageWith(
    Array.from({ length: 400 }, (_, index) => ({
      href: `/user/friend-${index}`,
      name: `好友${index}`,
    })),
  );
  const requests = [];
  const confirmations = [];
  await initialize({
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
