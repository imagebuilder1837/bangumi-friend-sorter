import test from "node:test";
import assert from "node:assert/strict";
import { createFriendCache } from "../src/cache.mjs";
import { fetchProfile } from "../src/http.mjs";
import { initialize } from "../src/entry.mjs";
import { friendPageWith } from "./support/dom.mjs";
import {
  statusFor,
  mainSortControl,
  dropdownButtonFor,
} from "./support/sort-bar.mjs";
import {
  friendCacheStorage,
  storedCompletion,
  refreshCache,
  completionSnapshotFor,
} from "./support/cache.mjs";
import {
  refreshResponseFor,
  initializeRefreshPage,
  createSessionHarness,
} from "./support/session.mjs";
import { waitForCondition } from "./support/timing.mjs";
import { timelineDocumentFromFixture } from "./support/timeline.mjs";
import {
  relationProfileDocument,
  duplicateCategoryProfileDocument,
} from "./support/profile.mjs";

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
  const activities = createFriendCache(null, { now: () => now });
  refreshCache(activities, [
    [
      "fresh-active",
      {
        activity: {
          kind: "active",
          activityAtSeconds: 10,
          fetchedAt: now - hour,
        },
      },
    ],
    ["fresh-empty", { activity: { kind: "empty", fetchedAt: now - hour } }],
    [
      "boundary",
      {
        activity: {
          kind: "active",
          activityAtSeconds: 20,
          fetchedAt: now - 24 * hour,
        },
      },
    ],
    [
      "stale",
      {
        activity: {
          kind: "active",
          activityAtSeconds: 30,
          fetchedAt: now - 24 * hour - 1,
        },
      },
    ],
  ]);

  assert.deepEqual(
    activities
      .friendsNeedingRefresh(friends, { kind: "activity" })
      .map(({ userIdentifier }) => userIdentifier),
    ["stale", "missing"],
  );
});

test("请求响应头的时间按整秒传给活跃时刻解析并写入整数 Unix 秒缓存", async () => {
  const document = timelineDocumentFromFixture("timeline-active-seconds.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36);
  const writes = [];
  const page = friendPageWith([{ href: "/user/sai", name: "Sai" }]);
  initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/sai/friends" },
    },
    storage: {
      getItem: () => null,
      setItem(key, value) {
        writes.push([key, JSON.parse(value)]);
      },
      removeItem() {},
    },
    now: () => responseTime,
    setTimeout: () => 1,
    clearTimeout() {},
    domParser: { parseFromString: () => document },
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get: (name) =>
          name === "date" ? new Date(responseTime).toUTCString() : null,
      },
      text: async () => "fixture",
    }),
  });

  mainSortControl(page, "上次活跃").click();
  await waitForCondition(() => writes.length > 0);

  // 批次完成后重建缓存，通过领域读取验证响应头时间被截断到整秒。
  const reloaded = createFriendCache({
    getItem: () => JSON.stringify(writes.at(-1)[1]),
    setItem() {},
    removeItem() {},
  });
  assert.deepEqual(reloaded.activityFor("sai"), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
    fetchedAt: responseTime,
  });
});

test("时间胶囊返回四零四时计入失败且不覆盖缓存", async () => {
  const progress = [];
  const cache = createFriendCache(null);
  const { finished, lastMessage, session } = createSessionHarness({
    cache,
    friends: [{ userIdentifier: "missing" }],
    runtime: {
      http: {
        fetchActivity: async () => ({ kind: "http-error", status: 404 }),
      },
      now: () => 1_000,
      onProgress: (completed, total) => progress.push([completed, total]),
    },
  });

  session.choose("activity");
  await finished;

  assert.equal(lastMessage(), "“上次活跃”获取完成，1 人失败");
  assert.equal(cache.activityFor("missing"), undefined);
  assert.deepEqual(progress, [
    [0, 1],
    [1, 1],
  ]);
});

test("用户主页返回四零四时计入失败且保留旧缓存", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const oldCompletion = { value: 7, fetchedAt: staleFetchedAt };
  const oldRecord = {
    ...storedCompletion(oldCompletion.value, oldCompletion.fetchedAt),
    relation: {
      visitor: { syncRate: { value: 55, fetchedAt: staleFetchedAt } },
    },
  };
  const cache = createFriendCache(friendCacheStorage({ friend: oldRecord }));
  const progress = [];
  const { finished, lastMessage, session } = createSessionHarness({
    cache,
    friends: [{ userIdentifier: "friend" }],
    runtime: {
      http: {
        fetchProfile: async () => ({ kind: "http-error", status: 404 }),
      },
      now: () => now,
      onProgress: (completed, total) => progress.push([completed, total]),
    },
  });

  session.choose("completion", "all");
  await finished;

  assert.equal(lastMessage(), "“完成条目数”获取完成，1 人失败");
  assert.deepEqual(progress, [
    [0, 1],
    [1, 1],
  ]);
  assert.deepEqual(cache.completionFor("friend", "all"), oldCompletion);
  assert.deepEqual(
    cache.relationFor("friend", {
      metric: "syncRate",
      visitorIdentifier: "visitor",
    }),
    oldRecord.relation.visitor.syncRate,
  );
});

test("无效用户主页计入失败且保留旧缓存", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const oldCompletion = { value: 7, fetchedAt: staleFetchedAt };
  const oldRecord = {
    ...storedCompletion(oldCompletion.value, oldCompletion.fetchedAt),
    relation: {
      visitor: { syncRate: { value: 55, fetchedAt: staleFetchedAt } },
    },
  };
  const cache = createFriendCache(friendCacheStorage({ friend: oldRecord }));
  const { finished, lastMessage, session } = createSessionHarness({
    cache,
    friends: [{ userIdentifier: "friend" }],
    runtime: {
      http: {
        fetchProfile: async () => ({ kind: "parse-error" }),
      },
      now: () => now,
    },
  });

  session.choose("completion", "all");
  await finished;

  assert.equal(lastMessage(), "“完成条目数”获取完成，1 人失败");
  assert.deepEqual(cache.completionFor("friend", "all"), oldCompletion);
  assert.deepEqual(
    cache.relationFor("friend", {
      metric: "syncRate",
      visitorIdentifier: "visitor",
    }),
    oldRecord.relation.visitor.syncRate,
  );
});

test("用户主页请求超过十五秒时计入失败且保留旧缓存", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const oldCompletion = { value: 7, fetchedAt: staleFetchedAt };
  const oldRecord = storedCompletion(
    oldCompletion.value,
    oldCompletion.fetchedAt,
  );
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  const scheduled = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let requestSignal;

  // 15 秒超时由生产 HTTP adapter 实现，经页面初始化整体验证。
  globalThis.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  globalThis.clearTimeout = () => {};

  try {
    initialize({
      document: page.document,
      window: {
        CHOBITS_USERNAME: "visitor",
        location: { href: "https://bgm.tv/user/viewed/friends" },
      },
      storage: friendCacheStorage({ friend: oldRecord }),
      now: () => now,
      setTimeout: () => 0,
      clearTimeout() {},
      domParser: { parseFromString: () => ({ querySelector: () => null }) },
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
    });

    const status = statusFor(page);
    dropdownButtonFor(page, "完成条目数").click();

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 15_000);
    scheduled[0].callback();

    await waitForCondition(() =>
      status.textContent.includes("获取完成，1 人失败"),
    );
    assert.equal(requestSignal.aborted, true);
    const reloaded = createFriendCache(
      friendCacheStorage({ friend: oldRecord }),
      { now: () => now },
    );
    assert.deepEqual(reloaded.completionFor("friend", "all"), oldCompletion);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("时间胶囊刷新任务通过适配器结果、缓存写入和进度回调驱动", async () => {
  const requested = [];
  const progress = [];
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36);
  const cache = createFriendCache(null);
  const { finished, lastMessage, session } = createSessionHarness({
    cache,
    friends: [{ userIdentifier: "sai" }, { userIdentifier: "tom" }],
    runtime: {
      http: {
        fetchActivity: async (friend) => {
          requested.push(friend.userIdentifier);
          return {
            kind: "success",
            record: {
              kind: "active",
              activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
              fetchedAt: responseTime,
            },
          };
        },
      },
      now: () => responseTime,
      onProgress: (completed, total) => progress.push([completed, total]),
    },
  });

  session.choose("activity");
  await finished;

  assert.deepEqual(requested.sort(), ["sai", "tom"]);
  const expectedActivity = {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
    fetchedAt: responseTime,
  };
  assert.deepEqual(cache.activityFor("sai"), expectedActivity);
  assert.deepEqual(cache.activityFor("tom"), expectedActivity);
  assert.deepEqual(
    progress.sort(([left], [right]) => left - right),
    [
      [0, 2],
      [1, 2],
      [2, 2],
    ],
  );
  assert.equal(lastMessage(), "“上次活跃”获取完成");
});

test("主页请求记录按字段携带成功、缺失或无效结果", async () => {
  const outcome = await fetchProfile(
    { userIdentifier: "sai" },
    async () => ({ ok: true, text: async () => "profile" }),
    { parseFromString: () => duplicateCategoryProfileDocument() },
    () => 5_000,
  );

  assert.equal(outcome.kind, "success");
  assert.equal(outcome.record.fetchedAt, 5_000);
  // 重复分类块是结构矛盾：完成统计整体解析失败，契合指标照常携带结果。
  assert.equal(outcome.record.fields.completion, null);
  assert.deepEqual(outcome.record.fields.relation.syncRate, {
    kind: "success",
    value: 12,
  });
  assert.deepEqual(outcome.record.fields.relation.commonLikes, {
    kind: "success",
    value: 5,
  });

  const absentFields = await fetchProfile(
    { userIdentifier: "sai" },
    async () => ({ ok: true, text: async () => "profile" }),
    { parseFromString: () => relationProfileDocument({ syncRate: "50%" }) },
    () => 5_000,
  );
  assert.deepEqual(absentFields.record.fields.relation.syncRate, {
    kind: "success",
    value: 50,
  });
  assert.deepEqual(absentFields.record.fields.relation.commonLikes, {
    kind: "missing",
  });
  assert.equal(absentFields.record.fields.completion, null);
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

  assert.deepEqual(
    page.list.children.map(({ textContent }) => textContent),
    ["高", "低"],
  );
  assert.deepEqual(requests, ["/user/low", "/user/high"]);

  for (const [url, resolve] of [...pending]) {
    pending.delete(url);
    resolve(refreshResponseFor(url));
  }
  await waitForCondition(() =>
    statusFor(page).textContent.includes("获取完成"),
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
  const cache = createFriendCache(storage);

  const { finished, session } = createSessionHarness({
    cache,
    friends: [{ userIdentifier: "sai" }],
    runtime: {
      // 一次响应服务全部字段：书籍范围解析失败，其余范围成功。
      http: {
        fetchProfile: async () => ({
          kind: "success",
          record: {
            fetchedAt: now,
            fields: {
              completion: {
                all: { kind: "success", value: 20 },
                1: { kind: "invalid" },
                2: { kind: "success", value: 8 },
                3: { kind: "success", value: 6 },
                4: { kind: "success", value: 4 },
                6: { kind: "success", value: 2 },
              },
            },
          },
        }),
      },
      now: () => now,
    },
  });

  session.choose("completion", "all");
  await finished;

  assert.deepEqual(completionSnapshotFor(cache, "sai"), {
    all: { value: 20, fetchedAt: now },
    1: oldBook,
    2: { value: 8, fetchedAt: now },
    3: { value: 6, fetchedAt: now },
    4: { value: 4, fetchedAt: now },
    6: { value: 2, fetchedAt: now },
  });
  assert.equal(writes.length, 1);
});

test("某个完成范围解析无效只保留该范围旧缓存，其余范围和契合字段照常写入", async () => {
  const now = 10_000;
  const oldAnimation = { value: 77, fetchedAt: now - 1 };
  const writes = [];
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({
        version: 3,
        records: { sai: { completion_2: oldAnimation } },
      });
    },
    setItem(key, value) {
      writes.push([key, JSON.parse(value)]);
    },
  };
  const cache = createFriendCache(storage);

  const { finished, lastMessage, session } = createSessionHarness({
    cache,
    friends: [{ userIdentifier: "sai" }],
    runtime: {
      // 单个分类块存在但解析失败只使动画范围无效：其余范围与契合字段
      // 照常成功（重复分类块则是结构矛盾，整个完成统计解析失败）。
      http: {
        fetchProfile: async () => ({
          kind: "success",
          record: {
            fetchedAt: now,
            fields: {
              completion: {
                all: { kind: "success", value: 20 },
                1: { kind: "success", value: 3 },
                2: { kind: "invalid" },
                3: { kind: "success", value: 0 },
                4: { kind: "success", value: 0 },
                6: { kind: "success", value: 0 },
              },
              relation: {
                syncRate: { kind: "success", value: 12 },
                commonLikes: { kind: "success", value: 5 },
              },
            },
          },
        }),
      },
      now: () => now,
    },
  });

  session.choose("completion", "all");
  await finished;

  assert.deepEqual(completionSnapshotFor(cache, "sai"), {
    all: { value: 20, fetchedAt: now },
    1: { value: 3, fetchedAt: now },
    2: oldAnimation,
    3: { value: 0, fetchedAt: now },
    4: { value: 0, fetchedAt: now },
    6: { value: 0, fetchedAt: now },
  });
  assert.deepEqual(
    cache.relationFor("sai", {
      metric: "syncRate",
      visitorIdentifier: "visitor",
    }),
    { value: 12, fetchedAt: now },
  );
  assert.deepEqual(
    cache.relationFor("sai", {
      metric: "commonLikes",
      visitorIdentifier: "visitor",
    }),
    { value: 5, fetchedAt: now },
  );
  assert.equal(lastMessage(), "“完成条目数”获取完成");
  assert.equal(writes.length, 1);
});
