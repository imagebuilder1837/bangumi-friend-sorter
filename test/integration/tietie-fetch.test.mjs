import test from "node:test";
import assert from "node:assert/strict";
import {
  statusFor,
  mainSortControl,
  directionButtonsFor,
} from "../support/sort-bar.mjs";
import { initializeRefreshPage } from "../support/refresh-page.mjs";
import { waitForCondition } from "../support/timing.mjs";
import { documentFromFixture } from "../support/html.mjs";
test("和我贴贴使用当前访问者身份并从吐槽和收藏第一页开始获取", async () => {
  const requests = [];
  const page = await initializeRefreshPage({
    entries: [{ href: "/user/friend", name: "好友" }],
    now: 1_000,
    domParser: {
      parseFromString: () => documentFromFixture("timeline-empty.html"),
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

test("未登录时选择和我贴贴只提示登录且不发起请求", async () => {
  const requests = [];
  const page = await initializeRefreshPage({
    entries: [{ href: "/user/friend", name: "好友" }],
    now: 100_000,
    visitorIdentifier: "",
    domParser: {
      parseFromString: () => documentFromFixture("timeline-empty.html"),
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
  const page = await initializeRefreshPage({
    entries: [
      { href: "/user/friend-a", name: "甲" },
      { href: "/user/friend-b", name: "乙" },
      { href: "/user/friend-c", name: "丙" },
      { href: "/user/missing", name: "零" },
    ],
    now: 100_000,
    domParser: {
      parseFromString: () => documentFromFixture("timeline-tietie.html"),
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
