import test from "node:test";
import assert from "node:assert/strict";
import * as sorter from "../src/legacy.mjs";
import {
  friendPageWith,
  mainSortControl,
  dropdownButtonFor,
  timelineDocumentFromFixture,
  profileStatsDocument,
  relationProfileDocument,
} from "./support/index.mjs";

test("页面初始化可以注入获取任务所需的运行时依赖", async () => {
  const page = friendPageWith([{ href: "/user/sai", name: "Sai" }]);
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36);
  let requests = 0;
  let nowCalls = 0;
  const progress = [];
  const writes = [];
  const storage = {
    getItem() {
      return null;
    },
    removeItem() {},
    setItem(key, value) {
      writes.push([key, JSON.parse(value)]);
    },
  };
  const pageWindow = {
    location: { href: "https://bgm.tv/user/sai/friends" },
  };

  sorter.initialize({
    document: page.document,
    window: pageWindow,
    storage,
    domParser: {
      parseFromString: () =>
        timelineDocumentFromFixture("timeline-active-seconds.html"),
    },
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        headers: { get: () => new Date(responseTime).toUTCString() },
        text: async () => "fixture",
      };
    },
    now: () => {
      nowCalls += 1;
      return responseTime;
    },
    onProgress: (completed, total) => progress.push([completed, total]),
  });

  mainSortControl(page, "上次活跃").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests, 1);
  assert.equal(nowCalls, 3);
  assert.deepEqual(progress, [
    [0, 1],
    [1, 1],
  ]);
  assert.deepEqual(writes, [
    [
      "bangumi-friend-sorter:activity-cache:v3",
      {
        version: 3,
        records: {
          sai: {
            activity: {
              kind: "active",
              activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
              fetchedAt: responseTime,
            },
          },
        },
      },
    ],
  ]);
});

test("三个支持站点都使用隔离存储和同源请求刷新两类页面", async () => {
  const domainWrites = new Map();
  for (const host of ["bgm.tv", "bangumi.tv", "chii.in"]) {
    const page = friendPageWith([{ href: "/user/friend", name: "好友" }]);
    const requests = [];
    const writes = [];
    domainWrites.set(host, writes);
    sorter.initialize({
      document: page.document,
      window: {
        location: { href: `https://${host}/user/viewed/friends` },
        localStorage: {
          getItem: () => null,
          setItem: (key, value) => writes.push([key, value]),
          removeItem() {},
        },
      },
      setTimeout: () => 1,
      clearTimeout() {},
      domParser: {
        parseFromString: (html) =>
          html === "timeline"
            ? timelineDocumentFromFixture("timeline-active-seconds.html")
            : profileStatsDocument(),
      },
      fetchImpl: async (url, options) => {
        const request = [url, options];
        requests.push(request);
        return {
          ok: true,
          headers: { get: () => null },
          text: async () =>
            url.endsWith("/timeline") ? "timeline" : "profile",
        };
      },
    });

    mainSortControl(page, "上次活跃").click();
    dropdownButtonFor(page, "完成条目数").click();
    for (
      let attempt = 0;
      attempt < 10 && (requests.length < 2 || writes.length === 0);
      attempt += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(requests.length, 2, host);
    assert.equal(requests[0][0], "/user/friend/timeline", host);
    assert.equal(requests[0][1].credentials, "same-origin", host);
    assert.equal(requests[1][0], "/user/friend", host);
    assert.equal(requests[1][1].credentials, "same-origin", host);
    assert.ok(writes.length > 0, host);
  }
  assert.notEqual(domainWrites.get("bgm.tv"), domainWrites.get("bangumi.tv"));
  assert.notEqual(domainWrites.get("bangumi.tv"), domainWrites.get("chii.in"));
});

test("页面初始化使用注入时钟判断 v2 上次活跃记录迁移有效期", async () => {
  const hour = 60 * 60 * 1_000;
  const now = 100 * hour;
  const records = {
    fresh: { kind: "active", activityAtSeconds: 1, fetchedAt: now - hour },
    boundary: {
      kind: "active",
      activityAtSeconds: 2,
      fetchedAt: now - 24 * hour,
    },
    stale: {
      kind: "active",
      activityAtSeconds: 3,
      fetchedAt: now - 24 * hour - 1,
    },
  };
  const page = friendPageWith([
    { href: "/user/fresh", name: "新鲜" },
    { href: "/user/boundary", name: "边界" },
    { href: "/user/stale", name: "过期" },
  ]);
  let requests = 0;
  const storage = {
    getItem(key) {
      if (key === "bangumi-friend-sorter:activity-cache:v2") {
        return JSON.stringify({ version: 2, records });
      }
      return null;
    },
    removeItem() {},
    setItem() {},
  };

  sorter.initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage,
    domParser: {
      parseFromString: () =>
        timelineDocumentFromFixture("timeline-active-seconds.html"),
    },
    fetchImpl: async () => {
      requests += 1;
      return { ok: false, status: 404 };
    },
    now: () => now,
  });

  mainSortControl(page, "上次活跃").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests, 1);
});

test("当前访问者标识按配置的访问者标识、UID、页头头像依次回退且不读取被查看者", () => {
  const avatar = { getAttribute: () => "/user/header-user" };
  const headerDocument = {
    querySelector(selector) {
      return selector === "#headerNeue2 .idBadgerNeue a.avatar[href*='/user/']"
        ? avatar
        : null;
    },
  };

  assert.equal(
    sorter.currentVisitorIdentifier(headerDocument, {
      CHOBITS_UID: "42",
      CHOBITS_USERNAME: "name",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    }),
    "name",
  );
  assert.equal(
    sorter.currentVisitorIdentifier(headerDocument, {
      CHOBITS_UID: "9007199254740993",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    }),
    "9007199254740993",
  );
  assert.equal(
    sorter.currentVisitorIdentifier(headerDocument, {
      CHOBITS_UID: "0",
      CHOBITS_USERNAME: "  name  ",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    }),
    "name",
  );
  assert.equal(
    sorter.currentVisitorIdentifier(headerDocument, {
      location: { href: "https://bgm.tv/user/viewed/friends" },
    }),
    "header-user",
  );
  assert.equal(
    sorter.currentVisitorIdentifier(
      { querySelector: () => null },
      { location: { href: "https://bgm.tv/user/viewed/friends" } },
    ),
    null,
  );
});

test("初始化按当前访问者隔离喜好契合缓存", () => {
  const now = 100_000;
  const visitorA = "visitor-a";
  const visitorB = "visitor-b";
  const storage = {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({
        version: 3,
        records: {
          friend: {
            relation: {
              [visitorA]: { syncRate: { value: 90, fetchedAt: now } },
            },
          },
        },
      });
    },
    setItem() {},
    removeItem() {},
  };

  const pageA = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  let requestsA = 0;
  sorter.initialize({
    document: pageA.document,
    window: {
      CHOBITS_USERNAME: visitorA,
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage,
    now: () => now,
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: async () => {
      requestsA += 1;
      return { ok: true, text: async () => "profile" };
    },
  });
  dropdownButtonFor(pageA, "喜好契合").click();
  assert.equal(requestsA, 0);

  const pageB = friendPageWith([{ href: "/user/friend", name: "好友" }]);
  let requestsB = 0;
  sorter.initialize({
    document: pageB.document,
    window: {
      CHOBITS_USERNAME: visitorB,
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage,
    now: () => now,
    domParser: {
      parseFromString: () => relationProfileDocument({ syncRate: "50%" }),
    },
    fetchImpl: async () => {
      requestsB += 1;
      return { ok: true, text: async () => "profile" };
    },
  });
  dropdownButtonFor(pageB, "喜好契合").click();
  assert.equal(requestsB, 1);
});
