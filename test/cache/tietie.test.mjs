import test from "node:test";
import assert from "node:assert/strict";
import { createFriendCache } from "../../src/cache/friend-cache.mjs";
import {
  persistentFriendCacheStorage,
  openPersistentCache,
} from "../support/cache.mjs";
import { controlledIndexedDB } from "../support/indexeddb.mjs";
test("和 TA 贴贴完整结果跨缓存重建保存全部反应者并遵守七十二小时边界", async () => {
  const hour = 60 * 60 * 1_000;
  const now = 100 * hour;
  const fetchedAt = now - 72 * hour;
  const storage = persistentFriendCacheStorage();
  const cache = await openPersistentCache(storage, { now: () => now });

  cache.replaceTietie("visitor", {
    counts: new Map([
      ["friend-a", 3],
      ["friend-b", 1],
    ]),
    fetchedAt,
  });

  const reloaded = await openPersistentCache(storage, { now: () => now });

  assert.deepEqual(reloaded.tietieFor("visitor"), {
    counts: new Map([
      ["friend-a", 3],
      ["friend-b", 1],
    ]),
    fetchedAt,
  });
  assert.equal(reloaded.tietieNeedsRefresh("visitor"), false);

  const expired = await openPersistentCache(storage, {
    now: () => now + 1,
  });
  assert.equal(expired.tietieNeedsRefresh("visitor"), true);
});

test("v3 贴贴按原接收方标识导入，损坏记录不影响已有主页字段", () => {
  const now = 100_000;
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({
        version: 3,
        records: {
          friend: {
            completion_all: { value: 8, fetchedAt: now },
          },
        },
        tietie: {
          visitorA: {
            counts: { friend: 2 },
            fetchedAt: now,
          },
          visitorB: {
            counts: { friend: 9 },
            fetchedAt: now,
          },
          broken: {
            counts: { friend: -1 },
            fetchedAt: now,
          },
        },
      });
    },
    setItem() {},
    removeItem() {},
  };
  const cache = createFriendCache(storage, { now: () => now });

  assert.deepEqual(cache.tietieFor("visitorA"), {
    counts: new Map([["friend", 2]]),
    fetchedAt: now,
  });
  assert.deepEqual(cache.tietieFor("visitorB"), {
    counts: new Map([["friend", 9]]),
    fetchedAt: now,
  });
  assert.equal(cache.tietieFor("broken"), undefined);
  assert.deepEqual(cache.completionFor("friend", "all"), {
    value: 8,
    fetchedAt: now,
  });
});

test("和 TA 贴贴持久化写入不可用时保留当前页面结果且不破坏主页字段", async () => {
  const now = 100_000;
  const storage = persistentFriendCacheStorage(
    JSON.stringify({
      version: 3,
      records: { friend: { completion_all: { value: 8, fetchedAt: now } } },
    }),
  );
  const boundary = controlledIndexedDB();
  const cache = createFriendCache(storage, {
    indexedDB: boundary.indexedDB,
    now: () => now,
  });
  await cache.ready;
  boundary.abortNextTransaction();

  assert.equal(
    cache.replaceTietie("visitor", {
      counts: new Map([["friend", 0]]),
      fetchedAt: now,
    }),
    true,
  );
  assert.deepEqual(cache.tietieFor("visitor"), {
    counts: new Map([["friend", 0]]),
    fetchedAt: now,
  });
  assert.deepEqual(cache.completionFor("friend", "all"), {
    value: 8,
    fetchedAt: now,
  });
  const reopened = createFriendCache(null, { indexedDB: boundary.indexedDB });
  await reopened.ready;
  assert.equal(reopened.tietieFor("visitor"), undefined);
  assert.deepEqual(reopened.completionFor("friend", "all"), {
    value: 8,
    fetchedAt: now,
  });
});
