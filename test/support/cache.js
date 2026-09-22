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
    getItem(key) {
      return key === "bangumi-friend-sorter:activity-cache:v3" ? value : null;
    },
    setItem(key, nextValue) {
      if (key === "bangumi-friend-sorter:activity-cache:v3") value = nextValue;
    },
    removeItem() {},
  };
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

module.exports = { friendCacheStorage, persistentFriendCacheStorage, storedCompletion, refreshCache, completionSnapshotFor };
