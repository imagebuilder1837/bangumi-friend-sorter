import test from "node:test";
import assert from "node:assert/strict";
import {
  createBangumiHttpAdapter,
  fetchProfile,
} from "../../src/bangumi/http.mjs";
import { documentFromFixture } from "../support/html.mjs";
import { tietieDocumentFor } from "../support/tietie.mjs";
import {
  relationProfileDocument,
  duplicateCategoryProfileDocument,
} from "../support/profile.mjs";
function adapterWith(overrides = {}) {
  return createBangumiHttpAdapter({
    baseUrl: "https://bgm.tv/user/viewed/friends",
    now: () => 1_000,
    fetchImpl: async () => ({
      ok: true,
      text: async () => "html",
      headers: { get: () => null },
    }),
    domParser: { parseFromString: () => null },
    ...overrides,
  });
}

test("贴贴重定向丢失分类时拒绝默认动态，即使正文能解析", async () => {
  const http = adapterWith({
    fetchImpl: async () => ({
      ok: true,
      url: "https://bgm.tv/user/owner/timeline",
      text: async () => "timeline",
    }),
    domParser: {
      parseFromString: () => documentFromFixture("timeline-tietie.html"),
    },
  });
  assert.deepEqual(await http.fetchTietiePage("owner", "say", 1), {
    kind: "parse-error",
  });
});

test("贴贴正文的主页身份和激活分类必须与请求一致", async () => {
  for (const mismatch of ["category", "navigation-owner", "header-owner"]) {
    const document = tietieDocumentFor({ recipientIdentifier: "owner" });
    if (mismatch === "category") {
      document
        .querySelector("#timelineTabs a")
        .setAttribute("href", "/user/owner/timeline?type=subject");
    } else if (mismatch === "navigation-owner") {
      document
        .querySelector("#timelineTabs a")
        .setAttribute("href", "/user/other/timeline?type=say");
    } else {
      document
        .querySelector("#headerProfile a")
        .setAttribute("href", "/user/other");
    }
    const http = adapterWith({
      fetchImpl: async () => ({
        ok: true,
        url: "https://bgm.tv/user/owner/timeline?type=say",
        text: async () => "timeline",
      }),
      domParser: { parseFromString: () => document },
    });
    assert.deepEqual(
      await http.fetchTietiePage("owner", "say", 1),
      { kind: "parse-error" },
      mismatch,
    );
  }
});

test("贴贴响应最终地址必须保持同源、目标用户和请求页码", async () => {
  for (const url of [
    "https://bgm.tv/user/other/timeline?type=say",
    "https://bangumi.tv/user/owner/timeline?type=say",
    "https://bgm.tv/user/owner/timeline?type=say&page=2",
    "https://bgm.tv/login",
    undefined,
  ]) {
    const http = adapterWith({
      fetchImpl: async () => ({ ok: true, url, text: async () => "timeline" }),
      domParser: {
        parseFromString: () =>
          tietieDocumentFor({ recipientIdentifier: "owner" }),
      },
    });
    assert.deepEqual(
      await http.fetchTietiePage("owner", "say", 1),
      { kind: "parse-error" },
      String(url),
    );
  }
});

test("贴贴以同源凭据读取指定接收方，支持规范数字路径、后续页及可靠空页", async () => {
  for (const [recipientIdentifier, category, page, fixture] of [
    ["owner", "say", 1, "timeline-tietie.html"],
    ["owner", "subject", 2, "timeline-tietie.html"],
    ["1152725", "subject", 1, "timeline-tietie.html"],
    ["1152725", "say", 1, "timeline-tietie-empty-no-container.html"],
  ]) {
    const path = `/user/${recipientIdentifier}/timeline?type=${category}${page === 1 ? "" : `&page=${page}`}`;
    const requests = [];
    const http = adapterWith({
      fetchImpl: async (url, options) => {
        requests.push([url, options.credentials]);
        return {
          ok: true,
          url: new URL(url, "https://bgm.tv").href,
          text: async () => "timeline",
        };
      },
      domParser: {
        parseFromString: () =>
          tietieDocumentFor({ recipientIdentifier, category, fixture }),
      },
    });
    const result = await http.fetchTietiePage(
      recipientIdentifier,
      category,
      page,
    );
    assert.deepEqual(requests, [[path, "same-origin"]]);
    assert.equal(result.kind, "success");
    assert.equal(
      result.record.kind,
      fixture.includes("empty") ? "empty" : "success",
    );
  }
});

test("传输与读取正文失败仍是可恢复网络失败，HTTP 状态不被混淆", async () => {
  const failure = new TypeError("network failed");
  for (const fetchImpl of [
    async () => {
      throw failure;
    },
    async () => ({
      ok: true,
      text: async () => {
        throw failure;
      },
    }),
  ]) {
    const http = adapterWith({ fetchImpl });
    assert.deepEqual(await http.fetchActivity({ userIdentifier: "zed" }), {
      kind: "network-error",
    });
  }
  const http = adapterWith({
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  assert.deepEqual(await http.fetchActivity({ userIdentifier: "zed" }), {
    kind: "http-error",
    status: 403,
  });
});

test("三种远程页面解析的程序异常保持原样，不伪装成网络失败", async () => {
  const failure = new Error("parser bug");
  const http = adapterWith({
    domParser: {
      parseFromString() {
        throw failure;
      },
    },
  });
  for (const request of [
    () => http.fetchActivity({ userIdentifier: "zed" }),
    () => http.fetchProfile({ userIdentifier: "zed" }),
    () => http.fetchTietiePage("visitor", "say", 1),
  ]) {
    await assert.rejects(request(), (error) => error === failure);
  }
});

test("贴贴身份校验的程序异常不伪装成页面解析失败", async () => {
  const failure = new Error("DOM bug");
  const http = adapterWith({
    fetchImpl: async () => ({
      ok: true,
      url: "https://bgm.tv/user/owner/timeline?type=say",
      text: async () => "timeline",
    }),
    domParser: {
      parseFromString: () => ({
        querySelectorAll() {
          throw failure;
        },
      }),
    },
  });
  await assert.rejects(
    http.fetchTietiePage("owner", "say", 1),
    (error) => error === failure,
  );
});

test("主页请求记录按字段携带成功、缺失或无效结果", async () => {
  const outcome = await fetchProfile(
    { userIdentifier: "sai" },
    async () => ({ ok: true, text: async () => "profile" }),
    { parseFromString: () => duplicateCategoryProfileDocument() },
    () => 5_000,
  );

  assert.equal(outcome.kind, "success");
  assert.equal(outcome.record.fetchedAt, 5_000);
  // 重复分类块是结构矛盾：完成统计整体解析失败，契合指标照常携带结果。
  assert.equal(outcome.record.fields.completion, null);
  assert.deepEqual(outcome.record.fields.relation.syncRate, {
    kind: "success",
    value: 12,
  });
  assert.deepEqual(outcome.record.fields.relation.commonLikes, {
    kind: "success",
    value: 5,
  });

  const absentFields = await fetchProfile(
    { userIdentifier: "sai" },
    async () => ({ ok: true, text: async () => "profile" }),
    { parseFromString: () => relationProfileDocument({ syncRate: "50%" }) },
    () => 5_000,
  );
  assert.deepEqual(absentFields.record.fields.relation.syncRate, {
    kind: "success",
    value: 50,
  });
  assert.deepEqual(absentFields.record.fields.relation.commonLikes, {
    kind: "missing",
  });
  assert.equal(absentFields.record.fields.completion, null);
});
