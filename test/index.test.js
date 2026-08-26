const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sorter = require("../src/index.user.js");

function timelineDocumentFromFixture(filename) {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", filename), "utf8");
  const hasTimeline = /id=["']timeline["']/.test(html);
  const hasItem = /class=["'][^"']*\btml_item\b[^"']*["']/.test(html);
  const timestamp = html.match(/title=["']([^"']+)["'][^>]*class=["'][^"']*\btitleTip\b/);
  const timestampNode = timestamp
    ? { getAttribute: (name) => (name === "title" ? timestamp[1] : null) }
    : null;
  const itemNode = hasItem
    ? { querySelector: () => timestampNode }
    : null;
  const timelineNode = hasTimeline
    ? { querySelector: () => itemNode }
    : null;

  return {
    querySelector: (selector) => (selector === "#timeline" ? timelineNode : null),
  };
}

test("加好友时间排序恢复网页默认顺序", () => {
  const friends = [
    { userId: "third", displayName: "三", originalIndex: 2 },
    { userId: "first", displayName: "一", originalIndex: 0 },
    { userId: "second", displayName: "二", originalIndex: 1 },
  ];

  assert.deepEqual(
    sorter.sortFriends(friends, "added", new Map()).map(({ userId }) => userId),
    ["first", "second", "third"],
  );
});

test("名称排序使用展示名称自然升序并以用户主键决胜", () => {
  const friends = [
    { userId: "z", displayName: "user10", originalIndex: 0 },
    { userId: "b", displayName: "User2", originalIndex: 1 },
    { userId: "a", displayName: "user2", originalIndex: 2 },
  ];
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

  assert.deepEqual(
    sorter.sortFriends(friends, "name", new Map(), collator).map(({ userId }) => userId),
    ["a", "b", "z"],
  );
});

test("上次活跃按时间从近到远且其余好友保持网页相对顺序", () => {
  const friends = [
    { userId: "unknown", displayName: "未知", originalIndex: 0 },
    { userId: "older", displayName: "较早", originalIndex: 1 },
    { userId: "empty", displayName: "无动态", originalIndex: 2 },
    { userId: "newer-a", displayName: "较新甲", originalIndex: 3 },
    { userId: "newer-b", displayName: "较新乙", originalIndex: 4 },
  ];
  const activities = new Map([
    ["older", { kind: "active", activityAt: 1_000, fetchedAt: 4_000 }],
    ["empty", { kind: "empty", fetchedAt: 4_000 }],
    ["newer-a", { kind: "active", activityAt: 2_000, fetchedAt: 4_000 }],
    ["newer-b", { kind: "active", activityAt: 2_000, fetchedAt: 4_000 }],
  ]);

  assert.deepEqual(
    sorter.sortFriends(friends, "activity", activities).map(({ userId }) => userId),
    ["newer-a", "newer-b", "older", "unknown", "empty"],
  );
});

test("仅为缺失或超过二十四小时的活跃缓存安排请求", () => {
  const hour = 60 * 60 * 1_000;
  const now = 30 * hour;
  const friends = [
    { userId: "fresh-active" },
    { userId: "fresh-empty" },
    { userId: "boundary" },
    { userId: "stale" },
    { userId: "missing" },
  ];
  const activities = new Map([
    ["fresh-active", { kind: "active", activityAt: 10, fetchedAt: now - hour }],
    ["fresh-empty", { kind: "empty", fetchedAt: now - hour }],
    ["boundary", { kind: "active", activityAt: 20, fetchedAt: now - 24 * hour }],
    ["stale", { kind: "active", activityAt: 30, fetchedAt: now - 24 * hour - 1 }],
  ]);

  assert.deepEqual(
    sorter.findFriendsNeedingActivity(friends, activities, now).map(({ userId }) => userId),
    ["stale", "missing"],
  );
});

test("从时间胶囊首条动态读取精确的上次活跃时间", () => {
  const document = timelineDocumentFromFixture("timeline-active.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), {
    kind: "active",
    activityAt: new Date(2026, 6, 4, 14, 37).getTime(),
  });
});

test("上次活跃时间保留页面提供的秒级精度", () => {
  const document = timelineDocumentFromFixture("timeline-active-seconds.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), {
    kind: "active",
    activityAt: new Date(2026, 7, 26, 17, 42, 34).getTime(),
  });
});

test("有效的空时间胶囊被识别为无公开动态", () => {
  const document = timelineDocumentFromFixture("timeline-empty.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), { kind: "empty" });
});

test("仅在本次待请求人数超过四百时要求确认", () => {
  assert.equal(sorter.needsLargeRequestConfirmation(400), false);
  assert.equal(sorter.needsLargeRequestConfirmation(401), true);
});

test("收到限流响应时立即停止活跃请求批次", () => {
  const state = sorter.nextBatchState(
    { consecutiveServerFailures: 0, stopped: false },
    { kind: "http-error", status: 429 },
  );

  assert.deepEqual(state, { consecutiveServerFailures: 0, stopped: true });
});

test("连续五个禁止或服务端响应才停止批次且成功响应会重置计数", () => {
  let state = { consecutiveServerFailures: 0, stopped: false };
  for (const status of [403, 500, 502, 503]) {
    state = sorter.nextBatchState(state, { kind: "http-error", status });
  }
  assert.deepEqual(state, { consecutiveServerFailures: 4, stopped: false });

  state = sorter.nextBatchState(state, { kind: "success" });
  assert.deepEqual(state, { consecutiveServerFailures: 0, stopped: false });

  for (const status of [500, 403, 500, 502, 503]) {
    state = sorter.nextBatchState(state, { kind: "http-error", status });
  }
  assert.deepEqual(state, { consecutiveServerFailures: 5, stopped: true });
});

test("持久存储不可用时活跃缓存仍在当前页面内工作", () => {
  const unavailableStorage = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    },
  };
  const cache = sorter.createActivityCache(unavailableStorage);
  const record = { kind: "active", activityAt: 1_000, fetchedAt: 2_000 };

  cache.set("sai", record);

  assert.equal(cache.get("sai"), record);
  assert.deepEqual([...cache.entries()], [["sai", record]]);
});
