import test from "node:test";
import assert from "node:assert/strict";
import * as sorter from "../src/legacy.mjs";
import { refreshCache } from "./support/index.mjs";

test("网页默认顺序默认从旧到新，也支持从新到旧", () => {
  const friends = [
    { userIdentifier: "third", displayName: "三", originalIndex: 2 },
    { userIdentifier: "first", displayName: "一", originalIndex: 0 },
    { userIdentifier: "second", displayName: "二", originalIndex: 1 },
  ];

  assert.deepEqual(
    sorter
      .sortFriends(friends, { criterion: "added" })
      .map(({ userIdentifier }) => userIdentifier),
    ["first", "second", "third"],
  );
  assert.deepEqual(
    sorter
      .sortFriends(friends, { criterion: "added", direction: "asc" })
      .map(({ userIdentifier }) => userIdentifier),
    ["first", "second", "third"],
  );
  assert.deepEqual(
    sorter
      .sortFriends(friends, { criterion: "added", direction: "desc" })
      .map(({ userIdentifier }) => userIdentifier),
    ["third", "second", "first"],
  );
});

test("名称排序支持升序和降序，同名保留传入顺序", () => {
  const friends = [
    { userIdentifier: "z", displayName: "user10", originalIndex: 0 },
    { userIdentifier: "b", displayName: "User2", originalIndex: 1 },
    { userIdentifier: "a", displayName: "user2", originalIndex: 2 },
  ];
  const collator = new Intl.Collator("en", {
    numeric: true,
    sensitivity: "base",
  });

  assert.deepEqual(
    sorter
      .sortFriends(friends, { criterion: "name", collator })
      .map(({ userIdentifier }) => userIdentifier),
    ["b", "a", "z"],
  );
  assert.deepEqual(
    sorter
      .sortFriends(friends, { criterion: "name", collator, direction: "desc" })
      .map(({ userIdentifier }) => userIdentifier),
    ["z", "b", "a"],
  );
});

test("数值排序的平局保留传入顺序而非网页默认顺序", () => {
  const friends = [
    { userIdentifier: "same-a", originalIndex: 4 },
    { userIdentifier: "high", originalIndex: 2 },
    { userIdentifier: "same-b", originalIndex: 1 },
    { userIdentifier: "unknown", originalIndex: 0 },
  ];
  const cache = refreshCache(sorter.createFriendCache(null), [
    ["same-a", { completion: { all: 5 }, fetchedAt: 1 }],
    ["high", { completion: { all: 10 }, fetchedAt: 1 }],
    ["same-b", { completion: { all: 5 }, fetchedAt: 1 }],
  ]);

  assert.deepEqual(
    sorter
      .sortFriends(friends, {
        criterion: "completion",
        completionScope: "all",
        direction: "desc",
        friendCache: cache,
      })
      .map(({ userIdentifier }) => userIdentifier),
    ["high", "same-a", "same-b", "unknown"],
  );
});

test("上次活跃支持从新到旧和从旧到新，未知活跃时间始终在后", () => {
  const friends = [
    { userIdentifier: "unknown", displayName: "未知", originalIndex: 0 },
    { userIdentifier: "older", displayName: "较早", originalIndex: 1 },
    { userIdentifier: "empty", displayName: "无动态", originalIndex: 2 },
    { userIdentifier: "newer-a", displayName: "较新甲", originalIndex: 3 },
    { userIdentifier: "newer-b", displayName: "较新乙", originalIndex: 4 },
  ];
  const activities = refreshCache(sorter.createFriendCache(null), [
    [
      "older",
      {
        activity: {
          kind: "active",
          activityAtSeconds: 1,
          fetchedAt: 4_000,
        },
      },
    ],
    ["empty", { activity: { kind: "empty", fetchedAt: 4_000 } }],
    [
      "newer-a",
      {
        activity: {
          kind: "active",
          activityAtSeconds: 2,
          fetchedAt: 4_000,
        },
      },
    ],
    [
      "newer-b",
      {
        activity: {
          kind: "active",
          activityAtSeconds: 2,
          fetchedAt: 4_000,
        },
      },
    ],
  ]);

  assert.deepEqual(
    sorter
      .sortFriends(friends, {
        criterion: "activity",
        friendCache: activities,
      })
      .map(({ userIdentifier }) => userIdentifier),
    ["newer-a", "newer-b", "older", "unknown", "empty"],
  );
  assert.deepEqual(
    sorter
      .sortFriends(friends, {
        criterion: "activity",
        friendCache: activities,
        direction: "asc",
      })
      .map(({ userIdentifier }) => userIdentifier),
    ["older", "newer-a", "newer-b", "unknown", "empty"],
  );
});

test("完成条目数按当前范围从高到低或从低到高稳定排序", () => {
  const friends = [
    { userIdentifier: "unknown", originalIndex: 0 },
    { userIdentifier: "same-b", originalIndex: 1 },
    { userIdentifier: "high", originalIndex: 2 },
    { userIdentifier: "zero", originalIndex: 3 },
    { userIdentifier: "same-a", originalIndex: 4 },
  ];
  const values = refreshCache(sorter.createFriendCache(null), [
    ["same-b", { completion: { all: 5 }, fetchedAt: 1 }],
    ["high", { completion: { all: 10 }, fetchedAt: 1 }],
    ["zero", { completion: { all: 0 }, fetchedAt: 1 }],
    ["same-a", { completion: { all: 5 }, fetchedAt: 1 }],
  ]);

  assert.deepEqual(
    sorter
      .sortFriends(friends, {
        criterion: "completion",
        friendCache: values,
        direction: "desc",
        completionScope: "all",
      })
      .map(({ userIdentifier }) => userIdentifier),
    ["high", "same-b", "same-a", "zero", "unknown"],
  );
  assert.deepEqual(
    sorter
      .sortFriends(friends, {
        criterion: "completion",
        friendCache: values,
        direction: "asc",
        completionScope: "all",
      })
      .map(({ userIdentifier }) => userIdentifier),
    ["zero", "same-b", "same-a", "high", "unknown"],
  );
});

test("喜好契合按访问者隔离并稳定排序可靠零和未知值", () => {
  const now = 10_000;
  const friends = [
    { userIdentifier: "unknown", originalIndex: 0 },
    { userIdentifier: "same-b", originalIndex: 1 },
    { userIdentifier: "high", originalIndex: 2 },
    { userIdentifier: "zero", originalIndex: 3 },
    { userIdentifier: "same-a", originalIndex: 4 },
  ];
  const cache = sorter.createFriendCache(null);
  refreshCache(
    cache,
    [
      ["same-b", { relation: { commonLikes: 5 }, fetchedAt: now }],
      ["high", { relation: { commonLikes: 10 }, fetchedAt: now }],
      ["zero", { relation: { commonLikes: 0 }, fetchedAt: now }],
      ["same-a", { relation: { commonLikes: 5 }, fetchedAt: now }],
    ],
    { visitorIdentifier: "visitor-a" },
  );
  refreshCache(
    cache,
    [["unknown", { relation: { commonLikes: 99 }, fetchedAt: now }]],
    { visitorIdentifier: "visitor-b" },
  );

  assert.deepEqual(
    sorter
      .sortFriends(friends, {
        criterion: "relation",
        relationSelection: {
          metric: "commonLikes",
          visitorIdentifier: "visitor-a",
        },
        friendCache: cache,
        direction: "desc",
      })
      .map(({ userIdentifier }) => userIdentifier),
    ["high", "same-b", "same-a", "zero", "unknown"],
  );
  assert.deepEqual(
    sorter
      .sortFriends(friends, {
        criterion: "relation",
        relationSelection: {
          metric: "commonLikes",
          visitorIdentifier: "visitor-a",
        },
        friendCache: cache,
        direction: "asc",
      })
      .map(({ userIdentifier }) => userIdentifier),
    ["zero", "same-b", "same-a", "high", "unknown"],
  );
  assert.deepEqual(
    sorter
      .sortFriends(friends, {
        criterion: "relation",
        relationSelection: {
          metric: "commonLikes",
          visitorIdentifier: "visitor-b",
        },
        friendCache: cache,
      })
      .map(({ userIdentifier }) => userIdentifier),
    ["unknown", "same-b", "high", "zero", "same-a"],
  );
});

test("同步率排序支持负值并按方向稳定排列", () => {
  const friends = [
    { userIdentifier: "negative", originalIndex: 0 },
    { userIdentifier: "same-a", originalIndex: 1 },
    { userIdentifier: "positive", originalIndex: 2 },
    { userIdentifier: "same-b", originalIndex: 3 },
    { userIdentifier: "zero", originalIndex: 4 },
  ];
  const cache = refreshCache(
    sorter.createFriendCache(null),
    [
      ["negative", { relation: { syncRate: -3.5 }, fetchedAt: 1 }],
      ["positive", { relation: { syncRate: 2.25 }, fetchedAt: 1 }],
      ["zero", { relation: { syncRate: 0 }, fetchedAt: 1 }],
      ["same-a", { relation: { syncRate: 1 }, fetchedAt: 1 }],
      ["same-b", { relation: { syncRate: 1 }, fetchedAt: 1 }],
    ],
    { visitorIdentifier: "visitor" },
  );

  assert.deepEqual(
    sorter
      .sortFriends(friends, {
        criterion: "relation",
        relationSelection: {
          metric: "syncRate",
          visitorIdentifier: "visitor",
        },
        friendCache: cache,
        direction: "desc",
      })
      .map(({ userIdentifier }) => userIdentifier),
    ["positive", "same-a", "same-b", "zero", "negative"],
  );
  assert.deepEqual(
    sorter
      .sortFriends(friends, {
        criterion: "relation",
        relationSelection: {
          metric: "syncRate",
          visitorIdentifier: "visitor",
        },
        friendCache: cache,
        direction: "asc",
      })
      .map(({ userIdentifier }) => userIdentifier),
    ["negative", "zero", "same-a", "same-b", "positive"],
  );
});
