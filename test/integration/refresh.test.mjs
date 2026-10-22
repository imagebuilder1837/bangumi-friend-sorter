import test from "node:test";
import assert from "node:assert/strict";
import { createFriendCache } from "../../src/cache/friend-cache.mjs";
import { initialize } from "../../src/page/initialize.mjs";
import { friendPageWith } from "../support/dom.mjs";
import {
  statusFor,
  mainSortControl,
  dropdownButtonFor,
} from "../support/sort-bar.mjs";
import {
  friendCacheStorage,
  persistentFriendCacheStorage,
  openPersistentCache,
  storedCompletion,
} from "../support/cache.mjs";
import {
  refreshResponseFor,
  initializeRefreshPage,
} from "../support/refresh-page.mjs";
import { waitForCondition } from "../support/timing.mjs";
import { documentFromFixture } from "../support/html.mjs";
import { relationProfileDocument } from "../support/profile.mjs";
test("请求响应头的时间按整秒传给活跃时刻解析并写入整数 Unix 秒缓存", async () => {
  const document = documentFromFixture("timeline-active-seconds.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36);
  const storage = persistentFriendCacheStorage();
  const page = friendPageWith([{ href: "/user/sai", name: "Sai" }]);
  await initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/sai/friends" },
    },
    storage,
    indexedDB: storage.indexedDB,
    now: () => responseTime,
    setTimeout: () => 1,
    clearTimeout() {},
    domParser: { parseFromString: () => document },
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get: (name) =>
          name === "date" ? new Date(responseTime).toUTCString() : null,
      },
      text: async () => "fixture",
    }),
  });
  mainSortControl(page, "上次活跃").click();
  await waitForCondition(() =>
    statusFor(page).textContent.includes("获取完成"),
  );
  const reloaded = await openPersistentCache(storage);
  assert.deepEqual(reloaded.activityFor("sai"), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
    fetchedAt: responseTime,
  });
});

test("用户主页请求超过十五秒时计入失败且保留旧缓存", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const oldCompletion = { value: 7, fetchedAt: staleFetchedAt };
  const oldRecord = storedCompletion(
    oldCompletion.value,
    oldCompletion.fetchedAt,
  );
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  const scheduled = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let requestSignal;

  // 15 秒超时由生产 HTTP adapter 实现，经页面初始化整体验证。
  globalThis.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  globalThis.clearTimeout = () => {};

  try {
    await initialize({
      document: page.document,
      window: {
        CHOBITS_USERNAME: "visitor",
        location: { href: "https://bgm.tv/user/viewed/friends" },
      },
      storage: friendCacheStorage({ friend: oldRecord }),
      now: () => now,
      setTimeout: () => 0,
      clearTimeout() {},
      domParser: { parseFromString: () => ({ querySelector: () => null }) },
      fetchImpl: (_url, { signal }) => {
        requestSignal = signal;
        return new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("request aborted"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new Error("request aborted")),
            { once: true },
          );
        });
      },
    });

    const status = statusFor(page);
    dropdownButtonFor(page, "完成条目数").click();

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 15_000);
    scheduled[0].callback();

    await waitForCondition(() =>
      status.textContent.includes("获取完成，1 人失败"),
    );
    assert.equal(requestSignal.aborted, true);
    const reloaded = createFriendCache(
      friendCacheStorage({ friend: oldRecord }),
      { now: () => now },
    );
    assert.deepEqual(reloaded.completionFor("friend", "all"), oldCompletion);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("过期同步率仍参与即时排序并触发刷新", async () => {
  const now = 100_000;
  const staleFetchedAt = now - 72 * 60 * 60 * 1_000 - 1;
  const pending = new Map();
  const requests = [];
  const page = await initializeRefreshPage({
    entries: [
      { href: "/user/low", name: "低" },
      { href: "/user/high", name: "高" },
    ],
    now,
    records: {
      low: {
        relation: {
          visitor: { syncRate: { value: -5, fetchedAt: staleFetchedAt } },
        },
      },
      high: {
        relation: {
          visitor: { syncRate: { value: 80, fetchedAt: staleFetchedAt } },
        },
      },
    },
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "0%" }),
    },
    fetchImpl: (url) => {
      requests.push(url);
      return new Promise((resolve) => pending.set(url, resolve));
    },
  });

  dropdownButtonFor(page, "喜好契合").click();

  assert.deepEqual(
    page.list.children.map(({ textContent }) => textContent),
    ["高", "低"],
  );
  assert.deepEqual(requests, ["/user/low", "/user/high"]);

  for (const [url, resolve] of [...pending]) {
    pending.delete(url);
    resolve(refreshResponseFor(url));
  }
  await waitForCondition(() =>
    statusFor(page).textContent.includes("获取完成"),
  );
});
