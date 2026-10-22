import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { initialize } from "../../src/page/initialize.mjs";
import { friendPageWith } from "../support/dom.mjs";
import { friendCacheStorage } from "../support/cache.mjs";
import { mainSortControl } from "../support/sort-bar.mjs";
import { fakeTimers } from "../support/timing.mjs";
test("页面等待缓存就绪再挂载，首次远程选择不因加载未完成误发请求", async () => {
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  let requests = 0;
  const started = initialize({
    document: page.document,
    window: {
      indexedDB: new IDBFactory(),
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: friendCacheStorage({
      friend: { activity: { kind: "empty", fetchedAt: 100 } },
    }),
    now: () => 100,
    http: {
      fetchActivity: async () => {
        requests += 1;
        return { kind: "empty", fetchedAt: 100 };
      },
    },
  });
  assert.equal(page.list.beforeNodes.length, 0);
  assert.equal(page.list.children.length, 1, "原站好友列表不被隐藏");
  await started;
  assert.ok(mainSortControl(page, "名称"));
  mainSortControl(page, "上次活跃").click();
  assert.equal(requests, 0);
});

test("数据库无响应时，两秒后排序栏与缓存排序仍可使用", async () => {
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  const clock = fakeTimers(100);
  const started = initialize({
    document: page.document,
    window: {
      indexedDB: { open: () => ({}) },
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: friendCacheStorage({
      friend: { activity: { kind: "empty", fetchedAt: 100 } },
    }),
    now: clock.now,
    setTimeout: clock.setTimer,
    clearTimeout: clock.clearTimer,
  });
  await clock.advance(1_999);
  assert.equal(page.list.beforeNodes.length, 0);
  await clock.advance(1);
  await started;
  assert.ok(mainSortControl(page, "名称"));
  mainSortControl(page, "上次活跃").click();
  assert.equal(page.list.children.length, 1);
});
