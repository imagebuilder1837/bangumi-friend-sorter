const sorter = require("../../src/index.user.js");

const { friendPageWith } = require("./dom");

const { friendCacheStorage } = require("./cache");

function refreshResponseFor(url) {
  return {
    ok: true,
    headers: { get: () => null },
    text: async () => (url.endsWith("/timeline") ? "timeline" : "profile"),
  };
}

function initializeRefreshPage({
  confirm,
  domParser,
  entries,
  fetchImpl,
  now,
  records,
  visitorIdentifier = "visitor",
}) {
  const page = friendPageWith(entries);
  sorter.initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: visitorIdentifier,
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: friendCacheStorage(records),
    now: () => now,
    setTimeout: () => 1,
    clearTimeout() {},
    domParser,
    fetchImpl,
    confirm,
  });
  return page;
}

// Drives the production remote-sort session (createFriendSortSession) with a
// recording sort-bar substitute and a mock Bangumi HTTP adapter that returns
// normalized domain results, so tests exercise the same boundary the page uses
// at runtime and never fake HTTP responses, DOM documents or internal state.
function createSessionHarness({
  cache,
  friends,
  runtime,
  visitorIdentifier = "visitor",
}) {
  let lastState = null;
  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });
  const session = sorter.createFriendSortSession({
    cache,
    collator: new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    }),
    friends,
    http: runtime.http,
    now: runtime.now ?? (() => 1_000),
    pageWindow: {},
    runtime,
    sortBar: {
      render(state) {
        lastState = state;
        if (/获取完成|获取失败|请求受限/.test(state.statusMessage))
          resolveFinished();
      },
    },
    visitorIdentifier,
  });
  session.start();
  return {
    finished,
    lastMessage: () => lastState?.statusMessage ?? "",
    lastState: () => lastState,
    session,
  };
}

module.exports = { refreshResponseFor, initializeRefreshPage, createSessionHarness };
