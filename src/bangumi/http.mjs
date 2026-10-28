// src/bangumi/http.mjs — Bangumi page request adapter.
import { userIdentifierFor, userIdentifierFromHref } from "./identity.mjs";
import { parseProfileFieldOutcomes } from "./profile-parser.mjs";
import { parseTimelineDocument } from "./timeline-parser.mjs";
import { parseTietieTimelineDocument } from "./tietie-parser.mjs";

const PAGE_REQUEST_TIMEOUT_MS = 15_000;

async function fetchPageWithTimeout(
  url,
  fetchImpl,
  {
    clearTimeoutImpl = globalThis.clearTimeout,
    setTimeoutImpl = globalThis.setTimeout,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("远程获取缺少 fetch 支持");
  }
  const controller = new AbortController();
  const timeout = setTimeoutImpl(
    () => controller.abort(),
    PAGE_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetchImpl(url, {
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) return { kind: "http-error", status: response.status };

    return { kind: "success", response, html: await response.text() };
  } catch {
    return { kind: "network-error" };
  } finally {
    clearTimeoutImpl(timeout);
  }
}

async function fetchDocumentPage(
  url,
  fetchImpl,
  domParser,
  parseDocument,
  { now, timers } = {},
) {
  const outcome = await fetchPageWithTimeout(url, fetchImpl, timers);
  if (outcome.kind !== "success") return outcome;
  const fetchedAt = now?.();
  if (typeof domParser?.parseFromString !== "function") {
    throw new Error("远程页面解析缺少 DOMParser 支持");
  }
  const document = domParser.parseFromString(outcome.html, "text/html");
  const record = parseDocument(document, outcome.response, fetchedAt);
  if (record?.kind === "invalid") return { kind: "parse-error" };
  return { kind: "success", record };
}

// 一次主页请求、一次文档提取：记录按字段携带三向结果，交给主页字段
// 任务分别判定成功与失败。字段取值由任务按 REMOTE_TARGET_SELECTION_KEYS
// 查询 fields，记录保持纯数据形状，方便测试适配器直接构造。
async function fetchProfile(friend, fetchImpl, domParser, now) {
  return fetchDocumentPage(
    `/user/${encodeURIComponent(userIdentifierFor(friend))}`,
    fetchImpl,
    domParser,
    (document, _response, fetchedAt) => {
      const fields = parseProfileFieldOutcomes(document);
      if (fields.completion === null && fields.relation === null) {
        return { kind: "invalid" };
      }
      return { fetchedAt, fields };
    },
    { now },
  );
}

async function fetchActivity(friend, fetchImpl, domParser, now) {
  return fetchDocumentPage(
    `/user/${encodeURIComponent(userIdentifierFor(friend))}/timeline`,
    fetchImpl,
    domParser,
    (document, response, fetchedAt) => {
      const responseAt = Date.parse(response.headers?.get("date") || "");
      const parsed = parseTimelineDocument(
        document,
        Math.trunc(
          (Number.isFinite(responseAt) ? responseAt : fetchedAt) / 1_000,
        ),
      );
      if (parsed.kind === "invalid") return parsed;
      return { ...parsed, fetchedAt };
    },
    { now },
  );
}

async function fetchTietiePage(
  recipientIdentifier,
  category,
  page,
  fetchImpl,
  domParser,
  baseUrl,
  timers,
) {
  const pageQuery = page === 1 ? "" : `&page=${page}`;
  const path = `/user/${encodeURIComponent(recipientIdentifier)}/timeline`;
  return fetchDocumentPage(
    `${path}?type=${category}${pageQuery}`,
    fetchImpl,
    domParser,
    (document, response) => {
      const expected = new URL(path, baseUrl);
      let actual;
      try {
        actual = new URL(response.url);
      } catch {
        return { kind: "invalid" };
      }
      // 最终 URL 与正文分类导航都必须确认目标，不能接受丢失分类的重定向。
      if (
        actual.origin !== expected.origin ||
        actual.pathname !== expected.pathname ||
        actual.searchParams.get("type") !== category ||
        Number(actual.searchParams.get("page") || 1) !== page
      ) {
        return { kind: "invalid" };
      }
      const activeCategory = [
        ...document.querySelectorAll("#timelineTabs a.focus[href]"),
      ].some((anchor) => {
        const href = anchor.getAttribute("href");
        let url;
        try {
          url = new URL(href, actual);
        } catch {
          return false;
        }
        return (
          url.origin === expected.origin &&
          url.pathname === path &&
          url.searchParams.get("type") === category
        );
      });
      const owner = document.querySelector(
        "#headerProfile .headerAvatar a[href]",
      );
      if (
        !activeCategory ||
        (owner &&
          userIdentifierFromHref(owner.getAttribute("href"), actual) !==
            recipientIdentifier)
      ) {
        return { kind: "invalid" };
      }
      return parseTietieTimelineDocument(document, { baseUrl, category, page });
    },
    { timers },
  );
}

// 生产 HTTP adapter：Bangumi 是真实外部依赖，页面 URL、同源凭据、
// 15 秒超时、响应时间与 DOM 解析全部收在这里。任务只拿到按页面类型
// 规范化的领域结果；测试用返回同样领域结果的 mock adapter 替换它。
function createBangumiHttpAdapter({
  baseUrl,
  clearTimeoutImpl,
  domParser,
  fetchImpl,
  now,
  setTimeoutImpl,
}) {
  return {
    fetchActivity: (friend) => fetchActivity(friend, fetchImpl, domParser, now),
    fetchProfile: (friend) => fetchProfile(friend, fetchImpl, domParser, now),
    fetchTietiePage: (recipientIdentifier, category, page) =>
      fetchTietiePage(
        recipientIdentifier,
        category,
        page,
        fetchImpl,
        domParser,
        baseUrl,
        { clearTimeoutImpl, setTimeoutImpl },
      ),
  };
}

export { fetchProfile, createBangumiHttpAdapter };
