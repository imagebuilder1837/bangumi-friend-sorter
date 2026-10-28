import { createFriendSortSession } from "../../src/workflow/session.mjs";
// Drives the production remote-sort session (createFriendSortSession) with a
// recording sort-bar substitute and a mock Bangumi HTTP adapter that returns
// normalized domain results, so tests exercise the same boundary the page uses
// at runtime and never fake HTTP responses, DOM documents or internal state.
function createSessionHarness({
  cache,
  friends,
  runtime,
  visitorIdentifier = "visitor",
  pageOwnerIdentifier = "visitor",
}) {
  let lastState = null;
  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });
  const session = createFriendSortSession({
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
    pageOwnerIdentifier,
  });
  session.start();
  return {
    finished,
    lastMessage: () => lastState?.statusMessage ?? "",
    lastState: () => lastState,
    session,
  };
}

export { createSessionHarness };
