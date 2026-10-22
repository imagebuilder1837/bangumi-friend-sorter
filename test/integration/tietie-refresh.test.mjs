import test from "node:test";
import assert from "node:assert/strict";
import { initialize } from "../../src/page/initialize.mjs";
import { friendPageWith } from "../support/dom.mjs";
import { statusFor, mainSortControl } from "../support/sort-bar.mjs";
import {
  persistentFriendCacheStorage,
  openPersistentCache,
} from "../support/cache.mjs";
import { waitForCondition, fakeTimers } from "../support/timing.mjs";
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
  await initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage,
    indexedDB: storage.indexedDB,
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
  const reloaded = await openPersistentCache(storage, { now: clock.now });
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
  await initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage,
    indexedDB: storage.indexedDB,
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
  const reloaded = await openPersistentCache(storage, { now: () => now });
  assert.deepEqual(reloaded.tietieFor("visitor"), {
    counts: new Map([["friend", 4]]),
    fetchedAt: now,
  });
});
