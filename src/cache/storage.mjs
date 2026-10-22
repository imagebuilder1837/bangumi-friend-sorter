// src/cache/storage.mjs — native IndexedDB connection and atomic v3 import.
const DATABASE_NAME = "bangumi-friend-sorter:cache";
const MIGRATION_KEY = "legacy-v3-imported";

function replacesSaved(entry, saved) {
  const fetchedAt = saved?.record?.fetchedAt;
  return !Number.isFinite(fetchedAt) || entry.record.fetchedAt >= fetchedAt;
}

function openFriendCacheStorage({
  indexedDB,
  readLegacy,
  removeLegacy,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  return new Promise((resolve) => {
    let database;
    let legacy;
    let imported = false;
    let entries = [];
    let transaction;
    let settled = false;
    let migrationHandled = false;
    let timer;
    const fallback = () => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      try {
        transaction?.abort();
      } catch {
        /* Already finished. */
      }
      database?.close();
      resolve({
        entries: entries.length
          ? entries
          : migrationHandled
            ? []
            : (legacy ?? readLegacy()).entries,
      });
    };
    timer = setTimeoutImpl(fallback, 2_000);
    try {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onerror = fallback;
      request.onblocked = fallback;
      request.onupgradeneeded = () => {
        database = request.result;
        transaction = request.transaction;
        if (settled) {
          transaction.abort();
          database.close();
          return;
        }
        try {
          database.createObjectStore("values", { keyPath: "key" });
          database.createObjectStore("meta");
        } catch {
          fallback();
        }
      };
      request.onsuccess = () => {
        database = request.result;
        if (settled) {
          database.close();
          return;
        }
        database.onversionchange = () => database.close();
        try {
          transaction = database.transaction(["values", "meta"], "readwrite");
          const values = transaction.objectStore("values");
          const meta = transaction.objectStore("meta");
          transaction.onabort = fallback;
          transaction.oncomplete = () => {
            if (settled) return;
            settled = true;
            clearTimeoutImpl(timer);
            if (imported) removeLegacy();
            resolve({
              entries,
              close: () => database.close(),
              write(changes) {
                return new Promise((done) => {
                  let update;
                  const fail = () => {
                    try {
                      update?.abort();
                    } catch {
                      /* Already finished. */
                    }
                    done(false);
                  };
                  try {
                    update = database.transaction("values", "readwrite");
                    update.oncomplete = () => done(true);
                    update.onabort = () => done(false);
                    const store = update.objectStore("values");
                    for (const entry of changes) {
                      const existing = store.get(entry.key);
                      existing.onsuccess = () => {
                        try {
                          if (replacesSaved(entry, existing.result))
                            store.put(entry);
                        } catch {
                          fail();
                        }
                      };
                    }
                  } catch {
                    fail();
                  }
                });
              },
            });
          };
          const marker = meta.get(MIGRATION_KEY);
          marker.onsuccess = () => {
            try {
              migrationHandled = Boolean(marker.result);
              const saved = values.getAll();
              saved.onsuccess = () => {
                try {
                  entries = saved.result;
                  if (!marker.result) {
                    legacy = readLegacy();
                    if (legacy.readable) {
                      const merged = new Map(
                        entries.map((entry) => [
                          JSON.stringify(entry.key),
                          entry,
                        ]),
                      );
                      const changes = [];
                      for (const entry of legacy.entries) {
                        const token = JSON.stringify(entry.key);
                        if (replacesSaved(entry, merged.get(token))) {
                          merged.set(token, entry);
                          changes.push(entry);
                        }
                      }
                      entries = [...merged.values()];
                      for (const entry of changes) values.put(entry);
                      meta.put(true, MIGRATION_KEY);
                      imported = true;
                    }
                  }
                } catch {
                  fallback();
                }
              };
            } catch {
              fallback();
            }
          };
        } catch {
          fallback();
        }
      };
    } catch {
      fallback();
    }
  });
}

export { openFriendCacheStorage };
