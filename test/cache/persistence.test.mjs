import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createFriendCache } from "../../src/cache/friend-cache.mjs";
import { fakeTimers } from "../support/timing.mjs";
import { controlledIndexedDB } from "../support/indexeddb.mjs";
const legacyKey = "bangumi-friend-sorter:activity-cache:v3";

async function commit(cache, identifier, result, visitorIdentifier) {
  const batch = cache.beginRefresh({ visitorIdentifier });
  batch.accept(identifier, result);
  return batch.complete();
}

async function openCache(t, indexedDB, storage = null, options = {}) {
  const cache = createFriendCache(storage, { indexedDB, ...options });
  await cache.ready;
  t.after(() => cache.close());
  return cache;
}

function legacyStorage(payload) {
  const values = new Map(payload ? [[legacyKey, JSON.stringify(payload)]] : []);
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("v3 过期结果保留原始时间，导入后可从数据库重新读取", async (t) => {
  const indexedDB = new IDBFactory();
  const activity = { kind: "active", activityAtSeconds: 100, fetchedAt: 1_000 };
  const storage = legacyStorage({
    version: 3,
    records: { friend: { activity } },
  });
  const first = createFriendCache(storage, { indexedDB });
  await first.ready;
  t.after(() => first.close());

  const reopened = createFriendCache(null, { indexedDB });
  await reopened.ready;
  t.after(() => reopened.close());

  assert.deepEqual(reopened.activityFor("friend"), activity);
  assert.equal(storage.getItem(legacyKey), null);
});

test("任务完成才提交好友指标，重新打开后保留各范围与访问者结果", async (t) => {
  const indexedDB = new IDBFactory();
  const cache = await openCache(t, indexedDB);
  const batch = cache.beginRefresh({ visitorIdentifier: "visitor" });
  const activity = { kind: "empty", fetchedAt: 2_000 };
  batch.accept("friend", {
    activity,
    completion: { all: 9, 2: 4 },
    relation: { syncRate: 42.5, commonLikes: 3 },
    fetchedAt: 3_000,
  });
  const before = await openCache(t, indexedDB);
  assert.equal(before.activityFor("friend"), undefined);
  await batch.complete();

  const after = await openCache(t, indexedDB);
  assert.deepEqual(after.activityFor("friend"), activity);
  assert.deepEqual(after.completionFor("friend", "all"), {
    value: 9,
    fetchedAt: 3_000,
  });
  assert.deepEqual(after.completionFor("friend", "2"), {
    value: 4,
    fetchedAt: 3_000,
  });
  assert.deepEqual(
    after.relationFor("friend", {
      visitorIdentifier: "visitor",
      metric: "syncRate",
    }),
    { value: 42.5, fetchedAt: 3_000 },
  );
  assert.deepEqual(
    after.relationFor("friend", {
      visitorIdentifier: "visitor",
      metric: "commonLikes",
    }),
    { value: 3, fetchedAt: 3_000 },
  );
  assert.equal(
    after.relationFor("friend", {
      visitorIdentifier: "other",
      metric: "syncRate",
    }),
    undefined,
  );
});

test("并发页签按指标合并，较旧响应不覆盖新值，同时间后提交者胜出", async (t) => {
  const indexedDB = new IDBFactory();
  const first = await openCache(t, indexedDB);
  const second = await openCache(t, indexedDB);
  await Promise.all([
    commit(
      first,
      "friend",
      { completion: { all: 20 }, relation: { syncRate: 80 }, fetchedAt: 20 },
      "visitor-a",
    ),
    commit(
      second,
      "friend",
      {
        completion: { all: 10, 2: 3 },
        relation: { syncRate: 40 },
        fetchedAt: 10,
      },
      "visitor-b",
    ),
  ]);
  await commit(second, "other", { activity: { kind: "empty", fetchedAt: 10 } });
  let after = await openCache(t, indexedDB);
  assert.deepEqual(after.completionFor("friend", "all"), {
    value: 20,
    fetchedAt: 20,
  });
  assert.deepEqual(after.completionFor("friend", "2"), {
    value: 3,
    fetchedAt: 10,
  });
  assert.deepEqual(
    after.relationFor("friend", {
      visitorIdentifier: "visitor-a",
      metric: "syncRate",
    }),
    { value: 80, fetchedAt: 20 },
  );
  assert.deepEqual(
    after.relationFor("friend", {
      visitorIdentifier: "visitor-b",
      metric: "syncRate",
    }),
    { value: 40, fetchedAt: 10 },
  );
  assert.deepEqual(after.activityFor("other"), {
    kind: "empty",
    fetchedAt: 10,
  });
  assert.equal(
    first.activityFor("other"),
    undefined,
    "不会实时回灌其他页签的内存",
  );

  await commit(second, "friend", { completion: { all: 30 }, fetchedAt: 20 });
  after = await openCache(t, indexedDB);
  assert.deepEqual(after.completionFor("friend", "all"), {
    value: 30,
    fetchedAt: 20,
  });
});

test("初始化最多等两秒，超时保留 v3，迟到连接不迁移或回灌内存", async (t) => {
  const factory = new IDBFactory();
  const clock = fakeTimers();
  let release;
  const indexedDB = {
    open(name, version) {
      let native;
      const delayed = {
        get result() {
          return native.result;
        },
        get transaction() {
          return native.transaction;
        },
      };
      release = () =>
        new Promise((resolve) => {
          native = factory.open(name, version);
          for (const event of [
            "upgradeneeded",
            "success",
            "error",
            "blocked",
          ]) {
            native.addEventListener(event, (value) => {
              delayed[`on${event}`]?.(value);
              if (event === "success" || event === "error") resolve();
            });
          }
        });
      return delayed;
    },
  };
  const activity = { kind: "empty", fetchedAt: 100 };
  const storage = legacyStorage({
    version: 3,
    records: { friend: { activity } },
  });
  const cache = createFriendCache(storage, {
    indexedDB,
    setTimeoutImpl: clock.setTimer,
    clearTimeoutImpl: clock.clearTimer,
  });
  t.after(() => cache.close());
  let ready = false;
  cache.ready.then(() => {
    ready = true;
  });
  await clock.advance(1_999);
  assert.equal(ready, false);
  await clock.advance(1);
  assert.equal(ready, true);
  assert.deepEqual(cache.activityFor("friend"), activity);

  const newer = { kind: "active", activityAtSeconds: 5, fetchedAt: 200 };
  await commit(cache, "friend", { activity: newer });
  await release();
  assert.deepEqual(cache.activityFor("friend"), newer);
  assert.notEqual(storage.getItem(legacyKey), null);
  const reopened = await openCache(t, factory, storage);
  assert.deepEqual(reopened.activityFor("friend"), activity);
});

test("贴贴按访问者保存完整统计，较旧完整结果不覆盖较新结果", async (t) => {
  const indexedDB = new IDBFactory();
  const first = await openCache(t, indexedDB);
  const second = await openCache(t, indexedDB);
  const result = {
    counts: new Map([
      ["friend", 3],
      ["non-friend", 5],
    ]),
    fetchedAt: 200,
  };
  assert.equal(first.replaceTietie("visitor", result), true);
  assert.equal(
    second.replaceTietie("visitor", { counts: new Map(), fetchedAt: 100 }),
    true,
  );
  assert.equal(
    second.replaceTietie("other", {
      counts: new Map([["friend", 1]]),
      fetchedAt: 200,
    }),
    true,
  );
  assert.equal(
    first.replaceTietie("visitor", { counts: { friend: -1 }, fetchedAt: 300 }),
    false,
  );

  const after = await openCache(t, indexedDB);
  assert.deepEqual(after.tietieFor("visitor"), result);
  assert.deepEqual(after.tietieFor("other"), {
    counts: new Map([["friend", 1]]),
    fetchedAt: 200,
  });
});

test("localStorage 暂不可读时不封死迁移，下次导入不会覆盖数据库较新指标", async (t) => {
  const indexedDB = new IDBFactory();
  let readable = false;
  const activity = { kind: "empty", fetchedAt: 100 };
  const storage = legacyStorage({
    version: 3,
    records: {
      friend: { activity, completion_all: { value: 1, fetchedAt: 100 } },
    },
  });
  const getItem = storage.getItem;
  storage.getItem = (key) => {
    if (!readable) throw new Error("denied");
    return getItem(key);
  };
  const first = await openCache(t, indexedDB, storage);
  await commit(first, "friend", { completion: { all: 9 }, fetchedAt: 200 });
  readable = true;

  const migrated = await openCache(t, indexedDB, storage);
  assert.deepEqual(migrated.completionFor("friend", "all"), {
    value: 9,
    fetchedAt: 200,
  });
  assert.deepEqual(migrated.activityFor("friend"), activity);
  const reopened = await openCache(t, indexedDB);
  assert.deepEqual(reopened.completionFor("friend", "all"), {
    value: 9,
    fetchedAt: 200,
  });
});

test("导入事务失败保留 v3 与内存结果，下次可重新导入且没有半份落盘", async (t) => {
  const boundary = controlledIndexedDB();
  const activity = { kind: "empty", fetchedAt: 100 };
  const storage = legacyStorage({
    version: 3,
    records: { friend: { activity } },
    tietie: { visitor: { counts: { friend: 2 }, fetchedAt: 100 } },
  });
  boundary.abortNextTransaction();
  const failed = await openCache(t, boundary.indexedDB, storage);
  assert.deepEqual(failed.activityFor("friend"), activity);
  assert.notEqual(storage.getItem(legacyKey), null);
  const empty = await openCache(t, boundary.indexedDB);
  assert.equal(empty.activityFor("friend"), undefined);
  assert.equal(empty.tietieFor("visitor"), undefined);
  const retried = await openCache(t, boundary.indexedDB, storage);
  assert.deepEqual(retried.activityFor("friend"), activity);
  assert.deepEqual(retried.tietieFor("visitor"), {
    counts: new Map([["friend", 2]]),
    fetchedAt: 100,
  });
  assert.equal(storage.getItem(legacyKey), null);
});

test("写入事务失败不丢内存结果，下次正常提交顺带重试", async (t) => {
  const boundary = controlledIndexedDB();
  const cache = await openCache(t, boundary.indexedDB);
  boundary.abortNextTransaction();
  assert.equal(
    await commit(cache, "friend", { completion: { all: 7 }, fetchedAt: 100 }),
    false,
  );
  assert.deepEqual(cache.completionFor("friend", "all"), {
    value: 7,
    fetchedAt: 100,
  });
  const beforeRetry = await openCache(t, boundary.indexedDB);
  assert.equal(beforeRetry.completionFor("friend", "all"), undefined);
  await commit(cache, "other", { activity: { kind: "empty", fetchedAt: 200 } });
  const after = await openCache(t, boundary.indexedDB);
  assert.deepEqual(after.completionFor("friend", "all"), {
    value: 7,
    fetchedAt: 100,
  });
  assert.deepEqual(after.activityFor("other"), {
    kind: "empty",
    fetchedAt: 200,
  });
});

test("提交期间接纳的新结果不会被较早事务的完成确认清除", async (t) => {
  const indexedDB = new IDBFactory();
  const cache = await openCache(t, indexedDB);
  const earlier = commit(cache, "friend", {
    completion: { all: 1 },
    fetchedAt: 100,
  });
  const batch = cache.beginRefresh();
  batch.accept("friend", { completion: { all: 2 }, fetchedAt: 200 });
  await earlier;
  await batch.complete();
  const after = await openCache(t, indexedDB);
  assert.deepEqual(after.completionFor("friend", "all"), {
    value: 2,
    fetchedAt: 200,
  });
});

test("并发迁移与清理失败不会重复导入，v1 v2 旧键完全不接触", async (t) => {
  const indexedDB = new IDBFactory();
  const activity = { kind: "empty", fetchedAt: 100 };
  let reads = 0;
  const storage = legacyStorage({
    version: 3,
    records: { friend: { activity } },
  });
  const getItem = storage.getItem;
  storage.getItem = (key) => {
    assert.equal(key, legacyKey);
    reads += 1;
    return getItem(key);
  };
  storage.removeItem = (key) => {
    assert.equal(key, legacyKey);
    throw new Error("denied");
  };
  storage.setItem = () => assert.fail("不得回写 localStorage");
  const [first, second] = await Promise.all([
    openCache(t, indexedDB, storage),
    openCache(t, indexedDB, storage),
  ]);
  assert.deepEqual(first.activityFor("friend"), activity);
  assert.deepEqual(second.activityFor("friend"), activity);
  await commit(first, "friend", {
    activity: { kind: "empty", fetchedAt: 200 },
  });
  const after = await openCache(t, indexedDB, storage);
  assert.deepEqual(after.activityFor("friend"), {
    kind: "empty",
    fetchedAt: 200,
  });
  assert.equal(reads, 1);
});

test("确认没有或仅有损坏 v3 后，不追赶旧版页签后来写入的数据", async (t) => {
  for (const raw of [
    null,
    "{broken",
    JSON.stringify({ version: 2, records: {} }),
  ]) {
    const indexedDB = new IDBFactory();
    const storage = legacyStorage();
    if (raw) storage.setItem(legacyKey, raw);
    await openCache(t, indexedDB, storage);
    storage.setItem(
      legacyKey,
      JSON.stringify({
        version: 3,
        records: { friend: { activity: { kind: "empty", fetchedAt: 100 } } },
      }),
    );
    const after = await openCache(t, indexedDB, storage);
    assert.equal(after.activityFor("friend"), undefined);
    assert.notEqual(storage.getItem(legacyKey), null);
  }
});

test("数据库打开失败只使用内存，不自动重连或回写 localStorage", async (t) => {
  let attempts = 0;
  const indexedDB = {
    open() {
      attempts += 1;
      throw new Error("denied");
    },
  };
  const storage = legacyStorage({
    version: 3,
    records: { friend: { activity: { kind: "empty", fetchedAt: 100 } } },
  });
  storage.setItem = () => assert.fail("不得回写 localStorage");
  const cache = await openCache(t, indexedDB, storage);
  assert.deepEqual(cache.activityFor("friend"), {
    kind: "empty",
    fetchedAt: 100,
  });
  await commit(cache, "friend", { completion: { all: 2 }, fetchedAt: 200 });
  await commit(cache, "other", { completion: { all: 3 }, fetchedAt: 200 });
  assert.deepEqual(cache.completionFor("friend", "all"), {
    value: 2,
    fetchedAt: 200,
  });
  assert.notEqual(storage.getItem(legacyKey), null);
  assert.equal(attempts, 1);
});

test("数据库拒绝克隆的结果只影响持久化，不抛出存储异常", async (t) => {
  const indexedDB = new IDBFactory();
  const cache = await openCache(t, indexedDB);
  const activity = { kind: "empty", fetchedAt: 100, extra: () => {} };
  assert.equal(await commit(cache, "friend", { activity }), false);
  assert.equal(cache.activityFor("friend"), activity);
  const reopened = await openCache(t, indexedDB);
  assert.equal(reopened.activityFor("friend"), undefined);
});

test("其他页签升级时释放连接，本页继续内存排序且不重连", async (t) => {
  const boundary = controlledIndexedDB();
  const cache = await openCache(t, boundary.indexedDB);
  await boundary.upgrade();
  const activity = { kind: "empty", fetchedAt: 100 };
  assert.equal(await commit(cache, "friend", { activity }), false);
  assert.deepEqual(cache.activityFor("friend"), activity);
});
