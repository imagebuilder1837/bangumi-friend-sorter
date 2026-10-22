import test from "node:test";
import assert from "node:assert/strict";
import { createFriendCache } from "../../src/cache/friend-cache.mjs";
import { fetchProfile } from "../../src/bangumi/http.mjs";
import { friendCacheStorage, storedCompletion } from "../support/cache.mjs";
import { createSessionHarness } from "../support/session.mjs";
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
