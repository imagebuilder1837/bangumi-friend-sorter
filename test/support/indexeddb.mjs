import { IDBFactory } from "fake-indexeddb";

// Faults are injected at the browser database boundary, not at cache internals.
function controlledIndexedDB() {
  const factory = new IDBFactory();
  let abortNext = false;
  let databaseName;
  let databaseVersion;
  return {
    indexedDB: {
      open(name, version) {
        databaseName = name;
        databaseVersion = version;
        const request = factory.open(name, version);
        request.addEventListener("success", () => {
          const database = request.result;
          const transaction = database.transaction.bind(database);
          database.transaction = (...args) => {
            const result = transaction(...args);
            if (abortNext) {
              abortNext = false;
              queueMicrotask(() => result.abort());
            }
            return result;
          };
        });
        return request;
      },
    },
    abortNextTransaction() {
      abortNext = true;
    },
    upgrade() {
      return new Promise((resolve, reject) => {
        const request = factory.open(databaseName, databaseVersion + 1);
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    },
  };
}

export { controlledIndexedDB };
