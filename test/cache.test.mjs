import test from "node:test";
import assert from "node:assert/strict";
import { createFriendCache } from "../src/cache.mjs";
import {
  friendCacheStorage,
  storedCompletion,
  refreshCache,
} from "./support/index.mjs";

test("持久存储不可用时上次活跃缓存仍在当前页面内工作", () => {
  const unavailableStorage = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    },
  };
  const cache = createFriendCache(unavailableStorage);
  const record = { kind: "active", activityAtSeconds: 1, fetchedAt: 2_000 };

  refreshCache(cache, [["sai", { activity: record }]]);

  assert.equal(cache.activityFor("sai"), record);
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

  const cache = createFriendCache(storage, { now: () => 3_000 });

  assert.deepEqual(cache.activityFor("sai"), record);
  assert.deepEqual(writes, [
    [
      "bangumi-friend-sorter:activity-cache:v3",
      { version: 3, records: { sai: { activity: record } } },
    ],
  ]);
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

  const cache = createFriendCache(storage, { now: () => now });

  assert.deepEqual(cache.activityFor("fresh"), records.fresh);
  assert.deepEqual(cache.activityFor("boundary"), records.boundary);
  assert.equal(cache.activityFor("stale"), undefined);
});

test("v3 缓存不完整时仍合并尚未迁移的 v2 上次活跃记录", () => {
  const activity = {
    kind: "active",
    activityAtSeconds: 1_000,
    fetchedAt: 2_000,
  };
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

  const cache = createFriendCache(storage, { now: () => 3_000 });

  assert.deepEqual(cache.activityFor("sai"), activity);
  assert.deepEqual(writes, [
    [
      "bangumi-friend-sorter:activity-cache:v3",
      { version: 3, records: { sai: { activity } } },
    ],
  ]);
});

test("v3 缓存独立校验每个好友的完成字段", () => {
  const activity = {
    kind: "active",
    activityAtSeconds: 1_000,
    fetchedAt: 2_000,
  };
  const completion = { value: 87, fetchedAt: 3_000 };
  const completionField = "completion_all";
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

  const cache = createFriendCache(storage);

  assert.deepEqual(cache.activityFor("sai"), activity);
  assert.deepEqual(cache.completionFor("sai", "all"), completion);
  assert.deepEqual(cache.activityFor("broken"), activity);
  assert.equal(cache.completionFor("broken", "all"), undefined);
});

test("v3 缓存原样保留访问者层级为空的存量契合指标映射", () => {
  const activity = { kind: "empty", fetchedAt: 1_000 };
  const validRelation = {
    visitor: { syncRate: { value: 42.5, fetchedAt: 1_000 } },
  };
  const writes = [];
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({
        version: 3,
        records: {
          // 外部损坏载荷：脚本自身永不写出空映射，但整体拒绝会让混合
          // 映射中其他访问者的有效数据一并丢失，故空条目原样保留。
          sai: { activity, relation: { visitor: null } },
          empty: { activity, relation: {} },
          friend: { activity, relation: validRelation },
          broken: {
            activity,
            relation: {
              visitor: { syncRate: { value: "x", fetchedAt: 1_000 } },
            },
          },
        },
      });
    },
    setItem(_key, value) {
      writes.push(JSON.parse(value));
    },
    removeItem() {},
  };
  const cache = createFriendCache(storage);

  assert.deepEqual(cache.activityFor("sai"), activity);
  assert.deepEqual(
    cache.relationFor("sai", {
      metric: "syncRate",
      visitorIdentifier: "visitor",
    }),
    undefined,
  );
  assert.deepEqual(
    cache.relationFor("friend", {
      metric: "syncRate",
      visitorIdentifier: "visitor",
    }),
    validRelation.visitor.syncRate,
  );
  assert.equal(
    cache.relationFor("broken", {
      metric: "syncRate",
      visitorIdentifier: "visitor",
    }),
    undefined,
  );
  assert.equal(
    cache.relationFor("empty", {
      metric: "syncRate",
      visitorIdentifier: "visitor",
    }),
    undefined,
  );

  cache.beginRefresh().complete();

  assert.deepEqual(writes.at(-1).records, {
    sai: { activity, relation: { visitor: null } },
    empty: { activity, relation: {} },
    friend: { activity, relation: validRelation },
    broken: { activity },
  });
});

test("好友缓存批次接纳领域结果，完成后可重建缓存并通过领域读取验证", () => {
  const writes = [];
  const storage = {
    getItem: () => (writes.length ? JSON.stringify(writes.at(-1)[1]) : null),
    setItem(key, value) {
      writes.push([key, JSON.parse(value)]);
    },
    removeItem() {},
  };
  const cache = createFriendCache(storage);
  const batch = cache.beginRefresh({ visitorIdentifier: "visitor" });

  batch.accept("sai", {
    activity: {
      kind: "active",
      activityAtSeconds: 1_000,
      fetchedAt: 2_000,
    },
  });
  batch.accept("sai", {
    completion: { all: 9 },
    fetchedAt: 3_000,
    relation: { commonLikes: 4, syncRate: 42.5 },
  });

  assert.deepEqual(cache.activityFor("sai"), {
    kind: "active",
    activityAtSeconds: 1_000,
    fetchedAt: 2_000,
  });
  assert.deepEqual(cache.completionFor("sai", "all"), {
    value: 9,
    fetchedAt: 3_000,
  });
  assert.deepEqual(
    cache.relationFor("sai", {
      metric: "syncRate",
      visitorIdentifier: "visitor",
    }),
    { value: 42.5, fetchedAt: 3_000 },
  );

  batch.complete();

  const reloaded = createFriendCache(storage);
  assert.deepEqual(reloaded.activityFor("sai"), {
    kind: "active",
    activityAtSeconds: 1_000,
    fetchedAt: 2_000,
  });
  assert.deepEqual(reloaded.completionFor("sai", "all"), {
    value: 9,
    fetchedAt: 3_000,
  });
  assert.deepEqual(
    reloaded.relationFor("sai", {
      metric: "syncRate",
      visitorIdentifier: "visitor",
    }),
    { value: 42.5, fetchedAt: 3_000 },
  );
});

test("好友缓存刷新批次重复完成时同步抛出", () => {
  const cache = createFriendCache(null);
  const batch = cache.beginRefresh();

  batch.complete();

  assert.throws(() => batch.complete(), /好友缓存刷新批次只能完成一次/);
});

test("好友缓存按领域目标和刷新模式决定待请求好友", () => {
  const hour = 60 * 60 * 1_000;
  const now = 100 * hour;
  const friends = ["fresh", "boundary", "stale", "missing"].map(
    (userIdentifier) => ({ userIdentifier }),
  );
  const records = {
    fresh: {
      activity: { kind: "empty", fetchedAt: now - hour },
      ...storedCompletion(1, now - hour),
      relation: {
        visitor: { syncRate: { value: 1, fetchedAt: now - hour } },
      },
    },
    boundary: {
      activity: { kind: "empty", fetchedAt: now - 24 * hour },
      ...storedCompletion(1, now - 72 * hour),
      relation: {
        visitor: { syncRate: { value: 1, fetchedAt: now - 72 * hour } },
      },
    },
    stale: {
      activity: { kind: "empty", fetchedAt: now - 24 * hour - 1 },
      ...storedCompletion(1, now - 72 * hour - 1),
      relation: {
        visitor: { syncRate: { value: 1, fetchedAt: now - 72 * hour - 1 } },
      },
    },
  };
  const cache = createFriendCache(friendCacheStorage(records), {
    now: () => now,
  });
  const identifiers = (target, options) =>
    cache
      .friendsNeedingRefresh(friends, target, options)
      .map(({ userIdentifier }) => userIdentifier);

  assert.deepEqual(identifiers({ kind: "activity" }), ["stale", "missing"]);
  assert.deepEqual(identifiers({ kind: "completion", scope: "all" }), [
    "stale",
    "missing",
  ]);
  assert.deepEqual(
    identifiers({
      kind: "relation",
      metric: "syncRate",
      visitorIdentifier: "visitor",
    }),
    ["stale", "missing"],
  );
  assert.deepEqual(identifiers({ kind: "activity" }, { mode: "full" }), [
    "fresh",
    "boundary",
    "stale",
    "missing",
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

  const cache = createFriendCache(storage);

  assert.equal(cache.activityFor("sai"), undefined);
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
  const cache = createFriendCache(storage);
  const record = { kind: "active", activityAtSeconds: 1, fetchedAt: 2_000 };

  refreshCache(cache, [["sai", { activity: record }]]);

  assert.equal(cache.activityFor("sai"), record);
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
  const values = createFriendCache(null, { now: () => now });
  for (const [userIdentifier, value] of [
    ["fresh", 1],
    ["boundary", 2],
    ["stale", 3],
  ]) {
    refreshCache(values, [
      [
        userIdentifier,
        {
          completion: { all: value },
          fetchedAt:
            userIdentifier === "fresh"
              ? now - hour
              : userIdentifier === "boundary"
                ? now - 72 * hour
                : now - 72 * hour - 1,
        },
      ],
    ]);
  }

  assert.deepEqual(
    values
      .friendsNeedingRefresh(friends, { kind: "completion", scope: "all" })
      .map(({ userIdentifier }) => userIdentifier),
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
  const cache = refreshCache(
    createFriendCache(null, { now: () => now }),
    [
      ["fresh", { relation: { syncRate: 1.5 }, fetchedAt: now - hour }],
      ["boundary", { relation: { syncRate: 2 }, fetchedAt: now - 72 * hour }],
      ["stale", { relation: { syncRate: 3 }, fetchedAt: now - 72 * hour - 1 }],
    ],
    { visitorIdentifier: "visitor" },
  );

  assert.deepEqual(
    cache
      .friendsNeedingRefresh(friends, {
        kind: "relation",
        metric: "syncRate",
        visitorIdentifier: "visitor",
      })
      .map(({ userIdentifier }) => userIdentifier),
    ["stale", "missing"],
  );
  assert.deepEqual(
    cache
      .friendsNeedingRefresh(friends, {
        kind: "relation",
        metric: "syncRate",
        visitorIdentifier: "other-visitor",
      })
      .map(({ userIdentifier }) => userIdentifier),
    ["fresh", "boundary", "stale", "missing"],
  );
});
