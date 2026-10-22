import { initialize } from "../../src/page/initialize.mjs";
import { friendPageWith } from "./dom.mjs";
import { friendCacheStorage } from "./cache.mjs";

function refreshResponseFor(url) {
  return {
    ok: true,
    headers: { get: () => null },
    text: async () => (url.endsWith("/timeline") ? "timeline" : "profile"),
  };
}

async function initializeRefreshPage({
  confirm,
  domParser,
  entries,
  fetchImpl,
  now,
  records,
  visitorIdentifier = "visitor",
}) {
  const page = friendPageWith(entries);
  await initialize({
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

export { refreshResponseFor, initializeRefreshPage };
