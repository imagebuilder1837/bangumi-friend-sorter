import { IDBFactory } from "fake-indexeddb";
import { createFriendCache } from "../../src/cache/friend-cache.mjs";

function friendCacheStorage(records) {
  return {
    getItem(key) {
      if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
      return JSON.stringify({ version: 3, records });
    },
    setItem() {},
    removeItem() {},
  };
}

function persistentFriendCacheStorage(initialValue = null) {
  let value = initialValue;
  return {
    indexedDB: new IDBFactory(),
    getItem(key) {
      return key === "bangumi-friend-sorter:activity-cache:v3" ? value : null;
    },
    setItem(key, nextValue) {
      if (key === "bangumi-friend-sorter:activity-cache:v3") value = nextValue;
    },
    removeItem(key) {
      if (key === "bangumi-friend-sorter:activity-cache:v3") value = null;
    },
  };
}

async function openPersistentCache(storage, options = {}) {
  const cache = createFriendCache(storage, {
    indexedDB: storage.indexedDB,
    ...options,
  });
  await cache.ready;
  return cache;
}

function storedCompletion(value, fetchedAt) {
  return { completion_all: { value, fetchedAt } };
}

function refreshCache(cache, entries, options) {
  const batch = cache.beginRefresh(options);
  for (const [userIdentifier, result] of entries) {
    batch.accept(userIdentifier, result);
  }
  batch.complete();
  return cache;
}

function completionSnapshotFor(cache, userIdentifier) {
  return Object.fromEntries(
    ["all", "1", "2", "3", "4", "6"].map((scope) => [
      scope,
      cache.completionFor(userIdentifier, scope),
    ]),
  );
}

export {
  friendCacheStorage,
  persistentFriendCacheStorage,
  openPersistentCache,
  storedCompletion,
  refreshCache,
  completionSnapshotFor,
};
