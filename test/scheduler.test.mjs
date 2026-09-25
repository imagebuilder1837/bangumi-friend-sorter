import test from "node:test";
import assert from "node:assert/strict";
import { createTaskScheduler } from "../src/scheduler.mjs";
import { initialize } from "../src/entry.mjs";
import { friendPageWith } from "./support/dom.mjs";
import { mainSortControl, dropdownButtonFor } from "./support/sort-bar.mjs";
import { storedCompletion } from "./support/cache.mjs";
import { waitForCondition } from "./support/timing.mjs";
import { timelineDocumentFromFixture } from "./support/timeline.mjs";
import { profileStatsDocument } from "./support/profile.mjs";

test("页面任务调度器在全局四槽位内优先前台任务且不取消在途请求", async () => {
  const scheduler = createTaskScheduler({ concurrency: 4 });
  const started = [];
  const pending = new Map();
  const fetchPage = (type) => (item) =>
    new Promise((resolve) => {
      started.push(`${type}:${item}`);
      pending.set(`${type}:${item}`, resolve);
    });
  const taskOptions = (type) => ({
    confirmMessage: () => "",
    fetch: fetchPage(type),
    isSuccess: () => true,
    keyFor: (item) => item,
    lifecycle: {},
  });

  scheduler.enqueue(
    "activity",
    ["a1", "a2", "a3", "a4", "a5"],
    taskOptions("activity"),
    { foreground: true },
  );
  scheduler.enqueue("profile", ["p1", "p2"], taskOptions("profile"), {
    foreground: true,
  });

  assert.deepEqual(started, [
    "activity:a1",
    "activity:a2",
    "activity:a3",
    "activity:a4",
  ]);

  pending.get("activity:a1")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [
    "activity:a1",
    "activity:a2",
    "activity:a3",
    "activity:a4",
    "profile:p1",
  ]);

  pending.get("profile:p1")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [
    "activity:a1",
    "activity:a2",
    "activity:a3",
    "activity:a4",
    "profile:p1",
    "profile:p2",
  ]);

  for (const key of [
    "activity:a2",
    "activity:a3",
    "activity:a4",
    "profile:p2",
  ]) {
    pending.get(key)({ kind: "success" });
  }
  await new Promise((resolve) => setImmediate(resolve));
  pending.get("activity:a5")?.({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(scheduler.getInFlightCount(), 0);
  assert.equal(scheduler.getTask("activity"), null);
  assert.equal(scheduler.getTask("profile"), null);
});

test("前台队列耗尽但仍有在途请求时不会恢复后台任务", async () => {
  const scheduler = createTaskScheduler({ concurrency: 2 });
  const pending = new Map();
  const started = [];
  const options = (type) => ({
    confirmMessage: () => "",
    fetch: (item) =>
      new Promise((resolve) => {
        started.push(`${type}:${item}`);
        pending.set(`${type}:${item}`, resolve);
      }),
    isSuccess: () => true,
    keyFor: (item) => item,
    lifecycle: {},
  });

  scheduler.enqueue("activity", ["a1", "a2", "a3"], options("activity"), {
    foreground: true,
  });
  scheduler.enqueue("profile", ["p1", "p2"], options("profile"), {
    foreground: true,
  });

  pending.get("activity:a1")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["activity:a1", "activity:a2", "profile:p1"]);

  pending.get("profile:p1")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [
    "activity:a1",
    "activity:a2",
    "profile:p1",
    "profile:p2",
  ]);

  pending.get("activity:a2")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [
    "activity:a1",
    "activity:a2",
    "profile:p1",
    "profile:p2",
  ]);

  pending.get("profile:p2")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [
    "activity:a1",
    "activity:a2",
    "profile:p1",
    "profile:p2",
    "activity:a3",
  ]);

  pending.get("activity:a3")({ kind: "success" });
  await new Promise((resolve) => setImmediate(resolve));
});

test("全量刷新扩充进行中的同页面类型任务且不重试已尝试好友", async () => {
  const scheduler = createTaskScheduler({ concurrency: 1 });
  const started = [];
  const pending = new Map();
  const finished = [];
  const fetch = (item) =>
    new Promise((resolve) => {
      started.push(item);
      pending.set(item, resolve);
    });
  const options = (target) => ({
    confirmMessage: () => "",
    fetch,
    isSuccess: (record, outcome) => outcome.kind === "success" && record,
    keyFor: (item) => item,
    lifecycle: {
      onFinished: (result) => finished.push(result),
    },
    target,
  });

  // Incremental task: p1's field parse fails; p2 stays in flight so the
  // task survives until the full-refresh expansion arrives.
  scheduler.enqueue("profile", ["p1", "p2"], options("syncRate"), {
    foreground: true,
  });
  pending.get("p1")({ kind: "parse-error" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["p1", "p2"]);

  // A full refresh requests every friend against the same running task:
  // already attempted (including parse-failed) and queued friends are not
  // re-added, only genuinely new ones join the union.
  scheduler.enqueue("profile", ["p1", "p2", "p3"], options("full"));
  assert.deepEqual(started, ["p1", "p2"]);

  pending.get("p2")({ kind: "success", record: { value: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["p1", "p2", "p3"]);

  pending.get("p3")({ kind: "success", record: { value: 2 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.getTask("profile"), null);
  assert.deepEqual(finished, [
    {
      completed: 3,
      failures: 1,
      globallyStopped: false,
      stopped: false,
      target: "full",
      total: 3,
    },
  ]);
});

test("页面任务调度器收到 429 时停止所有任务并统计未尝试好友", async () => {
  const scheduler = createTaskScheduler({ concurrency: 4 });
  const pending = new Map();
  const finished = [];
  const fetchPage = (type) => (item) =>
    new Promise((resolve) => pending.set(`${type}:${item}`, resolve));
  const options = (type) => ({
    confirmMessage: () => "",
    fetch: fetchPage(type),
    isSuccess: (record, outcome) => outcome.kind === "success" && record,
    keyFor: (item) => item,
    lifecycle: {
      onFinished: (result) => finished.push([type, result]),
    },
  });

  scheduler.enqueue(
    "activity",
    ["a1", "a2", "a3", "a4", "a5"],
    options("activity"),
    { foreground: true },
  );
  scheduler.enqueue("profile", ["p1", "p2"], options("profile"));
  pending.get("activity:a1")({ kind: "http-error", status: 429 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(scheduler.getInFlightCount(), 3);
  assert.deepEqual(
    finished.map(([type, result]) => [type, result.failures, result.stopped]),
    [["profile", 2, true]],
  );

  for (const key of ["activity:a2", "activity:a3", "activity:a4"]) {
    pending.get(key)({ kind: "success", record: key });
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    finished
      .map(([type, result]) => [type, result.failures, result.stopped])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ["activity", 2, true],
      ["profile", 2, true],
    ],
  );
  assert.equal(scheduler.getInFlightCount(), 0);
  assert.equal(scheduler.isGloballyStopped(), true);
});

test("页面任务连续五次服务端失败后停止自身并恢复另一页面任务", async () => {
  const scheduler = createTaskScheduler({ concurrency: 1 });
  const pending = new Map();
  const started = [];
  const finished = [];
  const options = (type) => ({
    confirmMessage: () => "",
    fetch: (item) =>
      new Promise((resolve) => {
        started.push(`${type}:${item}`);
        pending.set(`${type}:${item}`, resolve);
      }),
    isSuccess: (record, outcome) => outcome.kind === "success" && record,
    keyFor: (item) => item,
    lifecycle: {
      onFinished: (result) => finished.push([type, result]),
    },
  });

  scheduler.enqueue(
    "activity",
    ["a1", "a2", "a3", "a4", "a5", "a6"],
    options("activity"),
    { foreground: true },
  );
  scheduler.enqueue("profile", ["p1"], options("profile"));
  for (const item of ["a1", "a2", "a3", "a4", "a5"]) {
    pending.get(`activity:${item}`)({ kind: "http-error", status: 500 });
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(started, [
    "activity:a1",
    "activity:a2",
    "activity:a3",
    "activity:a4",
    "activity:a5",
    "profile:p1",
  ]);
  assert.equal(finished[0][0], "activity");
  assert.equal(finished[0][1].failures, 6);
  assert.equal(finished[0][1].stopped, true);

  pending.get("profile:p1")({ kind: "success", record: "p1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished[1][0], "profile");
  assert.equal(finished[1][1].failures, 0);
});

test("403 计入服务端失败且成功响应重置连续失败计数", async () => {
  const scheduler = createTaskScheduler({ concurrency: 1 });
  const pending = new Map();
  const started = [];
  const finished = [];
  scheduler.enqueue(
    "activity",
    ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"],
    {
      confirmMessage: () => "",
      fetch: (item) =>
        new Promise((resolve) => {
          started.push(item);
          pending.set(item, resolve);
        }),
      isSuccess: (record, outcome) => outcome.kind === "success" && record,
      keyFor: (item) => item,
      lifecycle: { onFinished: (result) => finished.push(result) },
    },
    { foreground: true },
  );
  const respond = async (item, outcome) => {
    pending.get(item)(outcome);
    await new Promise((resolve) => setImmediate(resolve));
  };

  // 三次失败（含 403）不达五次；成功重置后，若不重置则此时应已停止。
  await respond("a1", { kind: "http-error", status: 403 });
  await respond("a2", { kind: "http-error", status: 500 });
  await respond("a3", { kind: "http-error", status: 502 });
  await respond("a4", { kind: "success", record: "a4" });
  await respond("a5", { kind: "http-error", status: 503 });
  await respond("a6", { kind: "http-error", status: 403 });
  assert.deepEqual(started, ["a1", "a2", "a3", "a4", "a5", "a6", "a7"]);
  assert.equal(finished.length, 0);

  // 重置后连续五次才停止：后续项不再调度。
  await respond("a7", { kind: "http-error", status: 500 });
  await respond("a8", { kind: "http-error", status: 500 });
  await respond("a9", { kind: "http-error", status: 500 });
  assert.deepEqual(started.length, 9);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].stopped, true);
});

test("停止任务在残余请求完成前重新入队不会留下不可调度队列", async () => {
  const scheduler = createTaskScheduler({ concurrency: 4 });
  const started = [];
  const pending = new Map();
  const finished = [];
  const options = {
    confirmMessage: () => "",
    fetch: (item) =>
      new Promise((resolve) => {
        started.push(item);
        pending.set(item, resolve);
      }),
    isSuccess: () => false,
    keyFor: (item) => item,
    lifecycle: {
      onFinished: (result) => finished.push(result),
    },
  };

  scheduler.enqueue(
    "profile",
    ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"],
    options,
    { foreground: true },
  );
  assert.deepEqual(started, ["a1", "a2", "a3", "a4"]);

  const reject = async (item) => {
    const resolve = pending.get(item);
    assert.ok(resolve, `expected a pending request for ${item}`);
    pending.delete(item);
    resolve({ kind: "http-error", status: 500 });
    await new Promise((complete) => setImmediate(complete));
  };

  await reject("a1");
  await reject("a2");
  await reject("a3");
  await reject("a4");
  await reject("a5");

  assert.deepEqual(started, ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
  const requeue = scheduler.enqueue("profile", ["retry"], options);
  assert.equal(requeue.added, 0);

  await reject("a6");
  await reject("a7");
  await reject("a8");

  assert.equal(finished.length, 1);
  assert.equal(finished[0].failures, 9);
  assert.equal(scheduler.getTask("profile"), null);
  assert.equal(pending.size, 0);
});

test("没有待请求好友的远程目标不会暂停后台任务", async () => {
  const page = friendPageWith(
    ["a", "b", "c", "d", "e"].map((userIdentifier) => ({
      href: `/user/${userIdentifier}`,
      name: userIdentifier.toUpperCase(),
    })),
  );
  const now = 100_000;
  const pending = new Map();
  const started = [];
  const responseFor = (url) => ({
    ok: true,
    headers: { get: () => null },
    text: async () => (url.endsWith("/timeline") ? "timeline" : "profile"),
  });
  const release = (url) => {
    const resolve = pending.get(url);
    assert.ok(resolve, `expected a pending request for ${url}`);
    pending.delete(url);
    resolve(responseFor(url));
  };
  const records = Object.fromEntries(
    ["a", "b", "c", "d", "e"].map((userIdentifier) => [
      userIdentifier,
      storedCompletion(1, now),
    ]),
  );

  initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage: {
      getItem: (key) =>
        key === "bangumi-friend-sorter:activity-cache:v3"
          ? JSON.stringify({ version: 3, records })
          : null,
      setItem() {},
      removeItem() {},
    },
    now: () => now,
    domParser: {
      parseFromString: (html) =>
        html === "timeline"
          ? timelineDocumentFromFixture("timeline-active-seconds.html")
          : profileStatsDocument(),
    },
    fetchImpl: (url) => {
      started.push(url);
      return new Promise((resolve) => pending.set(url, resolve));
    },
  });

  mainSortControl(page, "上次活跃").click();
  assert.equal(started.filter((url) => url.endsWith("/timeline")).length, 4);
  dropdownButtonFor(page, "完成条目数").click();
  assert.equal(started.filter((url) => !url.endsWith("/timeline")).length, 0);

  release("/user/a/timeline");
  await waitForCondition(
    () => started.filter((url) => url.endsWith("/timeline")).length === 5,
  );

  for (const userIdentifier of ["b", "c", "d", "e"]) {
    release(`/user/${userIdentifier}/timeline`);
  }
  await waitForCondition(() => pending.size === 0);
});
