import test from "node:test";
import assert from "node:assert/strict";
import { initialize } from "../../src/page/initialize.mjs";
import { friendPageWith } from "../support/dom.mjs";
import {
  statusFor,
  mainSortControl,
  dropdownButtonFor,
} from "../support/sort-bar.mjs";
import { friendCacheStorage, storedCompletion } from "../support/cache.mjs";
import { initializeRefreshPage } from "../support/refresh-page.mjs";
import { waitForCondition } from "../support/timing.mjs";
import {
  profileStatsDocument,
  relationProfileDocument,
} from "../support/profile.mjs";
test("选择喜好契合会清除已激活的上次活跃全量刷新提示", async () => {
  const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  const now = 100_000;
  await initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: friendCacheStorage({
      friend: {
        activity: { kind: "empty", fetchedAt: now },
        relation: { visitor: { syncRate: { value: 50, fetchedAt: now } } },
      },
    }),
    now: () => now,
  });

  const status = statusFor(page);

  mainSortControl(page, "上次活跃").click();
  mainSortControl(page, "上次活跃").click();
  assert.equal(status.textContent, "5 秒内再次点击“上次活跃”以全量刷新");
  dropdownButtonFor(page, "喜好契合").click();
  assert.equal(status.textContent, "");
});

test("获取中重复选择同一远程目标被忽略且不打断进行中任务", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const now = 100_000;
  let releaseA;
  const pendingA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const requests = [];

  await initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: friendCacheStorage({
      b: { relation: { visitor: { syncRate: { value: 10, fetchedAt: now } } } },
    }),
    now: () => now,
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: (url) => {
      requests.push(url);
      return url.endsWith("/a")
        ? pendingA
        : Promise.resolve({ ok: true, text: async () => "b" });
    },
  });

  const relationButton = dropdownButtonFor(page, "喜好契合");
  const status = statusFor(page);

  relationButton.click();
  assert.deepEqual(requests, ["/user/a"]);
  assert.equal(status.textContent, "正在获取“喜好契合” 0/1");

  // 获取中再次选择同一目标：忽略，不新增请求也不清掉进行中提示。
  relationButton.click();
  assert.deepEqual(requests, ["/user/a"]);
  assert.equal(status.textContent, "正在获取“喜好契合” 0/1");

  releaseA({ ok: true, text: async () => "a" });
  await waitForCondition(() =>
    status.textContent.includes("“喜好契合”获取完成"),
  );
  assert.deepEqual(requests, ["/user/a"]);
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["A", "B"],
  );
});

test("完成条目数两击全量刷新使用实际范围名称并忽略有效缓存", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const now = 100_000;
  const requests = [];
  await initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage: {
      getItem(key) {
        if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
        return JSON.stringify({
          version: 3,
          records: {
            a: storedCompletion(1, now),
            b: storedCompletion(2, now),
          },
        });
      },
      setItem() {},
      removeItem() {},
    },
    now: () => now,
    setTimeout: () => 1,
    clearTimeout() {},
    domParser: {
      parseFromString: (url) =>
        profileStatsDocument({
          counts: url.endsWith("/a")
            ? { all: 10, 1: 10, 2: 10, 3: 10, 4: 10, 6: 10 }
            : { all: 1, 1: 1, 2: 1, 3: 1, 4: 1, 6: 1 },
        }),
    },
    fetchImpl: (url) => {
      requests.push(url);
      return Promise.resolve({ ok: true, text: async () => url });
    },
  });

  const status = statusFor(page);

  const completionButton = dropdownButtonFor(page, "完成条目数");
  completionButton.click();
  assert.deepEqual(requests, []);
  assert.deepEqual(
    page.list.children.map(({ textContent }) => textContent),
    ["B", "A"],
  );
  completionButton.click();
  assert.equal(status.textContent, "5 秒内再次点击“全部”以全量刷新");
  completionButton.click();
  await waitForCondition(() => status.textContent.includes("获取完成"));
  assert.deepEqual(requests, ["/user/a", "/user/b"]);
  assert.equal(status.textContent, "“完成条目数”获取完成");
  assert.deepEqual(
    page.list.children.map(({ textContent }) => textContent),
    ["A", "B"],
  );
});

test("取消全量刷新后必须重新两击才会再次触发", async () => {
  const entries = Array.from({ length: 401 }, (_, index) => ({
    href: `/user/friend-${index}`,
    name: `好友${index}`,
  }));
  const now = 100_000;
  const records = Object.fromEntries(
    entries.map(({ href }) => [
      href.split("/").pop(),
      {
        relation: {
          visitor: { syncRate: { value: 10, fetchedAt: now } },
        },
      },
    ]),
  );
  const requests = [];
  const confirmations = [];
  const page = await initializeRefreshPage({
    entries,
    now,
    records,
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: (url) => {
      requests.push(url);
      return Promise.resolve({ ok: true, text: async () => "profile" });
    },
    confirm: (message) => {
      confirmations.push(message);
      return false;
    },
  });

  const relationButton = dropdownButtonFor(page, "喜好契合");
  const status = statusFor(page);
  const confirmationMessage =
    "本次新增获取的好友数量过多（401 人），是否继续？";

  relationButton.click();
  relationButton.click();
  assert.equal(status.textContent, "5 秒内再次点击“同步率”以全量刷新");
  relationButton.click();
  assert.deepEqual(confirmations, [confirmationMessage]);
  assert.equal(status.textContent, "");
  assert.deepEqual(requests, []);

  relationButton.click();
  assert.equal(status.textContent, "5 秒内再次点击“同步率”以全量刷新");
  relationButton.click();
  assert.deepEqual(confirmations, [confirmationMessage, confirmationMessage]);
  assert.equal(status.textContent, "");
  assert.deepEqual(requests, []);
});
