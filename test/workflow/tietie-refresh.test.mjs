import test from "node:test";
import assert from "node:assert/strict";
import { createFriendCache } from "../../src/cache/friend-cache.mjs";
import { parseTietieTimelineDocument } from "../../src/bangumi/tietie-parser.mjs";
import {
  persistentFriendCacheStorage,
  openPersistentCache,
} from "../support/cache.mjs";
import { createSessionHarness } from "../support/session.mjs";
import { documentFromFixture } from "../support/html.mjs";
test("和我贴贴遇到未知空页时保留旧结果", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const cache = createFriendCache(null, { now: () => now });
  cache.replaceTietie("visitor", {
    counts: new Map([["friend-a", 4]]),
    fetchedAt: staleFetchedAt,
  });
  const { finished, lastMessage, session } = createSessionHarness({
    cache,
    friends: [{ userIdentifier: "friend-a", originalIndex: 0 }],
    runtime: {
      http: {
        fetchTietiePage: async (_visitorIdentifier, category, page) => {
          const filename =
            category === "say"
              ? "timeline-tietie-empty-no-container.html"
              : "timeline-tietie-empty-unknown.html";
          const record = parseTietieTimelineDocument(
            documentFromFixture(filename),
            {
              baseUrl: `https://bgm.tv/user/visitor/timeline?type=${category}`,
              category,
              page,
            },
          );
          return record.kind === "invalid"
            ? { kind: "parse-error" }
            : { kind: "success", record };
        },
      },
      now: () => now,
    },
  });

  session.choose("tietie");
  await finished;

  assert.equal(lastMessage(), "“和我贴贴”获取失败，本次结果未更新");
  assert.deepEqual(cache.tietieFor("visitor"), {
    counts: new Map([["friend-a", 4]]),
    fetchedAt: staleFetchedAt,
  });
});

test("和我贴贴有效缓存直接排序并跨好友列表复用而不发起任务", async () => {
  const now = 100_000;
  const storage = persistentFriendCacheStorage();
  const cache = await openPersistentCache(storage, { now: () => now });
  cache.replaceTietie("visitor", {
    counts: new Map([
      ["friend-b", 5],
      ["outside-list", 3],
    ]),
    fetchedAt: now,
  });

  const requests = [];
  const first = createSessionHarness({
    cache: await openPersistentCache(storage, { now: () => now }),
    friends: [
      { userIdentifier: "friend-a", originalIndex: 0 },
      { userIdentifier: "friend-b", originalIndex: 1 },
      { userIdentifier: "friend-c", originalIndex: 2 },
    ],
    runtime: {
      http: {
        fetchTietiePage: async () => {
          requests.push("unexpected");
          return null;
        },
      },
      now: () => now,
    },
  });
  first.session.choose("tietie");

  assert.deepEqual(
    first
      .lastState()
      .orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["friend-b", "friend-a", "friend-c"],
  );
  assert.deepEqual(requests, []);

  const second = createSessionHarness({
    cache: await openPersistentCache(storage, { now: () => now }),
    friends: [
      { userIdentifier: "friend-c", originalIndex: 0 },
      { userIdentifier: "friend-b", originalIndex: 1 },
    ],
    runtime: {
      http: {
        fetchTietiePage: async () => {
          requests.push("unexpected");
          return null;
        },
      },
      now: () => now,
    },
  });
  second.session.choose("tietie");

  assert.deepEqual(
    second
      .lastState()
      .orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["friend-b", "friend-c"],
  );
  assert.deepEqual(requests, []);
});

test("和我贴贴过期时先排旧结果，成功后整体替换并继承刷新前平局顺序", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const storage = persistentFriendCacheStorage();
  const cache = await openPersistentCache(storage, { now: () => now });
  cache.replaceTietie("visitor", {
    counts: new Map([
      ["friend-a", 1],
      ["friend-b", 9],
      ["friend-old", 7],
    ]),
    fetchedAt: staleFetchedAt,
  });
  const requests = [];
  const { finished, lastState, session } = createSessionHarness({
    cache,
    friends: [
      { userIdentifier: "friend-a", originalIndex: 0 },
      { userIdentifier: "friend-b", originalIndex: 1 },
      { userIdentifier: "friend-c", originalIndex: 2 },
      { userIdentifier: "friend-old", originalIndex: 3 },
    ],
    runtime: {
      http: {
        fetchTietiePage: async (_visitorIdentifier, category) => {
          requests.push(category);
          return {
            kind: "success",
            record: {
              kind: "success",
              contents: [
                {
                  contentKey: `/${category}/content`,
                  reactorIdentifiers: [
                    category === "say" ? "friend-a" : "friend-b",
                  ],
                },
              ],
              hasNextPage: false,
            },
          };
        },
      },
      now: () => now,
    },
  });

  session.choose("tietie");
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["friend-b", "friend-old", "friend-a", "friend-c"],
  );

  await finished;

  assert.deepEqual(requests, ["say", "subject"]);
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["friend-b", "friend-a", "friend-old", "friend-c"],
  );
  const reloaded = await openPersistentCache(storage, { now: () => now });
  assert.deepEqual(reloaded.tietieFor("visitor"), {
    counts: new Map([
      ["friend-a", 1],
      ["friend-b", 1],
    ]),
    fetchedAt: now,
  });
});

test("和我贴贴刷新部分失败时保留旧结果且不续期", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const storage = persistentFriendCacheStorage();
  const cache = await openPersistentCache(storage, { now: () => now });
  cache.replaceTietie("visitor", {
    counts: new Map([["friend-b", 5]]),
    fetchedAt: staleFetchedAt,
  });
  const { finished, lastMessage, lastState, session } = createSessionHarness({
    cache,
    friends: [
      { userIdentifier: "friend-a", originalIndex: 0 },
      { userIdentifier: "friend-b", originalIndex: 1 },
    ],
    runtime: {
      http: {
        fetchTietiePage: async (_visitorIdentifier, category) =>
          category === "say"
            ? {
                kind: "success",
                record: {
                  kind: "success",
                  contents: [
                    {
                      contentKey: "/say/content",
                      reactorIdentifiers: ["friend-a"],
                    },
                  ],
                  hasNextPage: false,
                },
              }
            : { kind: "parse-error" },
      },
      now: () => now,
    },
  });

  session.choose("tietie");
  await finished;

  assert.equal(lastMessage(), "“和我贴贴”获取失败，本次结果未更新");
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["friend-b", "friend-a"],
  );
  const reloaded = await openPersistentCache(storage, { now: () => now });
  assert.deepEqual(reloaded.tietieFor("visitor"), {
    counts: new Map([["friend-b", 5]]),
    fetchedAt: staleFetchedAt,
  });
  assert.equal(reloaded.tietieNeedsRefresh("visitor"), true);
});

test("和我贴贴任务中止时保留旧结果且不续期", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const storage = persistentFriendCacheStorage();
  const cache = await openPersistentCache(storage, { now: () => now });
  cache.replaceTietie("visitor", {
    counts: new Map([["friend", 4]]),
    fetchedAt: staleFetchedAt,
  });
  const { finished, lastMessage, lastState, session } = createSessionHarness({
    cache,
    friends: [{ userIdentifier: "friend", originalIndex: 0 }],
    runtime: {
      http: {
        fetchTietiePage: async (_visitorIdentifier, category) =>
          category === "say"
            ? { kind: "http-error", status: 429 }
            : {
                kind: "success",
                record: { kind: "empty", contents: [], hasNextPage: false },
              },
      },
      now: () => now,
    },
  });

  session.choose("tietie");
  await finished;

  assert.equal(lastMessage(), "请求受限，已停止全部获取");
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["friend"],
  );
  const reloaded = await openPersistentCache(storage, { now: () => now });
  assert.deepEqual(reloaded.tietieFor("visitor"), {
    counts: new Map([["friend", 4]]),
    fetchedAt: staleFetchedAt,
  });
  assert.equal(reloaded.tietieNeedsRefresh("visitor"), true);
});

test("和我贴贴没有旧结果且刷新失败时保持未知而非可靠零", async () => {
  const now = 100_000;
  const cache = createFriendCache(null, { now: () => now });
  const { finished, lastState, session } = createSessionHarness({
    cache,
    friends: [
      { userIdentifier: "friend-a", originalIndex: 0 },
      { userIdentifier: "friend-b", originalIndex: 1 },
    ],
    runtime: {
      http: {
        fetchTietiePage: async () => ({ kind: "parse-error" }),
      },
      now: () => now,
    },
  });

  session.choose("tietie");
  await finished;

  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["friend-a", "friend-b"],
  );
  assert.equal(cache.tietieFor("visitor"), undefined);
});

test("和我贴贴获取中切换方向和重复选择不重启任务", async () => {
  const requests = [];
  const pending = [];
  const { finished, lastState, session } = createSessionHarness({
    cache: createFriendCache(null),
    friends: [{ userIdentifier: "friend", originalIndex: 0 }],
    runtime: {
      http: {
        fetchTietiePage: async (_visitorIdentifier, category, page) => {
          requests.push([category, page]);
          return new Promise((resolve) => pending.push(resolve));
        },
      },
      now: () => 100_000,
    },
  });

  session.choose("tietie");
  session.changeDirection("asc");
  session.choose("tietie");

  assert.deepEqual(requests, [
    ["say", 1],
    ["subject", 1],
  ]);

  for (const resolve of pending) {
    resolve({
      kind: "success",
      record: { kind: "empty", contents: [], hasNextPage: false },
    });
  }
  await finished;

  assert.equal(lastState().criterion, "tietie");
  assert.equal(lastState().direction, "asc");
});

test("和我贴贴后台完成时不改变已切换的当前排序", async () => {
  const pending = [];
  const { finished, lastState, session } = createSessionHarness({
    cache: createFriendCache(null),
    friends: [
      { userIdentifier: "z", displayName: "Zed", originalIndex: 0 },
      { userIdentifier: "a", displayName: "Ada", originalIndex: 1 },
    ],
    runtime: {
      http: {
        fetchTietiePage: async () =>
          new Promise((resolve) => pending.push(resolve)),
      },
      now: () => 100_000,
    },
  });

  session.choose("tietie");
  session.choose("name");
  for (const resolve of pending) {
    resolve({
      kind: "success",
      record: { kind: "empty", contents: [], hasNextPage: false },
    });
  }
  await finished;

  assert.equal(lastState().criterion, "name");
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["a", "z"],
  );
});
