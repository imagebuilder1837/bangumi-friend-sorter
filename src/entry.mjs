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

function readFriends(list, baseUrl = window.location.href) {
  const elements = [...list.children];
  const friends = elements.map((element, originalIndex) => {
    const anchor = element.querySelector('a.avatar[href*="/user/"]');
    if (!anchor) return null;

    const userIdentifier = userIdentifierFromHref(
      anchor.getAttribute("href"),
      baseUrl,
    );
    if (!userIdentifier) return null;

    const displayName = anchor.textContent.trim();

    // The gray rule inside a friend item is the site's own border-bottom
    // on ul.usersMedium div.userContainer strong; the 名次 badge anchors
    // to that block. The anchor is resolved by the sort bar, which owns
    // every page node; reading here only validates that it exists — the
    // friend records stay pure domain data.
    if (!element.querySelector(".userContainer strong")) return null;

    return {
      displayName,
      originalIndex,
      userIdentifier,
    };
  });

  return friends.every(Boolean) ? friends : [];
}

function browserStorage(pageWindow = window) {
  try {
    return pageWindow.localStorage;
  } catch {
    return null;
  }
}

function pageFetchDependencies(runtime, pageWindow) {
  const domParser =
    runtime.domParser ??
    (typeof DOMParser === "function" ? new DOMParser() : null);
  const fetchImpl =
    runtime.fetchImpl ??
    (typeof pageWindow.fetch === "function"
      ? pageWindow.fetch.bind(pageWindow)
      : null);
  return domParser && fetchImpl ? { domParser, fetchImpl } : null;
}

function initialize(runtime = {}) {
  const pageDocument = runtime.document ?? document;
  const pageWindow = runtime.window ?? window;
  const list = pageDocument.querySelector("#memberUserList");
  if (!list || list.children.length === 0) return;

  const friends = readFriends(list, pageWindow.location.href);
  if (friends.length !== list.children.length) return;

  const now = runtime.now ?? Date.now;
  const cache = createFriendCache(
    runtime.storage ?? browserStorage(pageWindow),
    { now },
  );
  const visitorIdentifier = currentVisitorIdentifier(pageDocument, pageWindow);
  const collator = nameCollator();
  const sortBar = createSortBar(pageDocument, {
    list,
    // 浏览器注入可见性观察器（ADR 0002）；测试可注入替身，缺省时
    // 排序栏静默降级为仅在后续渲染中修正名次。
    mutationObserver: runtime.mutationObserver ?? pageWindow.MutationObserver,
  });
  if (!sortBar.mount()) return;
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
  });
  // 页面入口只创建会话并启动：后续交互全部经 choose 与 changeDirection
  // 进入业务流程。
  sortBar.bind({
    selectCriterion: (criterion, selection) =>
      session.choose(criterion, selection),
    selectDirection: (direction) => session.changeDirection(direction),
  });
  session.start();
}

export { initialize };
