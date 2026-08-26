const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sorter = require("../src/index.user.js");

function timelineDocumentFromFixture(filename) {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", filename), "utf8");
  const hasTimeline = /id=["']timeline["']/.test(html);
  const hasTimelineTabs = /id=["']timelineTabs["']/.test(html);
  const hasTimelineContent = /id=["']tmlContent["'][^>]*>\s*<div id=["']timeline["']/.test(
    html,
  );
  const item = html.match(
    /<li[^>]*class=["'][^"']*\btml_item\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/,
  );
  const hasItem = item !== null;
  const timestamp = item?.[1].match(
    /<div[^>]*class=["'][^"']*\bpost_actions\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*title=["']([^"']+)["'][^>]*class=["'][^"']*\btitleTip\b[^"']*["'][^>]*>([^<]*)</,
  );
  const timestampNode = timestamp
    ? {
        getAttribute: (name) => (name === "title" ? timestamp[1] : null),
        textContent: timestamp[2],
      }
    : null;
  const itemNode = hasItem
    ? {
        querySelector(selector) {
          assert.equal(selector, ".post_actions .titleTip[title]");
          return timestampNode;
        },
      }
    : null;
  const timelineNode = hasTimeline
    ? {
        querySelector(selector) {
          assert.equal(selector, ".tml_item");
          return itemNode;
        },
        textContent: hasItem ? "动态内容" : "",
      }
    : null;

  return {
    querySelector(selector) {
      if (selector === "#timeline") return timelineNode;
      if (selector === "#timelineTabs") return hasTimelineTabs ? {} : null;
      if (selector === "#tmlContent > #timeline") {
        return hasTimelineContent ? timelineNode : null;
      }
      assert.fail(`unexpected selector: ${selector}`);
    },
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
    ["older", { kind: "active", activityAtSeconds: 1, fetchedAt: 4_000 }],
    ["empty", { kind: "empty", fetchedAt: 4_000 }],
    ["newer-a", { kind: "active", activityAtSeconds: 2, fetchedAt: 4_000 }],
    ["newer-b", { kind: "active", activityAtSeconds: 2, fetchedAt: 4_000 }],
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
    ["fresh-active", { kind: "active", activityAtSeconds: 10, fetchedAt: now - hour }],
    ["fresh-empty", { kind: "empty", fetchedAt: now - hour }],
    ["boundary", { kind: "active", activityAtSeconds: 20, fetchedAt: now - 24 * hour }],
    ["stale", { kind: "active", activityAtSeconds: 30, fetchedAt: now - 24 * hour - 1 }],
  ]);

  assert.deepEqual(
    sorter.findFriendsNeedingActivity(friends, activities, now).map(({ userId }) => userId),
    ["stale", "missing"],
  );
});

test("从时间胶囊首条动态读取活跃时刻", () => {
  const document = timelineDocumentFromFixture("timeline-active.html");

  assert.deepEqual(
    sorter.parseTimelineDocument(document, Date.UTC(2026, 7, 26, 6, 37, 34) / 1_000),
    {
      kind: "active",
      activityAtSeconds: Date.UTC(2026, 6, 4, 6, 37) / 1_000,
    },
  );
});

test("省略秒的大单位文案不推测更小单位", () => {
  const document = timelineDocumentFromFixture("timeline-active.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 6, 4, 6, 37) / 1_000,
  });
});

test("上次活跃时间保留页面提供的秒级精度", () => {
  const document = timelineDocumentFromFixture("timeline-active-seconds.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
  });
});

test("刚刚按参考时间恢复秒数并保持绝对分钟", () => {
  const document = timelineDocumentFromFixture("timeline-active-just-now.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
  });
});

test("相对秒数与绝对分钟冲突时回退到分钟起点", () => {
  const document = timelineDocumentFromFixture("timeline-active-seconds.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 44, 36) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42) / 1_000,
  });
});

test("有效的空时间胶囊被识别为无公开动态", () => {
  const document = timelineDocumentFromFixture("timeline-empty.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), { kind: "empty" });
});

test("只有孤立时间线容器的残缺页面被识别为失败", () => {
  const document = timelineDocumentFromFixture("timeline-partial.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), { kind: "invalid" });
});

test("首条动态缺失精确时间时被识别为失败", () => {
  const document = timelineDocumentFromFixture("timeline-missing-time.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), { kind: "invalid" });
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
  const record = { kind: "active", activityAtSeconds: 1, fetchedAt: 2_000 };

  cache.set("sai", record);

  assert.equal(cache.get("sai"), record);
  assert.deepEqual([...cache.entries()], [["sai", record]]);
});

test("升级缓存版本时删除旧版缓存而不迁移分钟级结果", () => {
  const removedKeys = [];
  const storage = {
    getItem(key) {
      if (key === "bangumi-friend-sorter:activity-cache:v1") {
        return JSON.stringify({
          version: 1,
          records: {
            sai: { kind: "active", activityAt: 1_000, fetchedAt: 2_000 },
          },
        });
      }
      return null;
    },
    removeItem(key) {
      removedKeys.push(key);
    },
    setItem() {},
  };

  const cache = sorter.createActivityCache(storage);

  assert.deepEqual([...cache.entries()], []);
  assert.deepEqual(removedKeys, ["bangumi-friend-sorter:activity-cache:v1"]);
});

test("请求响应头的时间按整秒传给活跃时间解析并写入秒级缓存", async () => {
  const document = timelineDocumentFromFixture("timeline-active-seconds.html");
  const records = [];
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36);

  await sorter.refreshActivities([{ userId: "sai" }], {
    cache: {
      persist() {},
      set(userId, record) {
        records.push([userId, record]);
      },
    },
    domParser: { parseFromString: () => document },
    fetchImpl: async () => ({
      ok: true,
      headers: { get: (name) => (name === "date" ? new Date(responseTime).toUTCString() : null) },
      text: async () => "fixture",
    }),
    now: () => responseTime,
    onProgress() {},
  });

  assert.deepEqual(records, [[
    "sai",
    {
      kind: "active",
      activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
      fetchedAt: responseTime,
    },
  ]]);
});

test("时间胶囊返回四零四时计入失败且不覆盖缓存", async () => {
  let cacheWrites = 0;
  const progress = [];

  const result = await sorter.refreshActivities([{ userId: "missing" }], {
    cache: {
      persist() {},
      set() {
        cacheWrites += 1;
      },
    },
    domParser: {},
    fetchImpl: async () => ({ ok: false, status: 404 }),
    now: () => 1_000,
    onProgress: (completed, total) => progress.push([completed, total]),
  });

  assert.deepEqual(result, { failures: 1 });
  assert.equal(cacheWrites, 0);
  assert.deepEqual(progress, [[1, 1]]);
});
