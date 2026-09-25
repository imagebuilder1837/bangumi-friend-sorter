// src/http.mjs — Bangumi page request adapter.
import { userIdentifierFor } from "./identity.mjs";
import { parseProfileFieldOutcomes } from "./profile-parser.mjs";
import { parseTimelineDocument } from "./timeline-parser.mjs";
import { parseTietieTimelineDocument } from "./tietie-parser.mjs";

const PAGE_REQUEST_TIMEOUT_MS = 15_000;

async function fetchPageWithTimeout(
  url,
  fetchImpl,
  parseResponse,
  {
    clearTimeoutImpl = globalThis.clearTimeout,
    setTimeoutImpl = globalThis.setTimeout,
  } = {},
) {
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

    return await parseResponse(response);
  } catch {
    return { kind: "network-error" };
  } finally {
    clearTimeoutImpl(timeout);
  }
}

// 一次主页请求、一次文档提取：记录按字段携带三向结果，交给主页字段
// 任务分别判定成功与失败。字段取值由任务按 REMOTE_TARGET_SELECTION_KEYS
// 查询 fields，记录保持纯数据形状，方便测试适配器直接构造。
async function fetchProfile(friend, fetchImpl, domParser, now) {
  return fetchPageWithTimeout(
    `/user/${encodeURIComponent(userIdentifierFor(friend))}`,
    fetchImpl,
    async (response) => {
      const html = await response.text();
      const fetchedAt = now();
      const document = domParser.parseFromString(html, "text/html");
      const fields = parseProfileFieldOutcomes(document);
      if (fields.completion === null && fields.relation === null) {
        return { kind: "parse-error" };
      }
      return { kind: "success", record: { fetchedAt, fields } };
    },
  );
}

async function fetchActivity(friend, fetchImpl, domParser, now) {
  return fetchPageWithTimeout(
    `/user/${encodeURIComponent(userIdentifierFor(friend))}/timeline`,
    fetchImpl,
    async (response) => {
      const html = await response.text();
      const fetchedAt = now();
      const responseAt = Date.parse(response.headers?.get("date") || "");
      const document = domParser.parseFromString(html, "text/html");
      const parsed = parseTimelineDocument(
        document,
        Math.trunc(
          (Number.isFinite(responseAt) ? responseAt : fetchedAt) / 1_000,
        ),
      );
      if (parsed.kind === "invalid") return { kind: "parse-error" };
      return { kind: "success", record: { ...parsed, fetchedAt } };
    },
  );
}

async function fetchTietiePage(
  visitorIdentifier,
  category,
  page,
  fetchImpl,
  domParser,
  baseUrl,
  timers,
) {
  const pageQuery = page === 1 ? "" : `&page=${page}`;
  return fetchPageWithTimeout(
    `/user/${encodeURIComponent(visitorIdentifier)}/timeline?type=${category}${pageQuery}`,
    fetchImpl,
    async (response) => {
      const html = await response.text();
      const document = domParser.parseFromString(html, "text/html");
      const parsed = parseTietieTimelineDocument(document, {
        baseUrl,
        category,
        page,
      });
      return parsed.kind === "invalid"
        ? { kind: "parse-error" }
        : { kind: "success", record: parsed };
    },
    timers,
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
  if (!domParser || !fetchImpl) return null;
  return {
    fetchActivity: (friend) => fetchActivity(friend, fetchImpl, domParser, now),
    fetchProfile: (friend) => fetchProfile(friend, fetchImpl, domParser, now),
    fetchTietiePage: (visitorIdentifier, category, page) =>
      fetchTietiePage(
        visitorIdentifier,
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
