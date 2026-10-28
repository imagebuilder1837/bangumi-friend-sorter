import test from "node:test";
import assert from "node:assert/strict";
import { initialize } from "../../src/page/initialize.mjs";
import { friendPageWith } from "../support/dom.mjs";
import {
  persistentFriendCacheStorage,
  openPersistentCache,
} from "../support/cache.mjs";
import {
  mainSortControl,
  statusFor,
  directionButtonsFor,
  dropdownButtonFor,
} from "../support/sort-bar.mjs";
import { waitForCondition, fakeTimers } from "../support/timing.mjs";

async function ownerPage({
  ownerHref = null,
  path = "/user/viewed/friends",
  visitorIdentifier = "visitor",
  storage = persistentFriendCacheStorage(),
  clock,
} = {}) {
  const page = friendPageWith(
    [
      { href: "/user/friend-a", name: "甲" },
      { href: "/user/friend-b", name: "乙" },
    ],
    { ownerHref },
  );
  const requests = [];
  await initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: visitorIdentifier,
      location: { href: `https://bgm.tv${path}` },
    },
    storage,
    indexedDB: storage.indexedDB,
    now: clock?.now ?? (() => 100_000),
    setTimeout: clock?.setTimer ?? (() => 1),
    clearTimeout: clock?.clearTimer ?? (() => {}),
    http: {
      async fetchTietiePage(recipientIdentifier, category) {
        requests.push([recipientIdentifier, category]);
        return {
          kind: "success",
          record: {
            kind: "success",
            contents: [
              {
                contentKey: `/${category}/1`,
                reactorIdentifiers: ["friend-b"],
              },
            ],
            hasNextPage: false,
          },
        };
      },
    },
  });
  return { ...page, requests, storage };
}

const names = (page) => page.list.children.map((item) => item.textContent);

test("主页用户区规范链接优先于关系页数字别名，匿名也可获取并排序", async () => {
  const page = await ownerPage({
    path: "/user/123/rev_friends",
    ownerHref: "/user/canonical-owner",
    visitorIdentifier: "",
  });
  mainSortControl(page, "和 TA 贴贴").click();
  await waitForCondition(() =>
    statusFor(page).textContent.includes("获取完成"),
  );
  assert.deepEqual(page.requests, [
    ["canonical-owner", "say"],
    ["canonical-owner", "subject"],
  ]);
  assert.deepEqual(names(page), ["乙", "甲"]);
  const cache = await openPersistentCache(page.storage);
  assert.equal(cache.tietieFor("canonical-owner").counts.get("friend-b"), 2);
  assert.equal(cache.tietieFor("123"), undefined);
});

test("主页身份未知时保留当前顺序并提示，不借用登录用户缓存或请求", async () => {
  const page = await ownerPage({
    path: "/unknown",
    storage: persistentFriendCacheStorage(
      JSON.stringify({
        version: 3,
        tietie: { visitor: { counts: { "friend-a": 9 }, fetchedAt: 100_000 } },
      }),
    ),
  });
  directionButtonsFor(page)[1].click();
  mainSortControl(page, "和 TA 贴贴").click();
  assert.equal(statusFor(page).textContent, "无法识别主页用户");
  assert.deepEqual(names(page), ["乙", "甲"]);
  assert.deepEqual(page.requests, []);
  mainSortControl(page, "和 TA 贴贴").click();
  assert.equal(statusFor(page).textContent, "无法识别主页用户");
  mainSortControl(page, "加好友时间").click();
  directionButtonsFor(page)[0].click();
  assert.deepEqual(names(page), ["甲", "乙"]);
});

test("切换缺失身份的目标会更换提示，相同提示重复选择不延长五秒", async () => {
  for (const [first, second, expected] of [
    ["relation", "tietie", "无法识别主页用户"],
    ["tietie", "relation", "请登录后使用喜好契合排序"],
  ]) {
    const clock = fakeTimers(100_000);
    const page = await ownerPage({
      visitorIdentifier: "",
      path: "/unknown",
      clock,
    });
    const controls = {
      relation: dropdownButtonFor(page, "喜好契合"),
      tietie: mainSortControl(page, "和 TA 贴贴"),
    };
    controls[first].click();
    await clock.advance(1_000);
    controls[second].click();
    assert.equal(statusFor(page).textContent, expected);
    await clock.advance(1_000);
    controls[second].click();
    await clock.advance(4_000);
    assert.equal(statusFor(page).textContent, "");
    assert.deepEqual(page.requests, []);
  }
});

test("旧贴贴结果按接收方跨访问者及正反好友页复用，不续期或借给其他主页", async () => {
  const storage = persistentFriendCacheStorage(
    JSON.stringify({
      version: 3,
      tietie: {
        visitor: { counts: { "friend-a": 9 }, fetchedAt: 42_000 },
        viewed: { counts: { "friend-b": 5, outsider: 7 }, fetchedAt: 42_000 },
      },
    }),
  );
  for (const [visitorIdentifier, path] of [
    ["visitor", "/user/viewed/friends"],
    ["another-visitor", "/user/viewed/rev_friends"],
    ["", "/user/viewed/friends"],
  ]) {
    const page = await ownerPage({ storage, visitorIdentifier, path });
    mainSortControl(page, "和 TA 贴贴").click();
    assert.deepEqual(names(page), ["乙", "甲"]);
    assert.deepEqual(page.requests, []);
  }
  const own = await ownerPage({ storage, path: "/user/visitor/friends" });
  mainSortControl(own, "和 TA 贴贴").click();
  assert.deepEqual(names(own), ["甲", "乙"]);
  assert.deepEqual(own.requests, []);
  const other = await ownerPage({ storage, path: "/user/other/friends" });
  mainSortControl(other, "和 TA 贴贴").click();
  await waitForCondition(() =>
    statusFor(other).textContent.includes("获取完成"),
  );
  assert.deepEqual(other.requests, [
    ["other", "say"],
    ["other", "subject"],
  ]);
  const cache = await openPersistentCache(storage);
  assert.deepEqual(cache.tietieFor("viewed"), {
    counts: new Map([
      ["friend-b", 5],
      ["outsider", 7],
    ]),
    fetchedAt: 42_000,
  });
  assert.equal(cache.tietieFor("visitor").fetchedAt, 42_000);
});

test("没有主页自链接时正反好友页均支持规范数字用户标识", async () => {
  for (const suffix of ["friends", "rev_friends"]) {
    const page = await ownerPage({ path: `/user/1152725/${suffix}` });
    mainSortControl(page, "和 TA 贴贴").click();
    await waitForCondition(() =>
      statusFor(page).textContent.includes("获取完成"),
    );
    assert.deepEqual(page.requests, [
      ["1152725", "say"],
      ["1152725", "subject"],
    ]);
    assert.deepEqual(names(page), ["乙", "甲"]);
  }
});
