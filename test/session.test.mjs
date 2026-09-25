import test from "node:test";
import assert from "node:assert/strict";
import { createFriendCache } from "../src/cache.mjs";
import { initialize } from "../src/entry.mjs";
import {
  friendPageWith,
  mainSortControl,
  refreshCache,
  createSessionHarness,
  directionButtonsFor,
  timelineDocumentFromFixture,
} from "./support/index.mjs";

test("页面交互按排序维度记忆方向并仅重排当前缓存", () => {
  const page = friendPageWith([
    { href: "/user/z", name: "Zed" },
    { href: "/user/b", name: "Bob" },
    { href: "/user/a", name: "Ada" },
  ]);
  const previousDocument = global.document;
  const previousWindow = global.window;
  global.document = page.document;
  global.window = {
    localStorage: {
      getItem: () => null,
      removeItem() {},
      setItem() {},
    },
    location: { href: "https://bgm.tv/user/sai/friends" },
  };

  try {
    initialize();
  } finally {
    global.document = previousDocument;
    global.window = previousWindow;
  }

  const directionButtons = directionButtonsFor(page);
  const nameButton = mainSortControl(page, "名称");
  const addedButton = mainSortControl(page, "加好友时间");
  const activityButton = mainSortControl(page, "上次活跃");

  nameButton.click();
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["Ada", "Bob", "Zed"],
  );
  directionButtons[1].click();
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["Zed", "Bob", "Ada"],
  );
  addedButton.click();
  assert.deepEqual(
    directionButtons.map(({ textContent }) => textContent),
    ["从旧到新", "从新到旧"],
  );
  assert.equal(directionButtons[0].getAttribute("aria-current"), "true");
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["Zed", "Bob", "Ada"],
  );
  directionButtons[1].click();
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["Ada", "Bob", "Zed"],
  );
  nameButton.click();
  assert.equal(directionButtons[1].getAttribute("aria-current"), "true");
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["Zed", "Bob", "Ada"],
  );
});

test("上次活跃刷新完成后沿用刷新期间选择的方向", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "Ada" },
    { href: "/user/b", name: "Bob" },
  ]);
  const previousDocument = global.document;
  const previousWindow = global.window;
  const previousDomParser = global.DOMParser;
  const fetchedAt = Date.now();
  global.document = page.document;
  global.DOMParser = class {
    parseFromString() {
      return timelineDocumentFromFixture("timeline-active-seconds.html");
    }
  };
  global.window = {
    fetch: async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => "fixture",
    }),
    localStorage: {
      getItem(key) {
        if (key !== "bangumi-friend-sorter:activity-cache:v2") return null;
        return JSON.stringify({
          version: 2,
          records: {
            b: {
              kind: "active",
              activityAtSeconds: Date.UTC(2026, 7, 27) / 1_000,
              fetchedAt,
            },
          },
        });
      },
      removeItem() {},
      setItem() {},
    },
    location: { href: "https://bgm.tv/user/sai/friends" },
  };

  try {
    initialize();
    const directionButtons = directionButtonsFor(page);

    mainSortControl(page, "上次活跃").click();
    directionButtons[0].click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      page.list.children.map((item) => item.textContent),
      ["Ada", "Bob"],
    );
  } finally {
    global.document = previousDocument;
    global.window = previousWindow;
    global.DOMParser = previousDomParser;
  }
});

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
