import test from "node:test";
import assert from "node:assert/strict";
import { createBangumiHttpAdapter } from "../src/http.mjs";

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
