import test from "node:test";
import assert from "node:assert/strict";
import { fetchProfile } from "../../src/bangumi/http.mjs";
import {
  persistentFriendCacheStorage,
  openPersistentCache,
  completionSnapshotFor,
} from "../support/cache.mjs";
import { createSessionHarness } from "../support/session.mjs";
test("同一主页响应分别刷新完成统计，失败范围保留旧缓存", async () => {
  const now = 10_000;
  const oldBook = { value: 99, fetchedAt: now - 1 };
  const storage = persistentFriendCacheStorage(
    JSON.stringify({
      version: 3,
      records: { sai: { completion_1: oldBook } },
    }),
  );
  const cache = await openPersistentCache(storage);

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
  const reloaded = await openPersistentCache(storage);
  assert.deepEqual(
    completionSnapshotFor(reloaded, "sai"),
    completionSnapshotFor(cache, "sai"),
  );
});

test("某个完成范围解析无效只保留该范围旧缓存，其余范围和契合字段照常写入", async () => {
  const now = 10_000;
  const oldAnimation = { value: 77, fetchedAt: now - 1 };
  const storage = persistentFriendCacheStorage(
    JSON.stringify({
      version: 3,
      records: { sai: { completion_2: oldAnimation } },
    }),
  );
  const cache = await openPersistentCache(storage);

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
  const reloaded = await openPersistentCache(storage);
  assert.deepEqual(
    completionSnapshotFor(reloaded, "sai"),
    completionSnapshotFor(cache, "sai"),
  );
});
