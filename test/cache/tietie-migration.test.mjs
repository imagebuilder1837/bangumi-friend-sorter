import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createFriendCache } from "../../src/cache/friend-cache.mjs";

const legacyKey = "bangumi-friend-sorter:activity-cache:v3";

// Compatibility fixtures deliberately use persisted keys, not production constants.
async function seedDatabase(indexedDB, entries, imported = false) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("bangumi-friend-sorter:cache", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("values", { keyPath: "key" });
      request.result.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(["values", "meta"], "readwrite");
    for (const entry of entries) transaction.objectStore("values").put(entry);
    if (imported)
      transaction.objectStore("meta").put(true, "legacy-v3-imported");
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  return database;
}

async function openCache(t, indexedDB, storage = null, options = {}) {
  const cache = createFriendCache(storage, { indexedDB, ...options });
  await cache.ready;
  t.after(() => cache.close());
  return cache;
}

test("接收方新键可读取及更新，旧贴贴键不参与比较也不被删除", async (t) => {
  const indexedDB = new IDBFactory();
  const oldEntry = {
    key: ["tietie", "recipient"],
    record: { counts: { friend: 99 }, fetchedAt: 900 },
  };
  const activity = { kind: "empty", fetchedAt: 100 };
  const database = await seedDatabase(
    indexedDB,
    [
      oldEntry,
      {
        key: ["tietieByRecipient", "recipient"],
        record: { counts: { friend: 1 }, fetchedAt: 100 },
      },
      { key: ["activity", "friend"], record: activity },
    ],
    true,
  );
  t.after(() => database.close());
  const cache = await openCache(t, indexedDB);
  assert.deepEqual(cache.tietieFor("recipient"), {
    counts: new Map([["friend", 1]]),
    fetchedAt: 100,
  });
  assert.deepEqual(cache.activityFor("friend"), activity);

  const result = { counts: new Map([["outsider", 2]]), fetchedAt: 200 };
  assert.equal(cache.replaceTietie("recipient", result), true);
  const reopened = await openCache(t, indexedDB);
  assert.deepEqual(reopened.tietieFor("recipient"), result);
  assert.deepEqual(reopened.activityFor("friend"), activity);

  const preserved = await new Promise((resolve, reject) => {
    const request = database
      .transaction("values")
      .objectStore("values")
      .get(oldEntry.key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.deepEqual(preserved, oldEntry);
});

test("已完成迁移时忽略旧贴贴键，不因 v3 残留而重新导入", async (t) => {
  for (const residual of [false, true]) {
    await t.test(residual ? "v3 仍残留" : "v3 已删除", async (t) => {
      const indexedDB = new IDBFactory();
      const database = await seedDatabase(
        indexedDB,
        [
          {
            key: ["tietie", "recipient"],
            record: { counts: { friend: 9 }, fetchedAt: 100 },
          },
        ],
        true,
      );
      database.close();
      const raw = residual
        ? JSON.stringify({
            version: 3,
            tietie: { recipient: { counts: { friend: 7 }, fetchedAt: 200 } },
          })
        : null;
      let reads = 0;
      let removals = 0;
      const storage = {
        getItem() {
          reads += 1;
          return raw;
        },
        removeItem() {
          removals += 1;
        },
      };
      const cache = await openCache(t, indexedDB, storage);
      assert.equal(cache.tietieFor("recipient"), undefined);
      assert.equal(cache.tietieNeedsRefresh("recipient"), true);
      assert.equal(reads, 0);
      assert.equal(removals, 0);
    });
  }
});

test("v3 贴贴导入接收方新键，保留原标识和时间并只与新键比较", async (t) => {
  for (const savedTime of [null, 100, 200, 300]) {
    await t.test(`已有新键时间 ${savedTime}`, async (t) => {
      const indexedDB = new IDBFactory();
      const entries = [
        {
          key: ["tietie", "recipient"],
          record: { counts: { friend: 99 }, fetchedAt: 900 },
        },
      ];
      if (savedTime !== null)
        entries.push({
          key: ["tietieByRecipient", "recipient"],
          record: { counts: { friend: 1 }, fetchedAt: savedTime },
        });
      const database = await seedDatabase(indexedDB, entries);
      database.close();
      let raw = JSON.stringify({
        version: 3,
        tietie: {
          recipient: { counts: { friend: 2, outsider: 3 }, fetchedAt: 200 },
          123: { counts: {}, fetchedAt: 100 },
          username: { counts: { friend: 4 }, fetchedAt: 150 },
          broken: { counts: { friend: -1 }, fetchedAt: 200 },
        },
      });
      const storage = {
        getItem(key) {
          return key === legacyKey ? raw : null;
        },
        removeItem(key) {
          if (key === legacyKey) raw = null;
        },
      };
      const options = { now: () => 73 * 60 * 60 * 1_000 };
      const cache = await openCache(t, indexedDB, storage, options);
      const expected =
        savedTime > 200
          ? { counts: new Map([["friend", 1]]), fetchedAt: savedTime }
          : {
              counts: new Map([
                ["friend", 2],
                ["outsider", 3],
              ]),
              fetchedAt: 200,
            };
      assert.deepEqual(cache.tietieFor("recipient"), expected);
      assert.equal(cache.tietieNeedsRefresh("recipient"), true);
      assert.equal(raw, null);

      const reopened = await openCache(t, indexedDB, null, options);
      assert.deepEqual(reopened.tietieFor("recipient"), expected);
      assert.deepEqual(reopened.tietieFor("123"), {
        counts: new Map(),
        fetchedAt: 100,
      });
      assert.deepEqual(reopened.tietieFor("username"), {
        counts: new Map([["friend", 4]]),
        fetchedAt: 150,
      });
      assert.equal(reopened.tietieFor("broken"), undefined);
    });
  }
});
