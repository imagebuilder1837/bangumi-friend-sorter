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
test("和 TA 贴贴完整获取成功后持久化全部统计结果", async () => {
  const now = 100_000;
  const storage = persistentFriendCacheStorage();
  const cache = await openPersistentCache(storage, { now: () => now });
  const requests = [];
  const { finished, session } = createSessionHarness({
    cache,
    friends: [
      { userIdentifier: "friend-a", originalIndex: 0 },
      { userIdentifier: "friend-b", originalIndex: 1 },
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
  await finished;

  assert.deepEqual(requests, ["say", "subject"]);
  const reloaded = await openPersistentCache(storage, { now: () => now });
  assert.deepEqual(reloaded.tietieFor("visitor"), {
    counts: new Map([
      ["friend-a", 1],
      ["friend-b", 1],
    ]),
    fetchedAt: now,
  });
});

test("和 TA 贴贴前页有结果且末页省略动态容器时仍发布完整统计", async () => {
  const now = 100_000;
  const cache = createFriendCache(null, { now: () => now });
  cache.replaceTietie("visitor", {
    counts: new Map([["friend-a", 99]]),
    fetchedAt: now - 72 * 60 * 60 * 1_000 - 1,
  });
  const documents = new Map([
    ["say:1", "timeline-tietie.html"],
    ["subject:1", "timeline-tietie.html"],
    ["say:2", "timeline-tietie-empty-no-container.html"],
    ["subject:2", "timeline-tietie-empty-subject-no-container.html"],
  ]);
  const requests = [];
  const { finished, lastMessage, session } = createSessionHarness({
    cache,
    friends: [
      { userIdentifier: "friend-a", originalIndex: 0 },
      { userIdentifier: "friend-b", originalIndex: 1 },
      { userIdentifier: "friend-c", originalIndex: 2 },
    ],
    runtime: {
      http: {
        fetchTietiePage: async (_visitorIdentifier, category, page) => {
          requests.push(`${category}:${page}`);
          const filename = documents.get(`${category}:${page}`);
          assert.ok(filename);
          const record = parseTietieTimelineDocument(
            documentFromFixture(filename),
            {
              baseUrl: `https://bgm.tv/user/visitor/timeline?type=${category}`,
              category,
              page,
            },
          );
          return { kind: "success", record };
        },
      },
      now: () => now,
    },
  });

  session.choose("tietie");
  await finished;

  assert.equal(lastMessage(), "“和 TA 贴贴”获取完成");
  assert.deepEqual(requests, ["say:1", "subject:1", "say:2", "subject:2"]);
  assert.deepEqual(cache.tietieFor("visitor"), {
    counts: new Map([
      ["friend-a", 3],
      ["friend-b", 6],
      ["friend-c", 2],
      ["unknown", 1],
    ]),
    fetchedAt: now,
  });
});

test("和 TA 贴贴按内容链接、动态和反应容器标识逐级去重", async () => {
  const cache = createFriendCache(null);
  const { finished, session } = createSessionHarness({
    cache,
    friends: [{ userIdentifier: "friend", originalIndex: 0 }],
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
                      contentKey: "/subject/linked",
                      dynamicIdentifier: "tml_1",
                      reactionContainerIdentifier: "likes_grid_1",
                      reactorIdentifiers: ["friend"],
                    },
                    {
                      contentKey: "/subject/linked",
                      dynamicIdentifier: "tml_1",
                      reactionContainerIdentifier: "likes_grid_2",
                      reactorIdentifiers: ["friend"],
                    },
                    {
                      contentKey: null,
                      dynamicIdentifier: "tml_1",
                      reactionContainerIdentifier: "likes_grid_3",
                      reactorIdentifiers: ["friend"],
                    },
                    {
                      contentKey: "/subject/different",
                      dynamicIdentifier: "tml_1",
                      reactionContainerIdentifier: "likes_grid_4",
                      reactorIdentifiers: ["friend"],
                    },
                    {
                      contentKey: null,
                      dynamicIdentifier: null,
                      reactionContainerIdentifier: "likes_grid_5",
                      reactorIdentifiers: ["friend"],
                    },
                    {
                      contentKey: null,
                      dynamicIdentifier: null,
                      reactionContainerIdentifier: "likes_grid_5",
                      reactorIdentifiers: ["friend"],
                    },
                    {
                      contentKey: null,
                      dynamicIdentifier: null,
                      reactionContainerIdentifier: null,
                      reactorIdentifiers: ["friend"],
                    },
                    {
                      contentKey: null,
                      dynamicIdentifier: null,
                      reactionContainerIdentifier: null,
                      reactorIdentifiers: ["friend"],
                    },
                    {
                      contentKey: null,
                      dynamicIdentifier: "tml_6a",
                      reactionContainerIdentifier: "likes_grid_6",
                      reactorIdentifiers: ["friend"],
                    },
                    {
                      contentKey: null,
                      dynamicIdentifier: "tml_6b",
                      reactionContainerIdentifier: "likes_grid_6",
                      reactorIdentifiers: ["friend"],
                    },
                  ],
                  hasNextPage: false,
                },
              }
            : {
                kind: "success",
                record: { kind: "empty", contents: [], hasNextPage: false },
              },
      },
      now: () => 100_000,
    },
  });

  session.choose("tietie");
  await finished;

  assert.deepEqual(cache.tietieFor("visitor"), {
    counts: new Map([["friend", 7]]),
    fetchedAt: 100_000,
  });
});

test("和 TA 贴贴每个分类最多获取五页", async () => {
  const pages = [];
  const { finished, session } = createSessionHarness({
    cache: createFriendCache(null),
    friends: [{ userIdentifier: "friend", originalIndex: 0 }],
    runtime: {
      http: {
        fetchTietiePage: async (_visitorIdentifier, category, page) => {
          pages.push([category, page]);
          return {
            kind: "success",
            record: {
              kind: "success",
              contents: [
                {
                  contentKey: `${category}/${page}`,
                  reactorIdentifiers: ["friend"],
                },
              ],
              hasNextPage: true,
            },
          };
        },
      },
      now: () => 100_000,
    },
  });

  session.choose("tietie");
  await finished;

  assert.deepEqual(pages, [
    ["say", 1],
    ["subject", 1],
    ["say", 2],
    ["subject", 2],
    ["say", 3],
    ["subject", 3],
    ["say", 4],
    ["subject", 4],
    ["say", 5],
    ["subject", 5],
  ]);
});

test("和 TA 贴贴任一分类失败时不发布部分计数", async () => {
  const friends = [
    { userIdentifier: "first", originalIndex: 0 },
    { userIdentifier: "second", originalIndex: 1 },
  ];
  const { finished, lastMessage, lastState, session } = createSessionHarness({
    cache: createFriendCache(null),
    friends,
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
                      contentKey: "/user/visitor/timeline/status/1",
                      reactorIdentifiers: ["second"],
                    },
                  ],
                  hasNextPage: false,
                },
              }
            : { kind: "parse-error" },
      },
      now: () => 100_000,
    },
  });

  session.choose("tietie");
  await finished;

  assert.equal(lastMessage(), "“和 TA 贴贴”获取失败，本次结果未更新");
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["first", "second"],
  );
});

test("和 TA 贴贴收到 429 时停止并保持未完成结果未知", async () => {
  const { finished, lastMessage, lastState, session } = createSessionHarness({
    cache: createFriendCache(null),
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
      now: () => 100_000,
    },
  });

  session.choose("tietie");
  await finished;

  assert.equal(lastMessage(), "请求受限，已停止全部获取");
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["friend"],
  );
});
