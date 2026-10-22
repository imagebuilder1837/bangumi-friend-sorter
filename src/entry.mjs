// src/entry.mjs — page assembly.
import {
  userIdentifierFromHref,
  currentVisitorIdentifier,
} from "./identity.mjs";
import { createFriendCache } from "./cache.mjs";
import { nameCollator } from "./sorting.mjs";
import { createSortBar } from "./sort-bar.mjs";
import { createBangumiHttpAdapter } from "./http.mjs";
import { createFriendSortSession } from "./session.mjs";
import { createPageErrorReporter } from "./page-errors.mjs";

function readFriends(list, baseUrl, logger) {
  const seen = new Set();
  const records = new Map();
  let duplicates = 0;
  let invalid = 0;
  for (const element of [...list.children]) {
    const anchor = element.querySelector("a.avatar");
    if (!anchor && !element.matches?.("li.user")) continue;

    const userIdentifier =
      anchor && userIdentifierFromHref(anchor.getAttribute("href"), baseUrl);
    if (!userIdentifier) {
      element.remove();
      invalid += 1;
      continue;
    }
    if (seen.has(userIdentifier)) {
      element.remove();
      duplicates += 1;
      continue;
    }
    seen.add(userIdentifier);

    const displayName = anchor.textContent.trim();

    records.set(element, { displayName, userIdentifier });
  }
  if (duplicates || invalid) {
    logger.info(
      `好友排序：已移除 ${duplicates} 个重复好友项、${invalid} 个无有效用户标识的好友项`,
    );
  }
  const elements = [...list.children];
  const friends = elements.flatMap((element, originalIndex) => {
    const record = records.get(element);
    return record ? [{ ...record, originalIndex }] : [];
  });
  return { friends, elements };
}

function browserStorage(pageWindow, property) {
  try {
    return pageWindow[property];
  } catch {
    return null;
  }
}

function pageFetchDependencies(runtime, pageWindow) {
  const domParser =
    runtime.domParser ??
    (typeof pageWindow.DOMParser === "function"
      ? new pageWindow.DOMParser()
      : null) ??
    (typeof DOMParser === "function" ? new DOMParser() : null);
  const fetchImpl =
    runtime.fetchImpl ??
    (typeof pageWindow.fetch === "function"
      ? pageWindow.fetch.bind(pageWindow)
      : null);
  return { domParser, fetchImpl };
}

async function initialize(runtime = {}) {
  const pageDocument = runtime.document ?? document;
  const pageWindow = runtime.window ?? window;
  const list = pageDocument.querySelector("#memberUserList");
  if (!list || list.children.length === 0) return;

  const logger = pageWindow.console ?? console;
  const reportError = createPageErrorReporter(pageDocument, { list, logger });
  try {
    const { friends, elements } = readFriends(
      list,
      pageWindow.location.href,
      logger,
    );
    if (friends.length === 0) return;

    const now = runtime.now ?? Date.now;
    const cache = createFriendCache(
      runtime.storage ?? browserStorage(pageWindow, "localStorage"),
      {
        now,
        indexedDB: runtime.indexedDB ?? browserStorage(pageWindow, "indexedDB"),
        setTimeoutImpl: runtime.setTimeout,
        clearTimeoutImpl: runtime.clearTimeout,
      },
    );
    await cache.ready;
    const visitorIdentifier = currentVisitorIdentifier(
      pageDocument,
      pageWindow,
    );
    const collator = nameCollator();
    const sortBar = createSortBar(pageDocument, {
      list,
      elements,
      reportError,
      // 浏览器注入可见性观察器（ADR 0002）；测试可注入替身，缺省时
      // 排序栏静默降级为仅在后续渲染中修正名次。
      mutationObserver: runtime.mutationObserver ?? pageWindow.MutationObserver,
    });
    if (!sortBar.mount()) {
      throw new Error("找不到排序栏挂载位置 .mainWrapper > .columns");
    }
    // 生产 HTTP adapter 在装配时创建；测试可以直接注入返回规范化领域结果
    // 的 mock adapter，不伪造 HTTP Response 或 DOM。
    const http =
      runtime.http ??
      createBangumiHttpAdapter({
        baseUrl: pageWindow.location.href,
        clearTimeoutImpl: runtime.clearTimeout,
        ...pageFetchDependencies(runtime, pageWindow),
        now,
        setTimeoutImpl: runtime.setTimeout,
      });
    const session = createFriendSortSession({
      cache,
      collator,
      friends,
      http,
      now,
      pageWindow,
      runtime,
      sortBar,
      visitorIdentifier,
      reportError,
    });
    // 页面入口只创建会话并启动：后续交互全部经 choose 与 changeDirection
    // 进入业务流程。
    sortBar.bind({
      selectCriterion: (criterion, selection) =>
        session.choose(criterion, selection),
      selectDirection: (direction) => session.changeDirection(direction),
    });
    session.start();
  } catch (error) {
    reportError("初始化", error);
    throw error;
  }
}

export { initialize };
