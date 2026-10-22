import test from "node:test";
import assert from "node:assert/strict";
import { createFriendCache } from "../../src/cache/friend-cache.mjs";
import { createFriendSortSession } from "../../src/workflow/session.mjs";
import { waitForCondition } from "../support/timing.mjs";
import { refreshCache } from "../support/cache.mjs";
import { createSessionHarness } from "../support/session.mjs";
test("会话切换排序目标后旧任务的迟到结果不覆盖当前排序", async () => {
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36);
  const cache = createFriendCache(null);
  let releaseFetches;
  const fetchesReleased = new Promise((resolve) => {
    releaseFetches = resolve;
  });
  const { finished, lastMessage, lastState, session } = createSessionHarness({
    cache,
    friends: [{ userIdentifier: "sai" }, { userIdentifier: "tom" }],
    runtime: {
      http: {
        fetchActivity: async () => {
          await fetchesReleased;
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
    },
  });

  session.choose("activity");
  session.choose("name");
  const nameOrder = lastState().orderedFriends.map(
    (friend) => friend.userIdentifier,
  );
  releaseFetches();
  await finished;

  assert.equal(lastState().criterion, "name");
  assert.deepEqual(
    lastState().orderedFriends.map((friend) => friend.userIdentifier),
    nameOrder,
  );
  assert.equal(lastMessage(), "“上次活跃”获取完成");
  const expectedActivity = {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
    fetchedAt: responseTime,
  };
  assert.deepEqual(cache.activityFor("sai"), expectedActivity);
  assert.deepEqual(cache.activityFor("tom"), expectedActivity);
});

test("会话切换排序目标和方向时继承紧邻此前的顺序", () => {
  const now = 1_000;
  const cache = createFriendCache(null, { now: () => now });
  refreshCache(cache, [
    ["z", { completion: { all: 1 }, fetchedAt: now }],
    ["b", { completion: { all: 10 }, fetchedAt: now }],
    ["a", { completion: { all: 10 }, fetchedAt: now }],
    ["c", { completion: { all: 1 }, fetchedAt: now }],
  ]);
  const friends = [
    { userIdentifier: "z", displayName: "Z", originalIndex: 0 },
    { userIdentifier: "b", displayName: "A", originalIndex: 1 },
    { userIdentifier: "a", displayName: "B", originalIndex: 2 },
    { userIdentifier: "c", displayName: "C", originalIndex: 3 },
  ];
  const { lastState, session } = createSessionHarness({
    cache,
    friends,
    runtime: { now: () => now, http: {} },
  });

  session.choose("name");
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["b", "a", "c", "z"],
  );

  session.choose("completion", "all");
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["b", "a", "c", "z"],
  );

  session.changeDirection("asc");
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["c", "z", "b", "a"],
  );

  session.choose("added");
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["z", "b", "a", "c"],
  );
});

test("远程刷新完成后的平局继承刷新前的缓存排序", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 24 * 60 * 60 * 1_000 - 1;
  const cache = createFriendCache(null, { now: () => now });
  refreshCache(cache, [
    [
      "a",
      {
        activity: {
          kind: "active",
          activityAtSeconds: 2,
          fetchedAt: staleFetchedAt,
        },
      },
    ],
    [
      "z",
      {
        activity: {
          kind: "active",
          activityAtSeconds: 3,
          fetchedAt: staleFetchedAt,
        },
      },
    ],
    [
      "b",
      {
        activity: {
          kind: "active",
          activityAtSeconds: 1,
          fetchedAt: staleFetchedAt,
        },
      },
    ],
  ]);
  const friends = [
    { userIdentifier: "a", displayName: "B", originalIndex: 0 },
    { userIdentifier: "z", displayName: "Z", originalIndex: 1 },
    { userIdentifier: "b", displayName: "A", originalIndex: 2 },
  ];
  let releaseFetches;
  const fetchesReleased = new Promise((resolve) => {
    releaseFetches = resolve;
  });
  const { finished, lastState, session } = createSessionHarness({
    cache,
    friends,
    runtime: {
      http: {
        fetchActivity: async () => {
          await fetchesReleased;
          return {
            kind: "success",
            record: {
              kind: "active",
              activityAtSeconds: 4,
              fetchedAt: now,
            },
          };
        },
      },
      now: () => now,
    },
  });

  session.choose("name");
  session.choose("activity");
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["z", "a", "b"],
  );

  releaseFetches();
  await finished;
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["z", "a", "b"],
  );
});

test("同步启动生命周期或适配器异常原样同步抛出，清理后其他远程任务仍可运行", async () => {
  for (const failAt of ["progress", "fetch"]) {
    const failure = new Error(`sync ${failAt} bug`);
    const reported = [];
    let shouldFail = true;
    let lastState;
    let profileRequests = 0;
    const now = () => 1_000;
    const session = createFriendSortSession({
      cache: createFriendCache(null, { now }),
      collator: new Intl.Collator(),
      friends: [{ userIdentifier: "a", displayName: "A", originalIndex: 0 }],
      now,
      pageWindow: {},
      visitorIdentifier: null,
      reportError: (_stage, error) => reported.push(error),
      sortBar: {
        render(state) {
          lastState = state;
        },
      },
      runtime: {
        setTimeout: () => 1,
        clearTimeout() {},
        onProgress() {
          if (failAt === "progress" && shouldFail) {
            shouldFail = false;
            throw failure;
          }
        },
      },
      http: {
        fetchActivity() {
          throw failure;
        },
        fetchProfile: async () => {
          profileRequests += 1;
          return { kind: "http-error", status: 404 };
        },
      },
    });
    session.start();

    assert.throws(
      () => session.choose("activity"),
      (error) => error === failure,
    );
    assert.deepEqual(reported, [failure]);
    assert.doesNotMatch(lastState.statusMessage, /正在获取/);
    session.choose("completion", "all");
    await waitForCondition(
      () =>
        profileRequests === 1 && lastState.statusMessage.includes("获取完成"),
    );
    assert.deepEqual(reported, [failure]);
  }
});

test("会话对未知排序目标、子选项、方向与重复启动同步抛出", () => {
  const { session } = createSessionHarness({
    cache: createFriendCache(null),
    friends: [],
    runtime: {},
  });

  assert.throws(() => session.choose("bogus"), /未知的排序目标/);
  assert.throws(() => session.choose("activity", "bogus"), /未知的排序子选项/);
  assert.throws(
    () => session.choose("completion", "bogus"),
    /未知的排序子选项/,
  );
  assert.throws(() => session.choose("relation", "bogus"), /未知的排序子选项/);
  assert.throws(() => session.changeDirection("bogus"), /未知的排序方向/);
  assert.throws(() => session.start(), /只能启动一次/);
});
