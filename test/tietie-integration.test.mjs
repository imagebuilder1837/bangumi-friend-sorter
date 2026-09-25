import test from "node:test";
import assert from "node:assert/strict";
import { createFriendCache } from "../src/cache.mjs";
import { initialize } from "../src/entry.mjs";
import { parseTietieTimelineDocument } from "../src/tietie-parser.mjs";
import { friendPageWith } from "./support/dom.mjs";
import {
  statusFor,
  mainSortControl,
  directionButtonsFor,
} from "./support/sort-bar.mjs";
import { persistentFriendCacheStorage } from "./support/cache.mjs";
import {
  initializeRefreshPage,
  createSessionHarness,
} from "./support/session.mjs";
import { waitForCondition, fakeTimers } from "./support/timing.mjs";
import {
  timelineDocumentFromFixture,
  tietieDocumentFromFixture,
} from "./support/timeline.mjs";

test("和我贴贴完整结果跨缓存重建保存全部反应者并遵守七十二小时边界", () => {
  const hour = 60 * 60 * 1_000;
  const now = 100 * hour;
  const fetchedAt = now - 72 * hour;
  const storage = persistentFriendCacheStorage();
  const cache = createFriendCache(storage, { now: () => now });

  cache.replaceTietie("visitor", {
    counts: new Map([
      ["friend-a", 3],
      ["friend-b", 1],
    ]),
    fetchedAt,
  });

  const reloaded = createFriendCache(storage, { now: () => now });

  assert.deepEqual(reloaded.tietieFor("visitor"), {
    counts: new Map([
      ["friend-a", 3],
      ["friend-b", 1],
    ]),
    fetchedAt,
  });
  assert.equal(reloaded.tietieNeedsRefresh("visitor"), false);

  const expired = createFriendCache(storage, {
    now: () => now + 1,
  });
  assert.equal(expired.tietieNeedsRefresh("visitor"), true);
});

test("和我贴贴使用当前访问者身份并从吐槽和收藏第一页开始获取", async () => {
  const requests = [];
  const page = initializeRefreshPage({
    entries: [{ href: "/user/friend", name: "好友" }],
    now: 1_000,
    domParser: {
      parseFromString: () => timelineDocumentFromFixture("timeline-empty.html"),
    },
    fetchImpl: async (url) => {
      requests.push(url);
      return {
        ok: true,
        headers: { get: () => null },
        text: async () => "empty timeline",
      };
    },
  });

  mainSortControl(page, "和我贴贴").click();
  await waitForCondition(() => requests.length === 2);

  assert.deepEqual(requests, [
    "/user/visitor/timeline?type=say",
    "/user/visitor/timeline?type=subject",
  ]);
});

test("未登录时选择和我贴贴只提示登录且不发起请求", () => {
  const requests = [];
  const page = initializeRefreshPage({
    entries: [{ href: "/user/friend", name: "好友" }],
    now: 100_000,
    visitorIdentifier: "",
    domParser: {
      parseFromString: () => timelineDocumentFromFixture("timeline-empty.html"),
    },
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: true, text: async () => "empty" };
    },
  });

  mainSortControl(page, "和我贴贴").click();

  assert.deepEqual(requests, []);
  assert.equal(statusFor(page).textContent, "请登录后使用和我贴贴排序");
});

test("和我贴贴完整获取后按内容链接去重并稳定排序可靠零", async () => {
  const requests = [];
  const page = initializeRefreshPage({
    entries: [
      { href: "/user/friend-a", name: "甲" },
      { href: "/user/friend-b", name: "乙" },
      { href: "/user/friend-c", name: "丙" },
      { href: "/user/missing", name: "零" },
    ],
    now: 100_000,
    domParser: {
      parseFromString: () => tietieDocumentFromFixture("timeline-tietie.html"),
    },
    fetchImpl: async (url) => {
      requests.push(url);
      return {
        ok: true,
        headers: { get: () => null },
        text: async () => "fixture",
      };
    },
  });

  mainSortControl(page, "和我贴贴").click();
  await waitForCondition(() => requests.length > 0);
  await waitForCondition(() =>
    /获取完成|获取失败/.test(statusFor(page).textContent),
  );
  assert.equal(statusFor(page).textContent, "“和我贴贴”获取完成");
  assert.deepEqual(requests, [
    "/user/visitor/timeline?type=say",
    "/user/visitor/timeline?type=subject",
    "/user/visitor/timeline?type=say&page=2",
    "/user/visitor/timeline?type=subject&page=2",
  ]);

  assert.deepEqual(
    page.list.children.map(({ textContent }) => textContent),
    ["乙", "甲", "丙", "零"],
  );

  const directionButtons = directionButtonsFor(page);
  directionButtons[0].click();
  assert.deepEqual(
    page.list.children.map(({ textContent }) => textContent),
    ["零", "丙", "甲", "乙"],
  );
});

test("和我贴贴完整获取成功后持久化全部统计结果", async () => {
  const now = 100_000;
  const storage = persistentFriendCacheStorage();
  const cache = createFriendCache(storage, { now: () => now });
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
  const reloaded = createFriendCache(storage, { now: () => now });
  assert.deepEqual(reloaded.tietieFor("visitor"), {
    counts: new Map([
      ["friend-a", 1],
      ["friend-b", 1],
    ]),
    fetchedAt: now,
  });
});

test("和我贴贴前页有结果且末页省略动态容器时仍发布完整统计", async () => {
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
            tietieDocumentFromFixture(filename),
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

  assert.equal(lastMessage(), "“和我贴贴”获取完成");
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
            tietieDocumentFromFixture(filename),
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

test("和我贴贴按内容链接、动态和反应容器标识逐级去重", async () => {
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

test("和我贴贴有效缓存直接排序并跨好友列表复用而不发起任务", () => {
  const now = 100_000;
  const storage = persistentFriendCacheStorage();
  const cache = createFriendCache(storage, { now: () => now });
  cache.replaceTietie("visitor", {
    counts: new Map([
      ["friend-b", 5],
      ["outside-list", 3],
    ]),
    fetchedAt: now,
  });

  const requests = [];
  const first = createSessionHarness({
    cache: createFriendCache(storage, { now: () => now }),
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
    cache: createFriendCache(storage, { now: () => now }),
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

test("和我贴贴有效缓存两击后强制刷新，待命五秒后重新开始", async () => {
  const clock = fakeTimers();
  const requests = [];
  const storage = persistentFriendCacheStorage(
    JSON.stringify({
      version: 3,
      records: {},
      tietie: {
        visitor: {
          counts: { friend: 1 },
          fetchedAt: 0,
        },
      },
    }),
  );
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage,
    now: clock.now,
    setTimeout: clock.setTimer,
    clearTimeout: clock.clearTimer,
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
                reactorIdentifiers: ["friend"],
              },
            ],
            hasNextPage: false,
          },
        };
      },
    },
  });

  const button = mainSortControl(page, "和我贴贴");
  const status = statusFor(page);

  button.click();
  assert.equal(status.textContent, "");
  assert.deepEqual(requests, []);

  button.click();
  assert.equal(status.textContent, "5 秒内再次点击“和我贴贴”以全量刷新");
  await clock.advance(5_000);
  assert.equal(status.textContent, "");

  button.click();
  assert.equal(status.textContent, "5 秒内再次点击“和我贴贴”以全量刷新");
  clock.setNow(6_000);
  button.click();
  await waitForCondition(() => status.textContent.includes("获取完成"));

  assert.deepEqual(requests, ["say", "subject"]);
  assert.equal(status.textContent, "“和我贴贴”获取完成");
  button.click();
  assert.equal(status.textContent, "“和我贴贴”获取完成");
  await clock.advance(5_000);
  assert.equal(status.textContent, "");
  button.click();
  assert.equal(status.textContent, "5 秒内再次点击“和我贴贴”以全量刷新");
  const reloaded = createFriendCache(storage, { now: clock.now });
  assert.deepEqual(reloaded.tietieFor("visitor"), {
    counts: new Map([["friend", 2]]),
    fetchedAt: 6_000,
  });
});

test("和我贴贴主动刷新失败时保留旧结果和获取时间", async () => {
  const now = 100_000;
  const storage = persistentFriendCacheStorage(
    JSON.stringify({
      version: 3,
      records: {},
      tietie: {
        visitor: {
          counts: { friend: 4 },
          fetchedAt: now,
        },
      },
    }),
  );
  const requests = [];
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage,
    now: () => now,
    setTimeout: () => 1,
    clearTimeout() {},
    http: {
      fetchTietiePage: async (_visitorIdentifier, category) => {
        requests.push(category);
        if (category === "subject") return { kind: "parse-error" };
        return {
          kind: "success",
          record: {
            kind: "success",
            contents: [
              {
                contentKey: "/say/new-content",
                reactorIdentifiers: ["friend"],
              },
            ],
            hasNextPage: false,
          },
        };
      },
    },
  });

  const button = mainSortControl(page, "和我贴贴");
  const status = statusFor(page);
  button.click();
  button.click();
  button.click();
  await waitForCondition(() => status.textContent.includes("获取失败"));

  assert.deepEqual(requests, ["say", "subject"]);
  assert.equal(status.textContent, "“和我贴贴”获取失败，本次结果未更新");
  const reloaded = createFriendCache(storage, { now: () => now });
  assert.deepEqual(reloaded.tietieFor("visitor"), {
    counts: new Map([["friend", 4]]),
    fetchedAt: now,
  });
});

test("和我贴贴过期时先排旧结果，成功后整体替换并继承刷新前平局顺序", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const storage = persistentFriendCacheStorage();
  const cache = createFriendCache(storage, { now: () => now });
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
  const reloaded = createFriendCache(storage, { now: () => now });
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
  const cache = createFriendCache(storage, { now: () => now });
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
  const reloaded = createFriendCache(storage, { now: () => now });
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
  const cache = createFriendCache(storage, { now: () => now });
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
  const reloaded = createFriendCache(storage, { now: () => now });
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

test("和我贴贴缓存按访问者隔离，损坏记录不影响已有主页字段", () => {
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

test("和我贴贴持久化写入不可用时保留当前页面结果且不破坏主页字段", () => {
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
      });
    },
    setItem() {
      throw new Error("quota exceeded");
    },
    removeItem() {},
  };
  const cache = createFriendCache(storage, { now: () => now });

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
});

test("和我贴贴每个分类最多获取五页", async () => {
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

test("和我贴贴任一分类失败时不发布部分计数", async () => {
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

  assert.equal(lastMessage(), "“和我贴贴”获取失败，本次结果未更新");
  assert.deepEqual(
    lastState().orderedFriends.map(({ userIdentifier }) => userIdentifier),
    ["first", "second"],
  );
});

test("和我贴贴收到 429 时停止并保持未完成结果未知", async () => {
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
