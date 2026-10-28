// ==UserScript==
// @name         Bangumi 好友排序
// @namespace    https://github.com/imagebuilder1837/bangumi-friend-sorter
// @version      0.3.3
// @description  为好友/反向好友页增加多种排序方式。
// @author       imagebuilder1837
// @match        https://bgm.tv/user/*/friends
// @match        https://bgm.tv/user/*/rev_friends
// @match        https://bangumi.tv/user/*/friends
// @match        https://bangumi.tv/user/*/rev_friends
// @match        https://chii.in/user/*/friends
// @match        https://chii.in/user/*/rev_friends
// @run-at       document-end
// @grant        none
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/imagebuilder1837/bangumi-friend-sorter/refs/heads/main/src/index.user.js
// @updateURL    https://raw.githubusercontent.com/imagebuilder1837/bangumi-friend-sorter/refs/heads/main/src/index.user.js
// ==/UserScript==

// Generated from src/main.mjs and its source module imports. Do not edit; run npm run build.
(function () {
  "use strict";

  // src/bangumi/identity.mjs — friend and visitor identifiers.

  // Normalizes a friend record to its stable cache and sort identity:
  // only a non-empty string identifier counts (see GLOSSARY.md, 用户标识).
  function userIdentifierFor(friend) {
    const identifier = friend?.userIdentifier;
    return typeof identifier === "string" && identifier ? identifier : null;
  }
  function positiveIntegerIdentifier(value) {
    const text = String(value ?? "").trim();
    if (!/^[1-9]\d*$/.test(text)) return null;
    return text;
  }

  function userIdentifierFromHref(href, baseUrl) {
    try {
      const pathname = new URL(href, baseUrl).pathname;
      const match = /^\/user\/([^/]+)\/?$/.exec(pathname);
      return match ? decodeURIComponent(match[1]) || null : null;
    } catch {
      return null;
    }
  }

  function currentVisitorIdentifier(pageDocument, pageWindow) {
    // Bangumi redirects numeric user paths to the default timeline and drops
    // the type query, so categorized timeline requests must prefer the stable
    // username path when the page exposes both identifiers.
    const visitorIdentifierCandidate = pageWindow?.CHOBITS_USERNAME;
    if (
      typeof visitorIdentifierCandidate === "string" &&
      visitorIdentifierCandidate.trim()
    ) {
      return visitorIdentifierCandidate.trim();
    }

    const uid = positiveIntegerIdentifier(pageWindow?.CHOBITS_UID);
    if (uid) return uid;

    const selectors = [
      "#headerNeue2 .idBadgerNeue a.avatar[href*='/user/']",
      "#headerNeue2 a.avatar[href*='/user/']",
      ".idBadgerNeue a.avatar[href*='/user/']",
    ];
    for (const selector of selectors) {
      let avatar;
      try {
        avatar = pageDocument?.querySelector?.(selector);
      } catch {
        continue;
      }
      const identifier = userIdentifierFromHref(
        avatar?.getAttribute?.("href"),
        pageWindow?.location?.href,
      );
      if (identifier) return identifier;
    }
    return null;
  }

  function currentPageOwnerIdentifier(pageDocument, pageWindow) {
    // 只读主页用户区，不能把全站页头的登录头像当作主页用户。
    const avatar = pageDocument.querySelector(
      "#headerProfile .headerAvatar a[href]",
    );
    const canonical = userIdentifierFromHref(
      avatar?.getAttribute("href"),
      pageWindow?.location?.href,
    );
    if (canonical) return canonical;
    try {
      const pathname = new URL(pageWindow?.location?.href).pathname;
      const match = /^\/user\/([^/]+)\/(?:friends|rev_friends)\/?$/.exec(
        pathname,
      );
      return match ? decodeURIComponent(match[1]) || null : null;
    } catch {
      return null;
    }
  }

  // src/sorting/choices.mjs — sorting choices and remote field shape.

  const SORT = Object.freeze({
    ACTIVITY: "activity",
    ADDED: "added",
    COMPLETION: "completion",
    NAME: "name",
    RELATION: "relation",
    TIETIE: "tietie",
  });
  const COMPLETION_SCOPE = Object.freeze({
    ALL: "all",
    ANIMATION: "2",
    BOOK: "1",
    MUSIC: "3",
    GAME: "4",
    REAL_LIFE: "6",
  });
  const DIRECTION = Object.freeze({
    ASCENDING: "asc",
    DESCENDING: "desc",
  });
  const REFRESH_STATUS = Object.freeze({
    COMPLETED: "completed",
    FETCHING: "fetching",
    IDLE: "idle",
    // 两阶段全量刷新的待命状态：提示再次点击以全量刷新，5 秒后自动清除。
    AWAITING_FULL_REFRESH: "armed",
    IDENTITY_REQUIRED: "identity",
  });
  const SORT_CHOICES = [
    { value: SORT.ADDED, label: "加好友时间" },
    { value: SORT.NAME, label: "名称" },
    { value: SORT.ACTIVITY, label: "上次活跃" },
    { value: SORT.TIETIE, label: "和 TA 贴贴" },
  ];
  const COMPLETION_CHOICES = [
    { value: COMPLETION_SCOPE.ALL, label: "全部" },
    { value: COMPLETION_SCOPE.ANIMATION, label: "动画" },
    { value: COMPLETION_SCOPE.BOOK, label: "书籍" },
    { value: COMPLETION_SCOPE.MUSIC, label: "音乐" },
    { value: COMPLETION_SCOPE.GAME, label: "游戏" },
    { value: COMPLETION_SCOPE.REAL_LIFE, label: "三次元" },
  ];
  const RELATION_CHOICES = [
    { value: "syncRate", label: "同步率" },
    { value: "commonLikes", label: "共同喜好数" },
  ];
  const REMOTE_TARGET_SELECTION_KEYS = Object.freeze({
    [SORT.ACTIVITY]: null,
    [SORT.COMPLETION]: "scope",
    [SORT.RELATION]: "metric",
    [SORT.TIETIE]: null,
  });

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

  // src/cache/friend-cache.mjs — friend metrics and recipient-scoped reactions.

  const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
  // Completion counts and relation metrics both come from profile pages and
  // share one validity window, so the TTL is named after the source.
  const PROFILE_CACHE_TTL_MS = 72 * 60 * 60 * 1_000;
  const TIETIE_CACHE_TTL_MS = 72 * 60 * 60 * 1_000;
  // v3 is an import-only localStorage format, independent of the database schema.
  const FRIEND_CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v3";
  const COMPLETION_CACHE_FIELD_PREFIX = "completion_";
  const RELATION_METRICS = new Set(RELATION_CHOICES.map(({ value }) => value));
  // 旧 v3 的空访问者映射不携带指标，但不能因此丢弃其他访问者的有效值；
  // 只有未知指标或无效指标记录使整个契合映射判为损坏。
  function isRelationMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    return Object.values(value).every((metrics) =>
      Object.entries(metrics || {}).every(
        ([metric, record]) =>
          RELATION_METRICS.has(metric) && isRelationRecord(record, metric),
      ),
    );
  }

  function isActivityRecord(value) {
    if (!value || !Number.isFinite(value.fetchedAt)) return false;
    if (value.kind === "empty") return true;
    return value.kind === "active" && Number.isInteger(value.activityAtSeconds);
  }

  function completionFieldFor(scope) {
    return `${COMPLETION_CACHE_FIELD_PREFIX}${scope}`;
  }

  function isCompletionRecord(value) {
    return Boolean(
      value &&
        typeof value === "object" &&
        Number.isSafeInteger(value.value) &&
        value.value >= 0 &&
        Number.isFinite(value.fetchedAt),
    );
  }

  function tietieCountEntries(value) {
    if (value instanceof Map) return [...value.entries()];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return Object.entries(value);
  }

  function normalizedTietieRecord(value) {
    if (
      !value ||
      typeof value !== "object" ||
      !Number.isFinite(value.fetchedAt)
    ) {
      return null;
    }
    const entries = tietieCountEntries(value.counts);
    if (
      !entries ||
      !entries.every(
        ([userIdentifier, count]) =>
          typeof userIdentifier === "string" &&
          userIdentifier.trim() &&
          Number.isSafeInteger(count) &&
          count >= 0,
      )
    ) {
      return null;
    }
    return {
      counts: new Map(entries),
      fetchedAt: value.fetchedAt,
    };
  }

  function serializedTietieRecord(record) {
    return {
      counts: Object.fromEntries(record.counts),
      fetchedAt: record.fetchedAt,
    };
  }

  // The record envelope (finite value + fetch time) is shared; each 契合指标
  // only constrains its own value, so the metric branch lives in this table.
  const RELATION_VALUE_VALIDATORS = Object.freeze({
    commonLikes: (value) => Number.isInteger(value) && value >= 0,
    syncRate: Number.isFinite,
  });

  function isRelationRecord(value, metric) {
    return Boolean(
      value &&
        typeof value === "object" &&
        Number.isFinite(value.fetchedAt) &&
        RELATION_VALUE_VALIDATORS[metric]?.(value.value),
    );
  }

  // The fields this cache persists are fixed (activity, visitor-nested
  // relation, per-scope completion), so the validators are built in rather
  // than taken from callers.
  function completionCacheFieldValidators() {
    return Object.fromEntries(
      COMPLETION_CHOICES.map(({ value: scope }) => [
        completionFieldFor(scope),
        isCompletionRecord,
      ]),
    );
  }

  // 好友字段与接收方级贴贴结果的唯一领域读写边界。
  // 先等待 ready 完成初始化；之后领域读取只访问内存，缺失返回 undefined。
  // beginRefresh.accept 同步接纳有效结果；complete 只能调用一次，返回
  // Promise<boolean> 表示本次持久化是否提交。replaceTietie 同步返回结果
  // 是否被接纳，不保证落盘；它只接受完整的接收方统计。
  // 存储失败不向调用方抛错，未落盘变更保留到下次正常提交；close 释放
  // 连接并停用本实例的持久化，不丢弃页面内存。首个参数仅供旧 v3 导入。
  function createFriendCache(
    storage,
    { now = Date.now, indexedDB, setTimeoutImpl, clearTimeoutImpl } = {},
  ) {
    const records = new Map();
    const tietieRecords = new Map();
    const dirty = new Map();
    const validators = new Map([
      ["activity", isActivityRecord],
      ["relation", isRelationMap],
      ...Object.entries(completionCacheFieldValidators()),
    ]);

    function readLegacy() {
      try {
        if (!storage?.getItem) return { readable: false, entries: [] };
        const raw = storage.getItem(FRIEND_CACHE_STORAGE_KEY);
        let saved;
        try {
          saved = JSON.parse(raw || "null");
        } catch {
          saved = null;
        }
        return { readable: true, entries: entriesFromLegacy(saved) };
      } catch {
        return { readable: false, entries: [] };
      }
    }

    function removeLegacy() {
      try {
        storage?.removeItem?.(FRIEND_CACHE_STORAGE_KEY);
      } catch {
        // The committed database marker prevents repeated import.
      }
    }

    function validatorFor(field) {
      return validators.get(field) || null;
    }

    function validateFields(value) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return {};

      const fields = {};
      for (const [field, fieldValue] of Object.entries(value)) {
        const validator = validatorFor(field);
        if (typeof validator === "function" && validator(fieldValue)) {
          fields[field] = fieldValue;
        }
      }
      return fields;
    }

    function entriesFromLegacy(saved) {
      const entries = [];
      if (saved?.version !== 3) return entries;
      if (
        saved.records &&
        typeof saved.records === "object" &&
        !Array.isArray(saved.records)
      ) {
        for (const [identifier, value] of Object.entries(saved.records)) {
          for (const [field, record] of Object.entries(validateFields(value))) {
            if (field === "relation") {
              for (const [visitor, metrics] of Object.entries(record)) {
                for (const [metric, result] of Object.entries(metrics || {})) {
                  entries.push({
                    key: ["relation", identifier, visitor, metric],
                    record: result,
                  });
                }
              }
            } else {
              entries.push({ key: [field, identifier], record });
            }
          }
        }
      }
      if (
        saved.tietie &&
        typeof saved.tietie === "object" &&
        !Array.isArray(saved.tietie)
      ) {
        for (const [recipient, value] of Object.entries(saved.tietie)) {
          const record = normalizedTietieRecord(value);
          if (recipient.trim() && record)
            entries.push({
              key: ["tietie", recipient],
              record: serializedTietieRecord(record),
            });
        }
      }
      return entries;
    }

    function loadEntry({ key, record } = {}) {
      if (!Array.isArray(key) || !key.every((part) => typeof part === "string"))
        return;
      const [field, identifier, visitor, metric] = key;
      if (field === "tietie" && key.length === 2) {
        const value = normalizedTietieRecord(record);
        if (identifier.trim() && value) tietieRecords.set(identifier, value);
      } else if (field === "relation" && key.length === 4) {
        if (visitor && isRelationRecord(record, metric))
          setRelationField(identifier, visitor, metric, record);
      } else if (field !== "relation" && key.length === 2) {
        setField(identifier, field, record);
      }
    }

    function remember(key, record) {
      const entry = { key, record };
      dirty.set(JSON.stringify(key), entry);
    }

    function persist() {
      const snapshot = [...dirty.values()];
      if (!persistence?.write || closed) return Promise.resolve(false);
      return persistence.write(snapshot).then((committed) => {
        if (committed) {
          for (const entry of snapshot) {
            const token = JSON.stringify(entry.key);
            if (dirty.get(token) === entry) dirty.delete(token);
          }
        }
        return committed;
      });
    }

    let persistence;
    let closed = false;
    const ready = indexedDB
      ? openFriendCacheStorage({
          indexedDB,
          readLegacy,
          removeLegacy,
          setTimeoutImpl,
          clearTimeoutImpl,
        }).then((result) => {
          if (closed) {
            result.close?.();
            return;
          }
          persistence = result;
          for (const entry of result.entries) loadEntry(entry);
          dirty.clear();
        })
      : (readLegacy().entries.forEach(loadEntry),
        dirty.clear(),
        Promise.resolve());

    function fieldFor(userIdentifier, field) {
      return records.get(userIdentifier)?.[field];
    }

    function relationRecordFor(userIdentifier, relationSelection) {
      const { metric, visitorIdentifier } = relationSelection ?? {};
      return records.get(userIdentifier)?.relation?.[visitorIdentifier]?.[
        metric
      ];
    }

    function setField(userIdentifier, field, value) {
      const validator = validatorFor(field);
      if (typeof validator !== "function" || !validator(value)) return;
      const fields = records.get(userIdentifier) || {};
      fields[field] = value;
      records.set(userIdentifier, fields);
      remember([field, userIdentifier], value);
    }

    function setRelationField(
      userIdentifier,
      visitorIdentifier,
      metric,
      value,
    ) {
      if (!visitorIdentifier || !isRelationRecord(value, metric)) return;
      const fields = records.get(userIdentifier) || {};
      records.set(userIdentifier, {
        ...fields,
        relation: {
          ...fields.relation,
          [visitorIdentifier]: {
            ...fields.relation?.[visitorIdentifier],
            [metric]: value,
          },
        },
      });
      remember(["relation", userIdentifier, visitorIdentifier, metric], value);
    }

    // 兼容旧贴贴接口与持久化键 ["tietie", identifier]，不迁移格式。
    // identifier 现指贴贴接收方；旧实现中登录访问者恰好也是接收方，
    // 因此旧结果仍可复用，但不能按当前登录身份选表或自动合并别名。
    function tietieFor(recipientIdentifier) {
      const record = tietieRecords.get(recipientIdentifier);
      return record
        ? { counts: new Map(record.counts), fetchedAt: record.fetchedAt }
        : undefined;
    }

    const cache = {
      ready,
      close() {
        closed = true;
        persistence?.close?.();
      },
      activityFor(userIdentifier) {
        return fieldFor(userIdentifier, "activity");
      },
      completionFor(userIdentifier, scope) {
        return fieldFor(userIdentifier, completionFieldFor(scope));
      },
      relationFor(userIdentifier, relationSelection) {
        return relationRecordFor(userIdentifier, relationSelection);
      },
      tietieFor,
      tietieNeedsRefresh(recipientIdentifier) {
        const record = tietieRecords.get(recipientIdentifier);
        return !record || now() - record.fetchedAt > TIETIE_CACHE_TTL_MS;
      },
      replaceTietie(recipientIdentifier, result) {
        if (
          typeof recipientIdentifier !== "string" ||
          !recipientIdentifier.trim()
        ) {
          return false;
        }
        const record = normalizedTietieRecord(result);
        if (!record) return false;
        tietieRecords.set(recipientIdentifier, record);
        remember(
          ["tietie", recipientIdentifier],
          serializedTietieRecord(record),
        );
        persist();
        return true;
      },
      friendsNeedingRefresh(friends, target, { mode = "incremental" } = {}) {
        if (mode === "full") return [...friends];
        const targetReaders = {
          [SORT.ACTIVITY]: {
            read: (userIdentifier) => cache.activityFor(userIdentifier),
            ttlMs: CACHE_TTL_MS,
          },
          [SORT.COMPLETION]: {
            read: (userIdentifier) =>
              cache.completionFor(userIdentifier, target?.scope),
            ttlMs: PROFILE_CACHE_TTL_MS,
          },
          [SORT.RELATION]: {
            read: (userIdentifier) =>
              cache.relationFor(userIdentifier, {
                metric: target?.metric,
                visitorIdentifier: target?.visitorIdentifier,
              }),
            ttlMs: PROFILE_CACHE_TTL_MS,
          },
        };
        const policy = targetReaders[target?.kind];
        if (!policy) return [];
        const currentTime = now();
        return friends.filter((friend) => {
          const record = policy.read(userIdentifierFor(friend));
          return !record || currentTime - record.fetchedAt > policy.ttlMs;
        });
      },
      beginRefresh({ visitorIdentifier } = {}) {
        let completed = false;
        return {
          accept(userIdentifier, result) {
            if (completed || !userIdentifier || !result) return this;
            if (result.activity) {
              setField(userIdentifier, "activity", result.activity);
            }
            for (const [scope, value] of Object.entries(
              result.completion || {},
            )) {
              setField(userIdentifier, completionFieldFor(scope), {
                value,
                fetchedAt: result.fetchedAt,
              });
            }
            if (visitorIdentifier) {
              for (const [metric, value] of Object.entries(
                result.relation || {},
              )) {
                setRelationField(userIdentifier, visitorIdentifier, metric, {
                  value,
                  fetchedAt: result.fetchedAt,
                });
              }
            }
            return this;
          },
          complete() {
            if (completed) {
              throw new Error("好友缓存刷新批次只能完成一次");
            }
            completed = true;
            return persist();
          },
        };
      },
    };
    return cache;
  }

  // src/sorting/order.mjs — stable ordering and direction labels.

  function compareReliableNumbers(
    left,
    right,
    { isAscending, leftValue, rightValue },
  ) {
    const leftHasValue = Number.isFinite(leftValue);
    const rightHasValue = Number.isFinite(rightValue);

    if (leftHasValue && rightHasValue) {
      const valueComparison =
        leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      return valueComparison * (isAscending ? 1 : -1);
    }
    if (leftHasValue) return -1;
    if (rightHasValue) return 1;
    return 0;
  }

  // sortFriends receives the current display order, so returning zero for a
  // tie lets the stable array sort preserve that order across re-sorts.
  // 上次活跃, 完成条目数 and 喜好契合 all rank by a reliable numeric value:
  // each sort only declares how to read one side's value.
  function numericValueCompare(readValue) {
    return (left, right, context) =>
      compareReliableNumbers(left, right, {
        isAscending: context.isAscending,
        leftValue: readValue(left, context),
        rightValue: readValue(right, context),
      });
  }

  const SORT_CONFIG = Object.freeze({
    [SORT.ADDED]: {
      defaultDirection: DIRECTION.ASCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "从旧到新",
        [DIRECTION.DESCENDING]: "从新到旧",
      }),
      compare(left, right, { isAscending }) {
        return (
          (left.originalIndex - right.originalIndex) * (isAscending ? 1 : -1)
        );
      },
    },
    [SORT.NAME]: {
      defaultDirection: DIRECTION.ASCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "升序",
        [DIRECTION.DESCENDING]: "降序",
      }),
      compare(left, right, { collator, isAscending }) {
        return (
          (isAscending ? 1 : -1) *
          collator.compare(left.displayName, right.displayName)
        );
      },
    },
    [SORT.ACTIVITY]: {
      defaultDirection: DIRECTION.DESCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "从旧到新",
        [DIRECTION.DESCENDING]: "从新到旧",
      }),
      compare: numericValueCompare((friend, { friendCache }) => {
        const activity = friendCache.activityFor(userIdentifierFor(friend));
        return activity?.kind === "active" ? activity.activityAtSeconds : null;
      }),
    },
    [SORT.COMPLETION]: {
      defaultDirection: DIRECTION.DESCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "从低到高",
        [DIRECTION.DESCENDING]: "从高到低",
      }),
      compare: numericValueCompare(
        (friend, { completionScope, friendCache }) => {
          const completion = friendCache.completionFor(
            userIdentifierFor(friend),
            completionScope,
          );
          return isCompletionRecord(completion) ? completion.value : null;
        },
      ),
    },
    [SORT.RELATION]: {
      defaultDirection: DIRECTION.DESCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "从低到高",
        [DIRECTION.DESCENDING]: "从高到低",
      }),
      compare: numericValueCompare(
        (friend, { relationSelection, friendCache }) => {
          const relation = friendCache.relationFor(
            userIdentifierFor(friend),
            relationSelection,
          );
          return isRelationRecord(relation, relationSelection.metric)
            ? relation.value
            : null;
        },
      ),
    },
    [SORT.TIETIE]: {
      defaultDirection: DIRECTION.DESCENDING,
      directionLabels: Object.freeze({
        [DIRECTION.ASCENDING]: "从低到高",
        [DIRECTION.DESCENDING]: "从高到低",
      }),
      compare: numericValueCompare((friend, { tietieResult }) => {
        if (!tietieResult?.complete) return null;
        return tietieResult.counts.get(userIdentifierFor(friend)) ?? 0;
      }),
    },
  });
  // SORT is a closed enum: every criterion above declares a config, so these
  // readers index directly and an unknown criterion surfaces immediately.
  function directionLabelsFor(criterion) {
    return { ...SORT_CONFIG[criterion].directionLabels };
  }

  function defaultDirectionFor(criterion) {
    return SORT_CONFIG[criterion].defaultDirection;
  }

  function isAscendingDirection(direction, criterion) {
    const effectiveDirection = direction || defaultDirectionFor(criterion);
    return effectiveDirection === DIRECTION.ASCENDING;
  }

  function relationSelectionFor(relationSelection) {
    return { metric: RELATION_CHOICES[0].value, ...relationSelection };
  }

  // 展示名称比较的唯一配置点：数值感知、大小写不敏感；sortFriends
  // 默认参数与页面初始化共享同一工厂。
  function nameCollator() {
    return new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  function sortFriends(
    friends,
    {
      criterion,
      // Required for the remote sorts (activity/completion/relation); local
      // sorts (added/name) never touch the friend cache.
      friendCache,
      collator = nameCollator(),
      direction,
      completionScope = COMPLETION_SCOPE.ALL,
      relationSelection,
      tietieResult,
    } = {},
  ) {
    const sorted = [...friends];
    const isAscending = isAscendingDirection(direction, criterion);

    const sortConfig = SORT_CONFIG[criterion];
    if (sortConfig?.compare) {
      // Each compare destructures only the context slice it sorts by; the
      // visitor-scoped relation parts travel together as one selection.
      sorted.sort((left, right) =>
        sortConfig.compare(left, right, {
          collator,
          completionScope,
          isAscending,
          relationSelection: relationSelectionFor(relationSelection),
          friendCache,
          tietieResult,
        }),
      );
    }

    return sorted;
  }

  // src/page/errors.mjs — visible failures, separate from refresh progress.
  function createPageErrorReporter(
    pageDocument,
    { list, logger = pageDocument.defaultView?.console ?? console },
  ) {
    const reported = new Set();
    let notice;
    return (stage, error) => {
      if (reported.has(error)) return;
      reported.add(error);
      logger.error(`好友排序：${stage}失败`, error);
      if (!notice) {
        notice = pageDocument.createElement("p");
        notice.setAttribute("role", "alert");
        list.before(notice);
      }
      notice.textContent = `好友排序：${stage}失败：${error?.message ?? String(error)}`;
    };
  }

  // src/page/sort-bar.mjs — sort controls and DOM presentation.

  function installStyles(document) {
    const style = document.createElement("style");
    // The site styles #browserTools itself, but its filter rules target links.
    // These button rules mirror them; aria-current remains semantic only.
    // See docs/spec/ui.md, "原站样式基线", for the verified source and selectors.
    style.textContent = `
    #bangumi-friend-sorter.filters {
      align-items: baseline;
      display: flex;
      flex-wrap: wrap;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-sort-options,
    #bangumi-friend-sorter .bangumi-friend-sorter-direction-options {
      align-items: baseline;
      display: flex;
      flex-wrap: wrap;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-direction-options {
      margin-left: auto;
    }
    #browserTools.bangumi-friend-sorter-bar {
      box-sizing: border-box;
      width: 100%;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown {
      display: inline-block;
      position: relative;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown-menu {
      -webkit-backdrop-filter: blur(5px);
      backdrop-filter: blur(5px);
      background-color: rgba(254, 254, 254, .9);
      border-radius: 15px;
      box-shadow: inset 0 1px 1px hsla(0, 100%, 100%, .3),
        inset 0 -1px 0 hsla(0, 100%, 100%, .1),
        0 3px 15px hsla(214, 100%, 0%, .2);
      display: flex;
      flex-direction: column;
      left: -5px;
      opacity: 0;
      padding: 4px 0;
      pointer-events: none;
      position: absolute;
      top: 100%;
      transform: translateY(-4px);
      transition: opacity .15s ease, transform .15s ease, visibility .15s;
      visibility: hidden;
      width: max-content;
      min-width: 118px;
      z-index: 10;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown[data-open="true"]
      .bangumi-friend-sorter-dropdown-menu,
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown:hover
      .bangumi-friend-sorter-dropdown-menu,
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown:focus-within
      .bangumi-friend-sorter-dropdown-menu {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
      visibility: visible;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown-menu button.l {
      border-radius: 100px;
      box-sizing: border-box;
      font-size: 12px;
      line-height: 100%;
      margin: 2px 5px;
      padding: 7px 15px;
      text-align: left;
      transition: all .2s ease-in-out;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown-menu button.l:hover,
    #bangumi-friend-sorter
      .bangumi-friend-sorter-dropdown-menu button.l:focus-visible {
      background: #369cf8;
      color: #fff;
    }
    html[data-theme="dark"] #bangumi-friend-sorter
      .bangumi-friend-sorter-dropdown-menu {
      background-color: rgba(80, 80, 80, .7);
    }
    html[data-theme="dark"] #bangumi-friend-sorter
      .bangumi-friend-sorter-dropdown-menu button.l {
      color: #fff;
    }
    /* CSS has no // comments: one would be absorbed into the next
       selector, silently dropping the whole rule. */
    /* Keep a one-space gap between the fixed "按"/"排序" labels and the
       adjacent buttons so hover/focus backgrounds never touch the text. */
    #bangumi-friend-sorter .bangumi-friend-sorter-prefix {
      margin-right: .25em;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-suffix {
      margin-left: .25em;
    }
    #bangumi-friend-sorter button.l {
      appearance: none;
      background: none;
      border: 0;
      border-radius: 15px;
      color: #0084b4;
      cursor: pointer;
      font: inherit;
      margin: 0;
      padding: 2px 8px;
    }
    html[data-theme="dark"] #bangumi-friend-sorter button.l {
      color: #2ea6ff;
    }
    #bangumi-friend-sorter button.l:hover,
    #bangumi-friend-sorter button.l:focus-visible {
      background: var(--primary-color, #f09199);
      color: #fff;
      text-decoration: none;
    }
    #bangumi-friend-sorter-status {
      color: #999;
      margin-left: .6em;
    }
    /* 名次 badge: the host strong is the site's name block whose bottom
       border is the gray rule; the badge hangs just below that line,
       flush with its right end. */
    #memberUserList div.userContainer > strong {
      position: relative;
    }
    #memberUserList .bangumi-friend-sorter-rank {
      color: #000;
      font-weight: bold;
      position: absolute;
      right: 0;
      top: 100%;
    }
    html[data-theme="dark"] #memberUserList
      .bangumi-friend-sorter-rank {
      color: #ddd;
    }
  `;
    document.head.append(style);
  }

  function setAriaCurrent(button, isCurrent) {
    if (isCurrent) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }

  // 可见好友的判定交给浏览器的 checkVisibility，覆盖所有隐藏途径；
  // 不可用时回退到内联 display 检查，兼容以 style.display 隐藏条目的
  // 组件（如好友标签筛选，见 ADR 0002）。
  function isEntryVisible(element) {
    if (typeof element.checkVisibility === "function") {
      return element.checkVisibility();
    }
    return element.style?.display !== "none";
  }

  // 列表层可呈现判定（ADR 0007）：好友视图整体是否可呈现。与条目级
  // 同构：checkVisibility 覆盖一切隐藏途径（含祖先驱动的显隐），不可用
  // 时回退到内联 display 检查——回退下祖先驱动的显隐不可感知，属可
  // 接受降级。最终是否可见统一由本判定决定，observer 只负责触发。
  function isListPresentable(list) {
    if (typeof list.checkVisibility === "function") {
      return list.checkVisibility();
    }
    return list.style?.display !== "none";
  }

  // 排序栏 deep module：排序交互与呈现的唯一边界。`bind` 一次性接收领域
  // 意图回调（选择排序目标、切换方向），`render` 幂等地接收可呈现状态；
  // 菜单、按钮、方向文案、状态提示、名次、ARIA、输入模态、焦点与展开
  // 状态全部留在模块内部，调用方不持有或修改任何原始 DOM 节点。列表项
  // 与名次锚点由排序栏自行从 list 读取，render 收到的好友记录只携带
  // 领域数据并以 originalIndex（网页默认顺序位置）定位条目。模块不
  // 发起远程请求，也不决定刷新策略。
  // 接口约定：bind 必须在首次 render 前恰好调用一次（相对 mount 的先后
  // 不限）；render 接收完整的可呈现状态，重复调用安全，展示顺序不变时
  // 跳过重排与名次更新。
  function createSortBar(
    pageDocument,
    {
      list,
      elements = Array.from(list.children),
      mutationObserver,
      reportError = createPageErrorReporter(pageDocument, { list }),
    } = {},
  ) {
    const bar = pageDocument.createElement("div");
    // Reuse the site's #browserTools frame, including its horizontal borders.
    bar.id = "browserTools";
    bar.className = "clearit bangumi-friend-sorter-bar";
    bar.dataset.friendSorter = "";
    bar.setAttribute("aria-label", "好友排序");

    // 领域意图只通过 bind 声明的回调离开排序栏；绑定前发生的事件（正常
    // 时序下不可能）被静默忽略。
    let handlers = null;

    function run(stage, operation) {
      try {
        return operation();
      } catch (error) {
        lastOrderElements = null;
        lastVisibleElements = null;
        reportError(stage, error);
        throw error;
      }
    }

    function bind({ selectCriterion, selectDirection }) {
      if (handlers) throw new Error("排序栏的意图回调只能绑定一次");
      handlers = {
        selectCriterion: (...args) =>
          run("排序选择", () => selectCriterion(...args)),
        selectDirection: (direction) =>
          run("排序方向切换", () => selectDirection(direction)),
      };
    }

    const filters = pageDocument.createElement("div");
    filters.className = "filters";
    filters.id = "bangumi-friend-sorter";

    const sortOptions = pageDocument.createElement("span");
    sortOptions.className = "bangumi-friend-sorter-sort-options";
    // Bare text nodes are anonymous flex items and cannot carry margins, so
    // the fixed labels get wrapper spans for the breathing-room gaps.
    const prefix = pageDocument.createElement("span");
    prefix.className = "bangumi-friend-sorter-prefix";
    prefix.textContent = "按";
    sortOptions.append(prefix);

    const buttons = new Map();
    for (const { value: criterion, label } of SORT_CHOICES) {
      const button = pageDocument.createElement("button");
      button.type = "button";
      button.className = "l";
      button.textContent = label;
      button.addEventListener("click", () =>
        handlers?.selectCriterion(criterion),
      );
      sortOptions.append(button);
      buttons.set(criterion, button);
    }

    function createDropdown({
      id,
      label,
      choices,
      onDefaultSelect,
      onSelect: onChoiceSelect,
    }) {
      const dropdown = pageDocument.createElement("span");
      dropdown.className = "bangumi-friend-sorter-dropdown";

      const toggle = pageDocument.createElement("button");
      toggle.type = "button";
      toggle.className = "l bangumi-friend-sorter-dropdown-toggle";
      toggle.textContent = label;
      toggle.setAttribute("aria-haspopup", "true");
      toggle.setAttribute("aria-controls", id);
      toggle.addEventListener("click", () => {
        onDefaultSelect();
        toggle.focus?.();
      });

      const menu = pageDocument.createElement("span");
      menu.id = id;
      menu.className = "bangumi-friend-sorter-dropdown-menu";
      menu.setAttribute("role", "menu");
      const buttons = new Map();
      for (const { value, label: choiceLabel } of choices) {
        const button = pageDocument.createElement("button");
        button.type = "button";
        button.className = "l";
        button.textContent = choiceLabel;
        button.setAttribute("role", "menuitem");
        button.addEventListener("click", () => onChoiceSelect(value));
        menu.append(button);
        buttons.set(value, button);
      }

      function setMenuOpen(isOpen) {
        dropdown.dataset.open = String(isOpen);
        toggle.setAttribute("aria-expanded", String(isOpen));
      }

      function isInsideDropdown(node) {
        return Boolean(dropdown.contains?.(node));
      }

      // Input modality of whichever pointer/keyboard interaction last took
      // focus inside the dropdown; null means programmatic or unknown focus.
      // Mouse-created focus is transient: it is released when the pointer
      // leaves, while touch/keyboard focus intentionally persists (see ADR 0001).
      let focusModality = null;

      dropdown.addEventListener("pointerdown", (event) => {
        focusModality = event.pointerType || "pointer";
      });

      function keepMenuOpenOnFocus(button) {
        button.addEventListener("focus", () => setMenuOpen(true));
        button.addEventListener("focusout", (event) => {
          if (!isInsideDropdown(event.relatedTarget)) {
            focusModality = null;
            setMenuOpen(false);
          }
        });
        button.addEventListener("keydown", (event) => {
          // 按键不接管焦点：只有键盘创建或来源不明的焦点才改记键盘模态，
          // 鼠标点击创建的焦点不因后续按键改变归属，指针离开时仍按
          // ADR-0001 释放。
          if (focusModality !== "mouse") focusModality = "keyboard";
          // 键盘创建的焦点按 ADR-0001 持久保留，Esc 不主动释放焦点。
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault?.();
          button.click();
        });
      }

      dropdown.addEventListener("pointerenter", () => setMenuOpen(true));
      dropdown.addEventListener("pointerleave", (event) => {
        // A desktop mouse click focuses the toggle; when that focus itself
        // came from the mouse, leaving the dropdown releases it so the menu
        // closes instead of lingering.
        if (
          event.pointerType === "mouse" &&
          focusModality === "mouse" &&
          isInsideDropdown(pageDocument.activeElement)
        ) {
          pageDocument.activeElement.blur?.();
          setMenuOpen(false);
          return;
        }
        if (!isInsideDropdown(pageDocument.activeElement)) setMenuOpen(false);
      });
      keepMenuOpenOnFocus(toggle);
      for (const button of buttons.values()) keepMenuOpenOnFocus(button);
      setMenuOpen(false);

      dropdown.append(toggle, menu);
      return { dropdown, button: toggle, menu, buttons };
    }

    const completionControl = createDropdown({
      id: "bangumi-friend-sorter-completion-menu",
      label: "完成条目数",
      choices: COMPLETION_CHOICES,
      onDefaultSelect: () =>
        handlers?.selectCriterion(SORT.COMPLETION, COMPLETION_SCOPE.ALL),
      onSelect: (scope) => handlers?.selectCriterion(SORT.COMPLETION, scope),
    });
    const completionDropdown = completionControl.dropdown;

    const relationControl = createDropdown({
      id: "bangumi-friend-sorter-relation-menu",
      label: "喜好契合",
      choices: RELATION_CHOICES,
      onDefaultSelect: () =>
        handlers?.selectCriterion(SORT.RELATION, RELATION_CHOICES[0].value),
      onSelect: (metric) => handlers?.selectCriterion(SORT.RELATION, metric),
    });
    const relationDropdown = relationControl.dropdown;

    sortOptions.append(relationDropdown);
    sortOptions.append(completionDropdown);

    const suffix = pageDocument.createElement("span");
    suffix.className = "bangumi-friend-sorter-suffix";
    suffix.textContent = "排序";
    sortOptions.append(suffix);
    const status = pageDocument.createElement("span");
    status.id = "bangumi-friend-sorter-status";
    status.setAttribute("aria-live", "polite");
    sortOptions.append(status);

    const directionOptions = pageDocument.createElement("span");
    directionOptions.className = "bangumi-friend-sorter-direction-options";
    const directionButtons = new Map();
    const initialDirectionLabels = directionLabelsFor(SORT.ADDED);
    for (const direction of [DIRECTION.ASCENDING, DIRECTION.DESCENDING]) {
      const button = pageDocument.createElement("button");
      button.type = "button";
      button.className = "l";
      button.textContent = initialDirectionLabels[direction];
      button.addEventListener("click", () =>
        handlers?.selectDirection(direction),
      );
      directionOptions.append(button);
      directionButtons.set(direction, button);
    }

    filters.append(sortOptions, directionOptions);
    bar.append(filters);

    // 挂载复用原站 .mainWrapper 布局：排序栏插入 .columns 之前占据整行；
    // 布局不符合预期时不修改页面。站点样式复用与必要 CSS 属于本模块，
    // 在挂载成功后注入。
    function mount() {
      const canWalkAncestors = typeof list.closest === "function";
      let mainWrapper = canWalkAncestors ? list.closest(".mainWrapper") : null;
      if (!mainWrapper && !canWalkAncestors) {
        try {
          mainWrapper = pageDocument.querySelector?.(".mainWrapper");
        } catch {
          // Lightweight test doubles may only implement the list selector.
        }
      }
      const columns = mainWrapper?.querySelector?.(".columns");
      if (
        mainWrapper &&
        columns &&
        typeof mainWrapper.insertBefore === "function"
      ) {
        mainWrapper.insertBefore(bar, columns);
        installStyles(pageDocument);
        return true;
      }
      if (!canWalkAncestors) {
        list.before(bar);
        installStyles(pageDocument);
        return true;
      }
      return false;
    }

    // 名次徽章按需创建：锚点是排序栏自行读取的原站名称块，初始名次
    // 随第一次 render 按当时展示顺序标注。
    let friendEntries = null;

    // 列表项与名次锚点由排序栏一次性自读，调用方的好友记录只携带
    // 领域数据；条目按网页默认顺序定位，与记录的 originalIndex 对齐。
    function readFriendEntries() {
      friendEntries = Array.from(elements, (element) => ({
        element,
      }));
      return friendEntries;
    }

    function entryFor(friend) {
      const entries = friendEntries ?? readFriendEntries();
      const entry = entries[friend.originalIndex];
      if (!entry) {
        throw new Error(`未知的好友条目：${friend.originalIndex}`);
      }
      return entry;
    }

    function rankBadgeFor(entry) {
      if (!entry.badge) {
        const rankHost = entry.element.querySelector(".userContainer strong");
        if (!rankHost)
          throw new Error("名次渲染缺少好友名称块 .userContainer strong");
        const badge = pageDocument.createElement("span");
        badge.className = "bangumi-friend-sorter-rank";
        rankHost.append(badge);
        entry.badge = badge;
      }
      return entry.badge;
    }

    let lastOrderElements = null;
    let lastVisibleElements = null;
    // 最近一次收到的可呈现状态：可见性观察回调重放它以重排名次。
    let lastState = null;
    // 最近一次已知的列表层表现状态：祖先观察回调的廉价门控基准，
    // render 是唯一写入者；null 表示尚未渲染、状态未知。
    let lastPresentable = null;

    // 幂等呈现：当前选择、方向文案、菜单选中态、刷新状态提示与好友名次
    // 都由这一次渲染更新。展示顺序与上次相同（例如只有状态提示变化）时
    // 跳过重排，保持既有 DOM 操作量级。名次只对可见好友（见 GLOSSARY.md）
    // 连续编号：可见集合变化而顺序未变时只重写名次、不移动列表项，
    // 隐藏项徽章保留旧文本。调用方始终传入完整的可呈现状态。
    function render(state) {
      return run("排序栏渲染", () => renderState(state));
    }

    function renderState(state) {
      lastState = state;
      const { criterion, direction, selection, statusMessage, orderedFriends } =
        state;
      for (const [value, button] of buttons) {
        setAriaCurrent(button, value === criterion);
      }
      setAriaCurrent(completionControl.button, criterion === SORT.COMPLETION);
      setAriaCurrent(relationControl.button, criterion === SORT.RELATION);
      for (const [scope, button] of completionControl.buttons) {
        setAriaCurrent(
          button,
          criterion === SORT.COMPLETION && scope === selection,
        );
      }
      for (const [metric, button] of relationControl.buttons) {
        setAriaCurrent(
          button,
          criterion === SORT.RELATION && metric === selection,
        );
      }
      const labels = directionLabelsFor(criterion);
      for (const [value, button] of directionButtons) {
        button.textContent = labels[value];
        setAriaCurrent(button, value === direction);
      }
      if (status.textContent !== statusMessage) {
        status.textContent = statusMessage;
      }

      // 列表层检查（ADR 0007）：整个好友视图不可呈现时进入呈现挂起——
      // 只保留最新状态，把排序与可见性呈现缓存标记为未知（null），跳过
      // 列表 DOM 重排与名次更新。恢复可呈现后凭 null 语义从真实 DOM
      // 开始 reconciliation，补上挂起期间错过的重排与名次。
      const presentable = isListPresentable(list);
      lastPresentable = presentable;
      if (!presentable) {
        lastOrderElements = null;
        lastVisibleElements = null;
        return;
      }

      const renderEntries = orderedFriends.map(entryFor);
      const elements = renderEntries.map((entry) => entry.element);
      const visibleEntries = renderEntries.filter((entry) =>
        isEntryVisible(entry.element),
      );
      const visibleElements = visibleEntries.map((entry) => entry.element);
      const currentElements = lastOrderElements ?? Array.from(list.children);
      const orderChanged =
        currentElements.length !== elements.length ||
        currentElements.some((element, index) => element !== elements[index]);
      const ranksChanged =
        lastVisibleElements === null ||
        lastVisibleElements.length !== visibleElements.length ||
        lastVisibleElements.some(
          (element, index) => element !== visibleElements[index],
        );
      lastOrderElements = elements;
      lastVisibleElements = visibleElements;
      // 已就位且可见集合未变的重复渲染连名次都不重写；首渲染由
      // lastVisibleElements 为空触发，补齐初始名次。
      if (!orderChanged && !ranksChanged) return;
      if (orderChanged) {
        for (const entry of renderEntries) list.append(entry.element);
      }
      visibleEntries.forEach((entry, index) => {
        rankBadgeFor(entry).textContent = `#${index + 1}`;
      });
    }

    // 可见性观察（ADR 0002）：任何组件切换好友项的 style/class 都视为
    // 可能的筛选变化，回调重放最近一次渲染；可见集合未变时渲染幂等
    // 退出，零 DOM 写入。首渲染前无状态可重放，静默忽略。无
    // MutationObserver（测试环境或极端浏览器）时不观察，名次仅在后续
    // 渲染时修正，属可接受的降级。
    if (typeof mutationObserver === "function") {
      new mutationObserver(() => {
        if (lastState) render(lastState);
      }).observe(list, {
        attributes: true,
        attributeFilter: ["style", "class"],
        subtree: true,
      });
    }

    // 祖先观察（ADR 0007）：祖先链上的属性变化（如 bangumi-user-topics
    // 在 #wrapperNeue 上翻转 data-user-topics-active）由样式表驱动整个
    // 好友视图显隐，列表子树内无任何属性变化，子树观察必然漏掉。观察
    // 列表之上的每个祖先直到文档根，不过滤属性名——任何组件换成其他
    // data-* 标记也不失效， observer 只负责触发重新检查，最终是否可见
    // 统一由 render 中的 isListPresentable 决定。回调先做廉价的列表级
    // 表现状态门控：状态未变即早退，变化才重放最近一次渲染（主题切换
    // 等高频无关属性变化不再触发整场重放）。首渲染前无状态可重放，
    // 静默忽略。无 MutationObserver 时不观察，与子树观察同一降级。
    if (typeof mutationObserver === "function") {
      const ancestorObserver = new mutationObserver(() =>
        run("可见性更新", () => {
          const presentable = isListPresentable(list);
          if (presentable === lastPresentable) return;
          if (lastState) render(lastState);
        }),
      );
      for (
        let ancestor = list.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        ancestorObserver.observe(ancestor, { attributes: true });
      }
    }

    return { bind, mount, render };
  }

  // src/bangumi/profile-parser.mjs — profile field parsing.

  function parseCompletionCount(block) {
    const descriptions = [...(block?.querySelectorAll?.(".desc") || [])];
    const completionDescriptions = descriptions.filter(
      (node) => node.textContent.trim() === "完成",
    );
    if (completionDescriptions.length !== 1) return null;
    const description = completionDescriptions[0];

    let card = description;
    while (card && card !== block) {
      const numberNodes = [...(card.querySelectorAll?.(".num") || [])];
      if (numberNodes.length > 1) return null;
      const numberNode = numberNodes[0];
      if (numberNode) {
        const text = numberNode.textContent.trim().replace(/,/g, "");
        if (!/^\d+$/.test(text)) return null;
        const value = Number(text);
        return Number.isSafeInteger(value) ? value : null;
      }
      card = card.parentElement;
    }
    return null;
  }

  // Reading a 完成统计范围 block is a three-way outcome: exactly one block,
  // no block at all, or an ambiguous duplicate set.
  function statsBlockFor(container, scope) {
    const blocks = [
      ...(container?.querySelectorAll?.(`#userStats_${scope}`) || []),
    ];
    if (blocks.length > 1) return { kind: "ambiguous" };
    return blocks[0]
      ? { block: blocks[0], kind: "found" }
      : { kind: "missing" };
  }

  function parseSyncRate(value) {
    const text = value?.textContent?.trim() || "";
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*%?$/.test(text)) {
      return null;
    }
    const parsed = Number(text.replace(/%\s*$/, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  // 主页字段的三向结果：成功携带可靠值；缺失表示字段节点未披露（不是
  // 零）；无效表示节点存在但自相矛盾或无法解析。每个字段独立产出结果，
  // 一个字段的失败不抹去同一响应中其他字段的有效结果。
  function successOutcome(value) {
    return { kind: "success", value };
  }

  function syncRateOutcome(synchronize) {
    const node = synchronize?.querySelector?.(".percent_text");
    if (!node) return { kind: "missing" };
    const parsed = parseSyncRate(node);
    return parsed === null ? { kind: "invalid" } : successOutcome(parsed);
  }

  function commonLikesOutcome(synchronize) {
    const match = /(^|[^\d])([+-]?\d[\d,]*(?:\.\d+)?)\s*个共同喜好/.exec(
      synchronize?.textContent || "",
    );
    if (!match) return { kind: "missing" };
    const parsed = Number(match[2].replace(/,/g, ""));
    return Number.isInteger(parsed) && parsed >= 0
      ? successOutcome(parsed)
      : { kind: "invalid" };
  }

  function relationFieldOutcomes(document) {
    const synchronize = document?.querySelector?.(".userSynchronize");
    if (!synchronize) return null;
    return {
      commonLikes: commonLikesOutcome(synchronize),
      syncRate: syncRateOutcome(synchronize),
    };
  }

  function completionFieldOutcomes(document) {
    const container = document?.querySelector?.("#userStatsContainers");
    if (!container) return null;

    const outcomes = {};
    const childCount = container.children?.length ?? 0;
    if (childCount === 0 && container.textContent.trim() === "") {
      for (const { value: scope } of COMPLETION_CHOICES) {
        outcomes[scope] = successOutcome(0);
      }
      return outcomes;
    }

    const aggregate = statsBlockFor(container, COMPLETION_SCOPE.ALL);
    const aggregateValue =
      aggregate.kind === "found" ? parseCompletionCount(aggregate.block) : null;
    // 聚合块是全部范围的结构前提：它缺失或矛盾时六个范围都无效。
    if (aggregateValue === null) return null;
    outcomes[COMPLETION_SCOPE.ALL] = successOutcome(aggregateValue);

    for (const { value: scope } of COMPLETION_CHOICES.slice(1)) {
      const stats = statsBlockFor(container, scope);
      if (stats.kind === "missing") {
        // 缺失的分类块可靠地为零（见 docs/spec/data.md）。
        outcomes[scope] = successOutcome(0);
      } else if (stats.kind === "found") {
        const value = parseCompletionCount(stats.block);
        outcomes[scope] =
          value === null ? { kind: "invalid" } : successOutcome(value);
      } else {
        // 重复的分类块属于结构矛盾：与既有行为一致，整个完成统计
        // 解析失败；契合指标不受影响。
        return null;
      }
    }
    return outcomes;
  }

  // 对解析后的主页文档只做这一遍提取：八个字段各自产出三向结果。
  function parseProfileFieldOutcomes(document) {
    return {
      completion: completionFieldOutcomes(document),
      relation: relationFieldOutcomes(document),
    };
  }

  function successfulOutcomeValues(outcomes) {
    const values = {};
    for (const [selection, outcome] of Object.entries(outcomes || {})) {
      if (outcome.kind === "success") values[selection] = outcome.value;
    }
    return values;
  }

  // 文档级视图，与逐字段结果共享同一遍提取：只有成功的字段值保留，
  // 没有任何有效字段的文档视为无效。
  function parseProfileDocument(document) {
    const outcomes = parseProfileFieldOutcomes(document);
    const completionValues =
      outcomes.completion === null
        ? null
        : successfulOutcomeValues(outcomes.completion);
    const relation =
      outcomes.relation === null
        ? null
        : successfulOutcomeValues(outcomes.relation);
    if (!completionValues && relation === null) return { kind: "invalid" };

    const parsed = { kind: "success" };
    if (completionValues) parsed.completion = completionValues;
    if (relation !== null) parsed.relation = relation;
    return parsed;
  }

  // src/bangumi/timeline-parser.mjs — activity timeline parsing.

  const SITE_OFFSET_SECONDS = 8 * 60 * 60;

  function siteDateFromEpochSeconds(epochSeconds) {
    return new Date((epochSeconds + SITE_OFFSET_SECONDS) * 1_000);
  }

  function parseSiteTimestampParts(value) {
    const match =
      /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
        value || "",
      );
    if (!match) return null;

    const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
      match;
    const [year, month, day, hour, minute] = [
      yearText,
      monthText,
      dayText,
      hourText,
      minuteText,
    ].map(Number);
    const second = secondText === undefined ? 0 : Number(secondText);
    const parsedSeconds =
      Date.UTC(year, month - 1, day, hour, minute, second) / 1_000 -
      SITE_OFFSET_SECONDS;
    const parsed = siteDateFromEpochSeconds(parsedSeconds);
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day ||
      parsed.getUTCHours() !== hour ||
      parsed.getUTCMinutes() !== minute ||
      parsed.getUTCSeconds() !== second
    ) {
      return null;
    }
    return {
      day,
      epochSeconds: parsedSeconds,
      hasExplicitSeconds: secondText !== undefined,
      hour,
      minute,
      month,
      second,
      year,
    };
  }

  function parseRelativeTime(value) {
    const text = (value || "").trim();
    if (text === "刚刚") return { totalSeconds: 0 };
    if (!text.endsWith("前")) return null;

    const body = text.slice(0, -1);
    const unitRanks = { 年: 5, 月: 4, 天: 3, 小时: 2, 分: 1, 分钟: 1, 秒: 0 };
    const tokens = [];
    const tokenPattern = /(\d+)(年|月|天|小时|分(?:钟)?|秒)/g;
    let cursor = 0;
    let match;
    while ((match = tokenPattern.exec(body))) {
      if (match.index !== cursor) return null;
      tokens.push({
        amount: Number(match[1]),
        rank: unitRanks[match[2]],
        // 分钟 and 分 are the same relative unit; normalize so the
        // second-recovery checks below only need the canonical names.
        unit: match[2] === "分钟" ? "分" : match[2],
      });
      cursor = tokenPattern.lastIndex;
    }
    if (cursor !== body.length || tokens.length < 1 || tokens.length > 2)
      return null;
    if (tokens.length === 2 && tokens[1].rank !== tokens[0].rank - 1)
      return null;

    const hasExplicitSeconds = tokens.some(({ unit }) => unit === "秒");
    const totalSeconds =
      hasExplicitSeconds &&
      tokens.every(({ unit }) => unit === "分" || unit === "秒")
        ? tokens.reduce(
            (total, token) =>
              total + token.amount * (token.unit === "分" ? 60 : 1),
            0,
          )
        : null;
    return { totalSeconds };
  }

  function matchesSiteMinute(epochSeconds, timestampParts) {
    const siteDate = siteDateFromEpochSeconds(epochSeconds);
    return (
      siteDate.getUTCFullYear() === timestampParts.year &&
      siteDate.getUTCMonth() === timestampParts.month - 1 &&
      siteDate.getUTCDate() === timestampParts.day &&
      siteDate.getUTCHours() === timestampParts.hour &&
      siteDate.getUTCMinutes() === timestampParts.minute
    );
  }

  function parseTimelineDocument(document, referenceAtSeconds) {
    const tabs = document.querySelector("#timelineTabs");
    const timeline = document.querySelector("#tmlContent > #timeline");
    if (!tabs || !timeline) return { kind: "invalid" };

    const firstItem = timeline?.querySelector(".tml_item");
    if (!firstItem) {
      return timeline.textContent.trim() === ""
        ? { kind: "empty" }
        : { kind: "invalid" };
    }

    const timestampNode = firstItem?.querySelector(
      ".post_actions .titleTip[title]",
    );
    const timestamp = timestampNode?.getAttribute("title");
    const timestampParts = parseSiteTimestampParts(timestamp);
    let activityAtSeconds = timestampParts?.epochSeconds ?? null;

    if (
      activityAtSeconds !== null &&
      !timestampParts.hasExplicitSeconds &&
      Number.isFinite(referenceAtSeconds)
    ) {
      const relative = parseRelativeTime(timestampNode.textContent);
      if (
        relative?.totalSeconds !== null &&
        relative?.totalSeconds !== undefined
      ) {
        const inferred = Math.trunc(referenceAtSeconds) - relative.totalSeconds;
        if (matchesSiteMinute(inferred, timestampParts))
          activityAtSeconds = inferred;
      }
    }

    return activityAtSeconds === null
      ? { kind: "invalid" }
      : { kind: "active", activityAtSeconds };
  }

  // src/bangumi/tietie-parser.mjs — categorized reaction timeline parsing.

  const TIETIE_REACTION_TEMPLATE_IDS = new Set([
    "likes_reaction_menu",
    "likes_reaction_menu_40",
    "likes_reaction_grid_item",
  ]);
  const TIETIE_CATEGORIES = Object.freeze(["say", "subject"]);

  function plainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function jsonValueEnd(source, start) {
    const opening = source[start];
    if (opening !== "{" && opening !== "[") return null;

    const closing = opening === "{" ? "}" : "]";
    let depth = 0;
    let escaped = false;
    let inString = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === opening) depth += 1;
      if (character === closing) {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return null;
  }

  function parseTietieDataScript(source) {
    const assignment = /\b(?:var|let|const)\s+data_likes_list\s*=\s*/.exec(
      source || "",
    );
    if (!assignment) return null;

    const valueStart = assignment.index + assignment[0].length;
    const valueEnd = jsonValueEnd(source, valueStart);
    if (valueEnd === null) return { invalid: true };
    try {
      const value = JSON.parse(source.slice(valueStart, valueEnd));
      return plainObject(value) ? value : { invalid: true };
    } catch {
      return { invalid: true };
    }
  }

  function tietieDataFor(document) {
    for (const script of document?.querySelectorAll?.("script") || []) {
      const parsed = parseTietieDataScript(script.textContent);
      if (parsed) return parsed.invalid ? null : parsed;
    }
    return null;
  }

  function stableReactionUserIdentifier(value) {
    if (typeof value === "string") {
      const identifier = value.trim();
      return identifier || null;
    }
    return Number.isSafeInteger(value) ? String(value) : null;
  }

  function reactionUsersFor(value) {
    // An empty likes_grid is omitted from data_likes_list and reliably means
    // that the dynamic has no reactions; malformed present data is rejected
    // below instead of being treated as an empty list.
    if (value === undefined) return [];
    const groups = Array.isArray(value)
      ? value
      : plainObject(value)
        ? Object.values(value)
        : null;
    if (!groups) return null;

    // Bangumi permits at most one reaction per user on one dynamic, so a
    // user contributes once even when the response groups several reactions.
    const identifiers = new Set();
    for (const group of groups) {
      if (!plainObject(group) || !Array.isArray(group.users)) return null;
      for (const user of group.users) {
        const identifier = stableReactionUserIdentifier(user?.username);
        if (!identifier) return null;
        identifiers.add(identifier);
      }
    }
    return [...identifiers];
  }

  function contentKeyForHref(href, baseUrl) {
    if (typeof href !== "string" || !href.trim()) return null;
    try {
      const url = new URL(href, baseUrl || "https://bgm.tv/");
      const pathname = url.pathname.replace(/\/$/, "") || "/";
      return `${pathname}${url.search}`;
    } catch {
      return null;
    }
  }

  function subjectAnchorFor(item, baseUrl) {
    const anchors = [
      ...(item?.querySelectorAll?.('a[href*="/subject/"]') || []),
    ];
    const normalSubject = (anchor) => {
      const href = anchor?.getAttribute?.("href") || "";
      try {
        const pathname = new URL(href, baseUrl || "https://bgm.tv/").pathname;
        return !/^\/subject\/ep(?:\/|$)/.test(pathname);
      } catch {
        return false;
      }
    };
    return (
      anchors.find(
        (anchor) =>
          anchor.getAttribute?.("data-subject-id") && normalSubject(anchor),
      ) ||
      anchors.find(normalSubject) ||
      anchors[0] ||
      null
    );
  }

  function contentKeyForTietieItem(item, baseUrl, category) {
    const subjectAnchor = subjectAnchorFor(item, baseUrl);
    const statusAnchor =
      item?.querySelector?.('a.tml_comment[href*="/timeline/status/"]') ||
      item?.querySelector?.('a[href*="/timeline/status/"]');
    const contentAnchor =
      category === "say"
        ? statusAnchor || subjectAnchor
        : subjectAnchor || statusAnchor;
    const href = contentAnchor?.getAttribute?.("href");
    return contentKeyForHref(href, baseUrl);
  }

  function dynamicIdentifierFor(item) {
    const identifier = item?.getAttribute?.("id")?.trim() || "";
    return /^tml_.+$/.test(identifier) ? identifier : null;
  }

  function reactionContainerIdentifierFor(item) {
    const identifier =
      item?.querySelector?.(".likes_grid[id]")?.getAttribute?.("id")?.trim() ||
      "";
    return /^likes_grid_.+$/.test(identifier) ? identifier : null;
  }

  function reactionDataKeyFor(item) {
    const identifier = reactionContainerIdentifierFor(item);
    return identifier?.slice("likes_grid_".length) || null;
  }

  // A normal collection status can intentionally omit the reaction grid. Its
  // content shell and subject link still make it a reliable zero; other
  // missing-grid rows remain malformed pages.
  function isReactionlessCollectionItem(item, category, contentKey, baseUrl) {
    const collectionSubject = subjectAnchorFor(item, baseUrl);
    const hasCollectionShell =
      item?.querySelector?.(".info_full") ||
      item?.querySelector?.(".collectInfo");
    return Boolean(
      category === "subject" &&
        contentKey &&
        !item?.querySelector?.(".likes_grid") &&
        collectionSubject &&
        hasCollectionShell,
    );
  }

  function nextTietiePage(document, page, baseUrl) {
    const pager = document?.querySelector?.("#tmlPager");
    const pages = [...(pager?.querySelectorAll?.("a[href]") || [])]
      .map((anchor) => {
        try {
          return Number(
            new URL(anchor.getAttribute("href"), baseUrl).searchParams.get(
              "page",
            ),
          );
        } catch {
          return null;
        }
      })
      .filter((candidate) => Number.isInteger(candidate) && candidate > page);
    return pages.length > 0;
  }

  function hasActiveTietieCategory(tabs, category, baseUrl) {
    if (!TIETIE_CATEGORIES.includes(category)) return false;
    return [...(tabs?.querySelectorAll?.("a.focus[href]") || [])].some(
      (anchor) => {
        try {
          return (
            new URL(anchor.getAttribute("href"), baseUrl).searchParams.get(
              "type",
            ) === category
          );
        } catch {
          return false;
        }
      },
    );
  }

  function isTietieReactionTemplate(node) {
    return Boolean(
      node?.nodeType === 1 &&
        node.tagName?.toLowerCase() === "template" &&
        node.getAttribute("type") === "text/template" &&
        TIETIE_REACTION_TEMPLATE_IDS.has(node.id),
    );
  }

  function isTietieInitializationScript(node) {
    return Boolean(
      node?.nodeType === 1 &&
        node.tagName?.toLowerCase() === "script" &&
        /\b(?:data_like_reaction_motion_map|data_likes_list)\b/.test(
          node.textContent || "",
        ),
    );
  }

  // When Bangumi reaches the end of a categorized timeline it may omit the
  // #timeline element entirely. Accept that shape only when the surrounding
  // category shell and reaction assets prove this is a real empty page.
  function isTietieEmptyPage(document, tabs, category, baseUrl) {
    const content = document?.querySelector?.("#tmlContent");
    if (!content || !hasActiveTietieCategory(tabs, category, baseUrl)) {
      return false;
    }
    if (
      content.querySelector?.("#timeline, .tml_item, #tmlPager") ||
      document.querySelector?.("#tmlPager")
    ) {
      return false;
    }

    let templateCount = 0;
    let scriptCount = 0;
    for (const node of content.childNodes || []) {
      if (node.nodeType === 3) {
        if (node.textContent.trim() !== "") return false;
        continue;
      }
      if (isTietieReactionTemplate(node)) {
        templateCount += 1;
        continue;
      }
      if (isTietieInitializationScript(node)) {
        scriptCount += 1;
        continue;
      }
      return false;
    }
    return templateCount > 0 && scriptCount > 0;
  }

  function parseTietieTimelineDocument(
    document,
    { baseUrl = "https://bgm.tv/", category, page = 1 } = {},
  ) {
    const tabs = document?.querySelector?.("#timelineTabs");
    const timeline = document?.querySelector?.("#tmlContent > #timeline");
    if (!tabs) return { kind: "invalid" };
    if (!timeline) {
      return isTietieEmptyPage(document, tabs, category, baseUrl)
        ? { kind: "empty", contents: [], hasNextPage: false }
        : { kind: "invalid" };
    }

    const items = [...(timeline.querySelectorAll?.(".tml_item") || [])];
    if (items.length === 0) {
      return timeline.textContent.trim() === ""
        ? { kind: "empty", contents: [], hasNextPage: false }
        : { kind: "invalid" };
    }

    const data = tietieDataFor(document);
    if (!data) return { kind: "invalid" };

    const contents = [];
    for (const item of items) {
      const reactionDataKey = reactionDataKeyFor(item);
      const contentKey = contentKeyForTietieItem(item, baseUrl, category);
      const dynamicIdentifier = dynamicIdentifierFor(item);
      const reactionContainerIdentifier = reactionContainerIdentifierFor(item);

      if (!reactionDataKey) {
        if (
          !isReactionlessCollectionItem(item, category, contentKey, baseUrl)
        ) {
          return { kind: "invalid" };
        }
        contents.push({
          contentKey,
          dynamicIdentifier,
          reactionContainerIdentifier,
          reactorIdentifiers: [],
        });
        continue;
      }
      if (!data) return { kind: "invalid" };

      const reactorIdentifiers = reactionUsersFor(data[reactionDataKey]);
      if (reactorIdentifiers === null) return { kind: "invalid" };
      contents.push({
        contentKey,
        dynamicIdentifier,
        reactionContainerIdentifier,
        reactorIdentifiers,
      });
    }

    return {
      kind: "success",
      contents,
      hasNextPage: nextTietiePage(document, page, baseUrl),
    };
  }

  // src/bangumi/http.mjs — Bangumi page request adapter.

  const PAGE_REQUEST_TIMEOUT_MS = 15_000;

  async function fetchPageWithTimeout(
    url,
    fetchImpl,
    {
      clearTimeoutImpl = globalThis.clearTimeout,
      setTimeoutImpl = globalThis.setTimeout,
    } = {},
  ) {
    if (typeof fetchImpl !== "function") {
      throw new Error("远程获取缺少 fetch 支持");
    }
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

      return { kind: "success", response, html: await response.text() };
    } catch {
      return { kind: "network-error" };
    } finally {
      clearTimeoutImpl(timeout);
    }
  }

  async function fetchDocumentPage(
    url,
    fetchImpl,
    domParser,
    parseDocument,
    { now, timers } = {},
  ) {
    const outcome = await fetchPageWithTimeout(url, fetchImpl, timers);
    if (outcome.kind !== "success") return outcome;
    const fetchedAt = now?.();
    if (typeof domParser?.parseFromString !== "function") {
      throw new Error("远程页面解析缺少 DOMParser 支持");
    }
    const document = domParser.parseFromString(outcome.html, "text/html");
    const record = parseDocument(document, outcome.response, fetchedAt);
    if (record?.kind === "invalid") return { kind: "parse-error" };
    return { kind: "success", record };
  }

  // 一次主页请求、一次文档提取：记录按字段携带三向结果，交给主页字段
  // 任务分别判定成功与失败。字段取值由任务按 REMOTE_TARGET_SELECTION_KEYS
  // 查询 fields，记录保持纯数据形状，方便测试适配器直接构造。
  async function fetchProfile(friend, fetchImpl, domParser, now) {
    return fetchDocumentPage(
      `/user/${encodeURIComponent(userIdentifierFor(friend))}`,
      fetchImpl,
      domParser,
      (document, _response, fetchedAt) => {
        const fields = parseProfileFieldOutcomes(document);
        if (fields.completion === null && fields.relation === null) {
          return { kind: "invalid" };
        }
        return { fetchedAt, fields };
      },
      { now },
    );
  }

  async function fetchActivity(friend, fetchImpl, domParser, now) {
    return fetchDocumentPage(
      `/user/${encodeURIComponent(userIdentifierFor(friend))}/timeline`,
      fetchImpl,
      domParser,
      (document, response, fetchedAt) => {
        const responseAt = Date.parse(response.headers?.get("date") || "");
        const parsed = parseTimelineDocument(
          document,
          Math.trunc(
            (Number.isFinite(responseAt) ? responseAt : fetchedAt) / 1_000,
          ),
        );
        if (parsed.kind === "invalid") return parsed;
        return { ...parsed, fetchedAt };
      },
      { now },
    );
  }

  async function fetchTietiePage(
    recipientIdentifier,
    category,
    page,
    fetchImpl,
    domParser,
    baseUrl,
    timers,
  ) {
    const pageQuery = page === 1 ? "" : `&page=${page}`;
    const path = `/user/${encodeURIComponent(recipientIdentifier)}/timeline`;
    return fetchDocumentPage(
      `${path}?type=${category}${pageQuery}`,
      fetchImpl,
      domParser,
      (document, response) => {
        const expected = new URL(path, baseUrl);
        let actual;
        try {
          actual = new URL(response.url);
        } catch {
          return { kind: "invalid" };
        }
        // 最终 URL 与正文分类导航都必须确认目标，不能接受丢失分类的重定向。
        if (
          actual.origin !== expected.origin ||
          actual.pathname !== expected.pathname ||
          actual.searchParams.get("type") !== category ||
          Number(actual.searchParams.get("page") || 1) !== page
        ) {
          return { kind: "invalid" };
        }
        const activeCategory = [
          ...document.querySelectorAll("#timelineTabs a.focus[href]"),
        ].some((anchor) => {
          const href = anchor.getAttribute("href");
          let url;
          try {
            url = new URL(href, actual);
          } catch {
            return false;
          }
          return (
            url.origin === expected.origin &&
            url.pathname === path &&
            url.searchParams.get("type") === category
          );
        });
        const owner = document.querySelector(
          "#headerProfile .headerAvatar a[href]",
        );
        if (
          !activeCategory ||
          (owner &&
            userIdentifierFromHref(owner.getAttribute("href"), actual) !==
              recipientIdentifier)
        ) {
          return { kind: "invalid" };
        }
        return parseTietieTimelineDocument(document, {
          baseUrl,
          category,
          page,
        });
      },
      { timers },
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
    return {
      fetchActivity: (friend) =>
        fetchActivity(friend, fetchImpl, domParser, now),
      fetchProfile: (friend) => fetchProfile(friend, fetchImpl, domParser, now),
      fetchTietiePage: (recipientIdentifier, category, page) =>
        fetchTietiePage(
          recipientIdentifier,
          category,
          page,
          fetchImpl,
          domParser,
          baseUrl,
          { clearTimeoutImpl, setTimeoutImpl },
        ),
    };
  }

  // src/sorting/remote-selection.mjs — remote target transition decisions.

  function remoteTargetFor(criterion, selection) {
    const selectionKey = REMOTE_TARGET_SELECTION_KEYS[criterion];
    if (selectionKey === undefined) return null;
    return {
      kind: criterion,
      ...(selectionKey ? { [selectionKey]: selection } : {}),
    };
  }

  function sameRemoteTarget(left, right) {
    if (left === right) return true;
    if (!left || !right || left.kind !== right.kind) return false;
    const selectionKey = REMOTE_TARGET_SELECTION_KEYS[left.kind];
    return !selectionKey || left[selectionKey] === right[selectionKey];
  }

  function nextRemoteSelectionAction(
    currentTarget,
    requestedTarget,
    statusKind,
  ) {
    const clearPrompt = statusKind === REFRESH_STATUS.AWAITING_FULL_REFRESH;
    const selectAction = (refreshMode = null) => ({
      kind: "select",
      clearPrompt,
      refreshMode,
    });

    // 唯一调用方 selectRemoteCriterion 只对 activity/relation/completion
    // 传入非空目标；requestedTarget === null 的分支已随其直测一并移除。
    if (!sameRemoteTarget(currentTarget, requestedTarget)) {
      return selectAction("incremental");
    }
    if (statusKind === REFRESH_STATUS.IDLE) {
      return { kind: "arm", clearPrompt: false, refreshMode: null };
    }
    if (statusKind === REFRESH_STATUS.AWAITING_FULL_REFRESH) {
      return {
        kind: "refresh",
        clearPrompt: true,
        refreshMode: "full",
      };
    }
    // The caller bails out on "ignore" without reading any other field.
    return { kind: "ignore" };
  }

  // src/workflow/scheduler.mjs — bounded concurrent page-task scheduling.

  function needsLargeRequestConfirmation(count) {
    return count > 400;
  }

  function isRateLimitedOutcome(outcome) {
    return outcome?.kind === "http-error" && outcome.status === 429;
  }

  function nextBatchState(state, outcome) {
    if (state.stopped) return state;
    if (isRateLimitedOutcome(outcome)) {
      return { ...state, stopped: true };
    }
    if (
      outcome.kind === "http-error" &&
      (outcome.status === 403 || outcome.status >= 500)
    ) {
      const consecutiveServerFailures = state.consecutiveServerFailures + 1;
      return {
        consecutiveServerFailures,
        stopped: consecutiveServerFailures >= 5,
      };
    }
    return { consecutiveServerFailures: 0, stopped: false };
  }

  function createTaskScheduler({
    concurrency = 4,
    onError = (error) => {
      throw error;
    },
  } = {}) {
    const maxConcurrency = Math.max(1, Math.floor(concurrency));
    const tasks = new Map();
    let foregroundType = null;
    let inFlight = 0;
    let globallyStopped = false;

    function normalizedOutcome(outcome) {
      if (!outcome || typeof outcome !== "object") {
        throw new Error("远程任务未返回有效获取结果");
      }
      return outcome;
    }

    function runnableTask() {
      const foreground = foregroundType && tasks.get(foregroundType);
      if (foreground?.canSchedule()) return foreground;
      if (foreground?.hasInFlight()) return null;
      return [...tasks.values()].find((task) => task.canSchedule()) || null;
    }

    function abortAndReport(task, error) {
      try {
        task.abort();
      } finally {
        onError(error);
      }
    }

    function pump() {
      while (!globallyStopped && inFlight < maxConcurrency) {
        const task = runnableTask();
        if (!task) return;

        const item = task.take();
        if (!item) continue;
        inFlight += 1;
        let request;
        try {
          task.begin();
          request = task.fetch(item);
        } catch (error) {
          inFlight -= 1;
          try {
            abortAndReport(task, error);
          } finally {
            queueMicrotask(pump);
          }
          throw error;
        }
        const settle = (outcome) => {
          inFlight -= 1;
          try {
            if (outcome?.kind === "unexpected-error") throw outcome.error;
            task.complete(item, normalizedOutcome(outcome));
          } catch (error) {
            abortAndReport(task, error);
          } finally {
            pump();
          }
        };
        Promise.resolve(request).then(settle, (error) =>
          settle({ kind: "unexpected-error", error }),
        );
      }
    }

    function stopAll() {
      if (globallyStopped) return;
      globallyStopped = true;
      for (const task of [...tasks.values()]) task.stop();
    }

    function createTask(type, options) {
      // startForegroundTask is the only production caller and always
      // supplies keyFor, confirmMessage, target and isSuccess; no
      // defaults here.
      const keyFor = options.keyFor;
      const confirmMessage = options.confirmMessage;
      const isSuccess = options.isSuccess;
      const lifecycle = options.lifecycle;
      const queue = [];
      const queuedKeys = new Set();
      const results = new Map();
      let completed = 0;
      let total = 0;
      let inFlightForTask = 0;
      let target = options.target;
      let batchState = { consecutiveServerFailures: 0, stopped: false };
      let started = false;
      let finished = false;

      // One progress snapshot shape shared by onFetching/onProgress/onQueue:
      // the task's counters and its reported target travel together.
      function progress() {
        return { completed, target, total };
      }

      function finishIfIdle() {
        if (finished || inFlightForTask > 0 || queue.length > 0) return;
        finished = true;
        let failures = 0;
        for (const result of results.values()) {
          if (!isSuccess(result.record, result.outcome, target)) {
            failures += 1;
          }
        }
        if (tasks.get(type) === task) tasks.delete(type);
        lifecycle.onFinished?.({
          completed,
          failures,
          globallyStopped,
          stopped: batchState.stopped || globallyStopped,
          target,
          total,
        });
      }

      const task = {
        begin() {
          inFlightForTask += 1;
          if (!started) {
            started = true;
            lifecycle.onFetching?.(progress());
          }
        },
        canSchedule() {
          return !finished && !batchState.stopped && queue.length > 0;
        },
        hasInFlight() {
          return !batchState.stopped && inFlightForTask > 0;
        },
        complete(item, outcome) {
          inFlightForTask -= 1;
          if (finished) return;
          completed += 1;
          const record = outcome.kind === "success" ? outcome.record : null;
          if (outcome.kind === "success") {
            lifecycle.onSuccess?.(item, outcome.record);
          }
          results.set(keyFor(item), { item, outcome, record });
          batchState = nextBatchState(batchState, outcome);
          lifecycle.onProgress?.(progress());
          if (isRateLimitedOutcome(outcome)) {
            const shouldNotify = !globallyStopped;
            stopAll();
            if (shouldNotify) lifecycle.onRateLimited?.();
          }
          if (batchState.stopped) task.stop();
          finishIfIdle();
        },
        enqueue(items, nextTarget) {
          const candidateKeys = new Set(queuedKeys);
          const newItems = [];
          for (const item of items) {
            const key = keyFor(item);
            if (candidateKeys.has(key)) continue;
            candidateKeys.add(key);
            newItems.push(item);
          }
          // Switching the reported target is not a hidden side effect of a
          // rejected expansion: keep serving the previous target (story 50).
          if (
            needsLargeRequestConfirmation(newItems.length) &&
            options.confirmRequest &&
            !options.confirmRequest(confirmMessage(newItems.length))
          ) {
            return { added: 0, accepted: false };
          }
          target = nextTarget;
          for (const item of newItems) {
            queuedKeys.add(keyFor(item));
            queue.push(item);
          }
          total += newItems.length;
          if (started) {
            lifecycle.onQueue?.(progress());
          }
          return { added: newItems.length, accepted: true };
        },
        abort() {
          if (finished) return;
          finished = true;
          queue.length = 0;
          if (tasks.get(type) === task) tasks.delete(type);
          lifecycle.onAborted?.();
        },
        fetch: options.fetch,
        getState() {
          return progress();
        },
        isStopped() {
          return batchState.stopped;
        },
        stop() {
          if (finished) return;
          batchState = { ...batchState, stopped: true };
          const unattempted = queue.splice(0);
          if (unattempted.length > 0) {
            for (const item of unattempted) {
              results.set(keyFor(item), {
                item,
                outcome: { kind: "unattempted" },
                record: null,
              });
            }
            completed += unattempted.length;
            lifecycle.onProgress?.(progress());
          }
          finishIfIdle();
        },
        take() {
          return queue.shift() || null;
        },
      };
      return task;
    }

    function enqueue(type, items, options, { foreground = false } = {}) {
      if (globallyStopped) return { added: 0, task: null };
      let task = tasks.get(type);
      if (task?.isStopped()) return { added: 0, task: null };
      if (!task) {
        task = createTask(type, options);
        tasks.set(type, task);
      }
      const { added, accepted } = task.enqueue(items, options.target);
      if (added === 0 && task.getState().total === 0) {
        if (tasks.get(type) === task) tasks.delete(type);
        pump();
        return { added: 0, task: null };
      }
      if (foreground && accepted) {
        foregroundType = type;
      }
      pump();
      return { added, task };
    }

    return {
      enqueue,
      getInFlightCount: () => inFlight,
      getForegroundType: () =>
        foregroundType && tasks.has(foregroundType) ? foregroundType : null,
      getTask: (type) => tasks.get(type) || null,
      isGloballyStopped: () => globallyStopped,
      stopAll,
    };
  }

  // src/workflow/status.mjs — status priority and lifetime.

  function createStatusController({
    clearTimeout: clearStatusTimeout = globalThis.clearTimeout,
    now = Date.now,
    // 最终提示的呈现出口：状态控制器只计算既有优先级下的最终文本，
    // 由调用方把文本并入唯一的渲染过程。
    present,
    scheduler,
    setTimeout: setStatusTimeout = globalThis.setTimeout,
  }) {
    let statusTimer = null;
    let statusKind = REFRESH_STATUS.IDLE;
    let transientStatus = null;
    let identityStatus = null;
    let completionTimer = null;
    const completionStatuses = [];
    const progressStatuses = new Map();
    let progressSequence = 0;
    let rateLimitStatusShown = false;

    function pruneCompletionStatuses(currentTime = now()) {
      while (completionStatuses.length > 0) {
        const next = completionStatuses[0];
        if (next.expiresAt === null) {
          next.expiresAt = currentTime + next.durationMs;
        }
        if (next.expiresAt > currentTime) break;
        completionStatuses.shift();
      }
    }

    function scheduleCompletionExpiry(currentTime = now()) {
      clearStatusTimeout(completionTimer);
      completionTimer = null;
      const next = completionStatuses[0];
      if (!next) return;
      const scheduled = next;
      completionTimer = setStatusTimeout(
        () => {
          completionTimer = null;
          if (completionStatuses[0] === scheduled) completionStatuses.shift();
          render();
        },
        Math.max(0, next.expiresAt - currentTime),
      );
    }

    function currentProgressStatus() {
      const foregroundType = scheduler.getForegroundType();
      const foregroundProgress = foregroundType
        ? progressStatuses.get(foregroundType)
        : null;
      if (foregroundProgress) return foregroundProgress;
      return [...progressStatuses.values()].sort(
        (left, right) => right.sequence - left.sequence,
      )[0];
    }

    function render(currentTime) {
      if (completionStatuses.length > 0) {
        const statusTime = currentTime ?? now();
        pruneCompletionStatuses(statusTime);
        scheduleCompletionExpiry(statusTime);
      } else {
        clearStatusTimeout(completionTimer);
        completionTimer = null;
      }

      if (identityStatus) {
        statusKind = REFRESH_STATUS.IDENTITY_REQUIRED;
        present(identityStatus.message);
        return;
      }

      const completion = completionStatuses[0];
      if (completion) {
        statusKind = REFRESH_STATUS.COMPLETED;
        present(completion.message);
        return;
      }

      if (transientStatus) {
        statusKind = transientStatus.kind;
        present(transientStatus.message);
        return;
      }

      const progress = currentProgressStatus();
      if (progress) {
        statusKind = REFRESH_STATUS.FETCHING;
        present(progress.message);
        return;
      }

      statusKind = REFRESH_STATUS.IDLE;
      present("");
    }

    function clearArmedStatus() {
      if (transientStatus?.kind !== REFRESH_STATUS.AWAITING_FULL_REFRESH)
        return;
      clearStatusTimeout(statusTimer);
      statusTimer = null;
      transientStatus = null;
    }

    function clearCompletionStatuses() {
      completionStatuses.length = 0;
      clearStatusTimeout(completionTimer);
      completionTimer = null;
    }

    function clear() {
      clearStatusTimeout(statusTimer);
      statusTimer = null;
      transientStatus = null;
      identityStatus = null;
      render();
    }

    function set(kind, message, clearAfterMs = 0) {
      if (kind === REFRESH_STATUS.COMPLETED) {
        clearArmedStatus();
        const completedAt = now();
        completionStatuses.push({
          durationMs: Math.max(0, clearAfterMs),
          expiresAt: null,
          message,
        });
        render(completedAt);
        return;
      }

      if (kind !== REFRESH_STATUS.IDENTITY_REQUIRED && identityStatus) return;
      clearStatusTimeout(statusTimer);
      statusTimer = null;
      if (kind === REFRESH_STATUS.IDENTITY_REQUIRED) {
        transientStatus = null;
        identityStatus = { message };
      } else {
        identityStatus = null;
        transientStatus = { kind, message };
      }
      render();
      if (clearAfterMs > 0) {
        statusTimer = setStatusTimeout(() => {
          statusTimer = null;
          transientStatus = null;
          identityStatus = null;
          render();
        }, clearAfterMs);
      }
    }

    function setProgress(taskType, message) {
      clearArmedStatus();
      progressStatuses.set(taskType, {
        message,
        sequence: ++progressSequence,
      });
      render();
    }

    function clearProgress(taskType) {
      progressStatuses.delete(taskType);
      render();
    }

    function showRateLimit() {
      if (rateLimitStatusShown) return;
      rateLimitStatusShown = true;
      clearCompletionStatuses();
      clearStatusTimeout(statusTimer);
      statusTimer = null;
      transientStatus = null;
      identityStatus = null;
      set(REFRESH_STATUS.COMPLETED, "请求受限，已停止全部获取", 5_000);
    }

    return {
      clear,
      clearProgress,
      getKind: () => statusKind,
      set,
      setProgress,
      showRateLimit,
    };
  }

  // src/workflow/refresh-lifecycle.mjs — refresh task lifecycle bridges.

  function createRefreshLifecycle({
    applySort,
    labelFor,
    progressReporter,
    status,
    taskType,
  }) {
    return {
      onFetching: progressReporter,
      onProgress: progressReporter,
      onQueue: progressReporter,
      onRateLimited: status.showRateLimit,
      onAborted() {
        status.clearProgress(taskType);
      },
      onFinished({ failures, globallyStopped, target }) {
        status.clearProgress(taskType);
        applySort();
        if (globallyStopped) {
          status.showRateLimit();
          return;
        }
        const label = labelFor(target);
        status.set(
          REFRESH_STATUS.COMPLETED,
          failures
            ? `“${label}”获取完成，${failures} 人失败`
            : `“${label}”获取完成`,
          5_000,
        );
      },
    };
  }

  function createTaskProgressReporter({
    onProgress,
    status,
    taskType,
    messageFor,
  }) {
    return ({ completed, target, total }) => {
      status.setProgress(taskType, messageFor({ completed, target, total }));
      onProgress?.(completed, total);
    };
  }

  // Bridges one page task's lifecycle to a friend-cache refresh batch: the
  // batch opens when the task starts fetching, accepts each friend's result
  // and commits once when the task finishes. Callers never touch persistence.
  function createCacheBatchLifecycle({
    applySort,
    cache,
    labelFor,
    progressReporter,
    projectResult,
    status,
    taskType,
    visitorIdentifier,
  }) {
    const base = createRefreshLifecycle({
      applySort,
      labelFor,
      progressReporter,
      status,
      taskType,
    });
    let batch = null;
    return {
      ...base,
      onFetching(progress) {
        batch = cache.beginRefresh({ visitorIdentifier });
        base.onFetching?.(progress);
      },
      onFinished(result) {
        batch?.complete();
        batch = null;
        base.onFinished?.(result);
      },
      onSuccess(friend, record) {
        batch?.accept(userIdentifierFor(friend), projectResult(record));
      },
      onAborted() {
        batch?.complete();
        batch = null;
        base.onAborted();
      },
    };
  }

  // Starts a foreground scheduler task when there is work to fetch.
  // Missing request capabilities fail at use, not during local sorting.
  function startForegroundTask({
    confirmRequest,
    fetch,
    isSuccess = (_record, outcome) => outcome.kind === "success",
    keyFor,
    lifecycle = {},
    pending,
    scheduler,
    target,
    taskType,
  }) {
    if (scheduler.isGloballyStopped()) return null;
    if (pending.length === 0 && !scheduler.getTask(taskType)) return null;
    const { task } = scheduler.enqueue(
      taskType,
      pending,
      {
        confirmMessage: (count) =>
          `本次新增获取的好友数量过多（${count} 人），是否继续？`,
        confirmRequest,
        fetch,
        isSuccess,
        keyFor,
        lifecycle,
        target,
      },
      { foreground: true },
    );
    return task;
  }

  // src/workflow/profile-tasks.mjs — profile field refresh tasks.

  // 主页字段任务 deep module：拥有八个主页字段（六个完成统计范围与同步
  // 率、共同喜好数两个契合指标）的字段语义、同一批次内单次可复用的主页
  // 请求、任务合并扩充与字段级成功失败统计。调用方只声明当前排序需要的
  // 字段，不再拼装解析、调度或缓存写入细节。
  // 接口约定：唯一入口 refresh(field, mode)，声明一个当前排序需要的字段
  // 并返回前台调度任务（调度器已停止，或无在跑任务且待请求为空时返回 null）。调用顺序不限：新字段声明的待请求好友优先
  // 合并进运行中的主页任务，同一好友在整个任务内最多请求一次。不变量：
  // 一次响应服务全部字段，只有解析成功的字段写入缓存，缺失或无效字段
  // 不覆盖旧值。错误模式：单好友请求失败只计入该次任务的失败统计，
  // 不影响缓存既有记录；缓存批次生命周期由 createCacheBatchLifecycle
  // 桥接，本模块不接触持久化细节。
  const PROFILE_TASK_TYPE = "profile";
  const PROFILE_FIELD_GROUP_LABELS = Object.freeze({
    [SORT.COMPLETION]: "完成条目数",
    [SORT.RELATION]: "喜好契合",
  });

  function profileFieldLabelFor(field) {
    return PROFILE_FIELD_GROUP_LABELS[field?.kind] ?? "";
  }

  function createProfileFieldTasks({
    applySort,
    cache,
    confirmRequest,
    friends,
    http,
    onProgress,
    scheduler,
    status,
    visitorIdentifier,
  }) {
    const progressReporter = createTaskProgressReporter({
      onProgress,
      status,
      taskType: PROFILE_TASK_TYPE,
      messageFor: ({ completed, target, total }) =>
        `正在获取“${profileFieldLabelFor(target)}” ${completed}/${total}`,
    });

    // 字段形状沿用 REMOTE_TARGET_SELECTION_KEYS 的统一映射：完成统计
    // 范围按 scope 定位结果，契合指标按 metric 定位；只有契合指标按访
    // 问者隔离，缓存的新鲜度边界需要完整的访问者目标。
    function cacheTargetFor(field) {
      return REMOTE_TARGET_SELECTION_KEYS[field.kind] === "metric"
        ? { ...field, visitorIdentifier }
        : field;
    }

    // 按声明字段分别判定成功：请求失败、主页无效、该字段缺失或无效都算
    // 失败；字段解析成功则算成功，即使请求最初由另一个字段加入。
    function isFieldSuccess(record, outcome, field) {
      const selectionKey = REMOTE_TARGET_SELECTION_KEYS[field.kind];
      return (
        outcome.kind === "success" &&
        record?.fields?.[field.kind]?.[field[selectionKey]]?.kind === "success"
      );
    }

    // 一次响应服务全部字段：解析成功的字段结果交给好友缓存批次；缺失或
    // 无效的字段不写入缓存，因此不会覆盖仍有效的旧值。
    function cacheResultFor(record) {
      const result = { fetchedAt: record.fetchedAt };
      for (const [kind, outcomes] of Object.entries(record.fields)) {
        const values = successfulOutcomeValues(outcomes);
        if (Object.keys(values).length > 0) result[kind] = values;
      }
      return result;
    }

    const lifecycle = createCacheBatchLifecycle({
      applySort,
      cache,
      labelFor: profileFieldLabelFor,
      progressReporter,
      projectResult: cacheResultFor,
      status,
      taskType: PROFILE_TASK_TYPE,
      visitorIdentifier,
    });

    // 声明一个当前排序需要的主页字段：按字段判断待请求好友，合并进运行
    // 中的主页任务或创建新任务。同一好友在整个任务内最多请求一次，而一
    // 次响应解析全部八个字段，因此已排队和在途好友天然服务新增字段需求。
    function refresh(field, mode = "incremental") {
      return startForegroundTask({
        confirmRequest,
        fetch: (friend) => http.fetchProfile(friend),
        isSuccess: isFieldSuccess,
        keyFor: userIdentifierFor,
        lifecycle,
        pending: cache.friendsNeedingRefresh(friends, cacheTargetFor(field), {
          mode,
        }),
        scheduler,
        target: field,
        taskType: PROFILE_TASK_TYPE,
      });
    }

    return { refresh };
  }

  // src/workflow/tietie-tasks.mjs — categorized reaction refresh tasks.

  const TIETIE_MAX_PAGES = 5;
  const TIETIE_TASK_TYPE = "tietie";
  const TIETIE_IDENTITY_FIELDS = [
    { kind: "content", field: "contentKey" },
    { kind: "dynamic", field: "dynamicIdentifier" },
    { kind: "reaction", field: "reactionContainerIdentifier" },
  ];

  function tietieIdentityDescriptorsFor(content) {
    const descriptors = [];
    for (const { kind, field } of TIETIE_IDENTITY_FIELDS) {
      const value = content?.[field];
      if (typeof value === "string" && value.trim()) {
        descriptors.push({ kind, value: value.trim() });
      }
    }
    return descriptors;
  }

  function tietieIdentityToken({ kind, value }) {
    return JSON.stringify([kind, value]);
  }

  // The content link has priority over the dynamic and reaction-container
  // identifiers. Fallback identifiers are registered as aliases, so a later
  // item that lacks a higher-priority identifier can still join the same
  // record. A disclosed higher-priority identifier is never bypassed to use
  // a lower-priority alias.
  function createTietieContentAccumulator() {
    const records = [];
    const index = new Map();

    function recordsFor(descriptor) {
      return index.get(tietieIdentityToken(descriptor)) || [];
    }

    function register(record, descriptor) {
      const token = tietieIdentityToken(descriptor);
      const matches = index.get(token) || [];
      if (!matches.includes(record)) matches.push(record);
      index.set(token, matches);
    }

    function registerAll(record, content) {
      for (const descriptor of tietieIdentityDescriptorsFor(content)) {
        register(record, descriptor);
      }
    }

    function candidateFor(descriptors) {
      const [primary] = descriptors;
      if (!primary) return null;

      const exact = recordsFor(primary);
      if (exact.length === 1) return exact[0];
      return null;
    }

    function mergeMetadata(record, content) {
      for (const { field } of TIETIE_IDENTITY_FIELDS) {
        if (!record[field] && content?.[field]) record[field] = content[field];
      }
      registerAll(record, content);
    }

    function add(content) {
      const descriptors = tietieIdentityDescriptorsFor(content);
      let record = candidateFor(descriptors);
      if (!record) {
        record = {
          ...Object.fromEntries(
            TIETIE_IDENTITY_FIELDS.map(({ field }) => [
              field,
              content?.[field] || null,
            ]),
          ),
          reactorIdentifiers: new Set(),
        };
        records.push(record);
      }
      mergeMetadata(record, content);

      const addedReactors = [];
      for (const identifier of content?.reactorIdentifiers || []) {
        if (record.reactorIdentifiers.has(identifier)) continue;
        record.reactorIdentifiers.add(identifier);
        addedReactors.push(identifier);
      }
      return addedReactors;
    }

    return { add };
  }

  // 和 TA 贴贴任务按分类和页排队，而不是按好友排队。每个成功页面只在
  // 页面明确提供下一页时追加同一分类的下一页，最多读取前五页；两分类
  // 的页面结果先在批次内按内容链接、动态编号或表情容器标识逐级去重，
  // 无可用标识的动态直接累计。全部必要页面成功后才交给会话发布；
  // 失败批次不会触碰旧的完整结果。
  function createTietieTasks({
    applySort,
    cache,
    http,
    now,
    onProgress,
    publishResult,
    scheduler,
    status,
    recipientIdentifier,
  }) {
    const progressReporter = createTaskProgressReporter({
      onProgress,
      status,
      taskType: TIETIE_TASK_TYPE,
      messageFor: ({ completed, total }) =>
        `正在获取“和 TA 贴贴” ${completed}/${total}`,
    });
    let batch = null;
    let enqueueNextPage = null;

    function mergePage(record) {
      for (const content of record.contents || []) {
        for (const identifier of batch.contents.add(content)) {
          batch.counts.set(identifier, (batch.counts.get(identifier) || 0) + 1);
        }
      }
    }

    // 不复用 createRefreshLifecycle：贴贴只在整批成功后替换接收方结果，
    // 且排序和完成提示时机不同；共用其 onFinished 会改变批次语义。
    const lifecycle = {
      onFetching: progressReporter,
      onProgress: progressReporter,
      onQueue: progressReporter,
      onRateLimited: status.showRateLimit,
      onAborted() {
        batch = null;
        status.clearProgress(TIETIE_TASK_TYPE);
      },
      onSuccess(item, record) {
        mergePage(record);
        if (record.hasNextPage && item.page < TIETIE_MAX_PAGES) {
          enqueueNextPage?.({ category: item.category, page: item.page + 1 });
        }
      },
      onFinished({ failures, globallyStopped }) {
        status.clearProgress(TIETIE_TASK_TYPE);
        const completedBatch = batch;
        batch = null;
        if (globallyStopped) {
          status.showRateLimit();
          return;
        }
        if (failures === 0) {
          const result = {
            complete: true,
            counts: completedBatch.counts,
            fetchedAt: now(),
          };
          cache.replaceTietie(recipientIdentifier, result);
          publishResult(result);
          applySort();
          status.set(REFRESH_STATUS.COMPLETED, "“和 TA 贴贴”获取完成", 5_000);
          return;
        }
        status.set(
          REFRESH_STATUS.COMPLETED,
          "“和 TA 贴贴”获取失败，本次结果未更新",
          5_000,
        );
      },
    };

    const taskOptions = {
      fetch: (item) =>
        http.fetchTietiePage(recipientIdentifier, item.category, item.page),
      isSuccess: (record) =>
        record?.kind === "success" || record?.kind === "empty",
      keyFor: (item) => `${item.category}:${item.page}`,
      lifecycle,
      target: { kind: SORT.TIETIE },
    };

    enqueueNextPage = (item) => {
      scheduler.enqueue(TIETIE_TASK_TYPE, [item], taskOptions);
    };

    function refresh(mode = "incremental") {
      if (!recipientIdentifier) return null;
      const existingTask = scheduler.getTask(TIETIE_TASK_TYPE);
      if (existingTask) {
        // Re-selecting the target while its pages are already being fetched
        // only brings that task back to the foreground. It must not restart
        // the batch or add duplicate category/page requests.
        scheduler.enqueue(TIETIE_TASK_TYPE, [], taskOptions, {
          foreground: true,
        });
        return existingTask;
      }
      if (mode !== "full" && !cache.tietieNeedsRefresh(recipientIdentifier)) {
        return null;
      }

      batch = {
        contents: createTietieContentAccumulator(),
        counts: new Map(),
      };
      const { task } = scheduler.enqueue(
        TIETIE_TASK_TYPE,
        TIETIE_CATEGORIES.map((category) => ({ category, page: 1 })),
        taskOptions,
        { foreground: true },
      );
      return task;
    }

    return {
      refresh,
    };
  }

  // src/workflow/session.mjs — sort session orchestration.

  // 远程排序会话 deep module：页面初始化后的最高层业务边界。会话只通过
  // start、choose 与 changeDirection 接收外部命令；内部私有状态机与任务
  // 登记表共同拥有当前排序目标、子选项、方向记忆、增量刷新、连续两次选
  // 择触发的全量刷新、登录前置条件、请求先后关系与提示优先级，并编排好
  // 友缓存、活跃任务、主页字段任务、排序函数与排序栏。任务登记表、状态
  // 机与排序栏内部节点均不向外暴露。
  // 接口约定：start 必须最先调用且恰好一次（重复启动抛错），它按网页
  // 默认顺序完成首次呈现；此后 choose 与 changeDirection 是仅有的排序
  // 命令入口，未知目标、子选项或方向立即抛错（programmer error），不
  // 修改任何状态。不变量：展示顺序只在排序输入（目标、方向、子选项）
  // 或条件重排后变化，状态提示等纯呈现更新复用上一次排序结果；任务
  // 结束后只有目标仍是当前目标时才重排，迟到结果不覆盖已切换的选择。
  // 错误模式：远程目标缺少必要的访问者或主页身份时不抛错，转入身份提示；
  // 调度器已停止或无待请求好友的刷新静默忽略，返回 null。
  function choiceLabelFor(choices, value) {
    return choices.find((choice) => choice.value === value)?.label || value;
  }

  function createFriendSortSession({
    cache,
    collator,
    friends,
    http,
    now,
    pageWindow,
    runtime,
    sortBar,
    pageOwnerIdentifier,
    visitorIdentifier,
    reportError = (_stage, error) => {
      throw error;
    },
  }) {
    // ---- 私有任务登记表：调度器、状态提示与两类页面任务的生命周期。 ----
    const ACTIVITY_TASK_TYPE = "activity";
    const scheduler = createTaskScheduler({
      concurrency: 4,
      onError: (error) => reportError("远程任务", error),
    });
    const status = createStatusController({
      clearTimeout: runtime.clearTimeout ?? globalThis.clearTimeout,
      now,
      present: presentStatus,
      scheduler,
      setTimeout: runtime.setTimeout ?? globalThis.setTimeout,
    });
    const confirmRequest =
      runtime.confirm ?? pageWindow.confirm?.bind(pageWindow) ?? (() => false);
    let tietieResult = null;

    const showActivityProgress = createTaskProgressReporter({
      onProgress: runtime.onProgress,
      status,
      taskType: ACTIVITY_TASK_TYPE,
      messageFor: ({ completed, total }) =>
        `正在获取“上次活跃” ${completed}/${total}`,
    });

    // 刷新任务结束后只在相关目标仍是当前目标时重排：旧任务的迟到结果不
    // 覆盖切换后的排序选择。
    function applyActivitySort() {
      if (currentCriterion === SORT.ACTIVITY) applyCurrentSort();
    }

    function applyProfileSort() {
      if (
        currentCriterion === SORT.RELATION ||
        currentCriterion === SORT.COMPLETION
      ) {
        applyCurrentSort();
      }
    }

    const activityLifecycle = createCacheBatchLifecycle({
      applySort: applyActivitySort,
      cache,
      labelFor: () => "上次活跃",
      progressReporter: showActivityProgress,
      projectResult: (activity) => ({ activity }),
      status,
      taskType: ACTIVITY_TASK_TYPE,
    });

    const profileFields = createProfileFieldTasks({
      applySort: applyProfileSort,
      cache,
      confirmRequest,
      friends,
      http,
      onProgress: runtime.onProgress,
      scheduler,
      status,
      visitorIdentifier,
    });

    function applyTietieSort() {
      if (currentCriterion === SORT.TIETIE) applyCurrentSort();
    }

    const tietieTasks = createTietieTasks({
      applySort: applyTietieSort,
      cache,
      http,
      now,
      onProgress: runtime.onProgress,
      publishResult: (result) => {
        tietieResult = result;
      },
      scheduler,
      status,
      recipientIdentifier: pageOwnerIdentifier,
    });

    function startActivity(target, mode) {
      return startForegroundTask({
        confirmRequest,
        fetch: (friend) => http.fetchActivity(friend),
        keyFor: userIdentifierFor,
        lifecycle: activityLifecycle,
        pending: cache.friendsNeedingRefresh(
          friends,
          { kind: SORT.ACTIVITY },
          { mode },
        ),
        scheduler,
        target,
        taskType: ACTIVITY_TASK_TYPE,
      });
    }

    // ---- 私有选择状态机：当前目标、子选项、方向与展示顺序。 ----
    let currentCriterion = SORT.ADDED;
    let completionScope = COMPLETION_SCOPE.ALL;
    let relationMetric = RELATION_CHOICES[0].value;
    let statusMessage = "";
    let started = false;
    const directionByCriterion = new Map(
      [
        ...SORT_CHOICES.map(({ value }) => value),
        SORT.COMPLETION,
        SORT.RELATION,
      ].map((criterion) => [criterion, defaultDirectionFor(criterion)]),
    );

    // 展示顺序只在排序输入（目标、方向、子选项）或条件重排后变化：
    // 状态提示等纯呈现变化复用上一次结果，避免每次提示都重排好友列表。
    let lastSortKey = null;
    // 每次重排都以紧邻此前的展示顺序为输入；首次输入就是网页默认顺序。
    let lastOrderedFriends = [...friends];

    function selectionFor(criterion) {
      if (criterion === SORT.RELATION) return relationMetric;
      if (criterion === SORT.COMPLETION) return completionScope;
      return COMPLETION_SCOPE.ALL;
    }

    function currentOrder() {
      const direction = directionByCriterion.get(currentCriterion);
      const key = `${currentCriterion}|${direction}|${completionScope}|${relationMetric}`;
      if (lastSortKey !== key) {
        lastSortKey = key;
        lastOrderedFriends = sortFriends(lastOrderedFriends, {
          criterion: currentCriterion,
          friendCache: cache,
          collator,
          direction,
          completionScope,
          relationSelection: {
            metric: relationMetric,
            visitorIdentifier,
          },
          tietieResult,
        });
      }
      return lastOrderedFriends;
    }

    // 唯一的渲染过程：重排结果与当前呈现状态一次性交给排序栏投影。
    function render() {
      sortBar.render({
        criterion: currentCriterion,
        direction: directionByCriterion.get(currentCriterion),
        orderedFriends: currentOrder(),
        selection: selectionFor(currentCriterion),
        statusMessage,
      });
    }

    // 排序输入或缓存结果变化后的重排入口：强制重新计算展示顺序。
    function applyCurrentSort() {
      lastSortKey = null;
      render();
    }

    // 刷新任务的最终提示文本从这里进入同一渲染过程。
    function presentStatus(message) {
      if (message === statusMessage) return;
      statusMessage = message;
      render();
    }

    function showIdentityRequiredStatus(message) {
      if (
        status.getKind() === REFRESH_STATUS.IDENTITY_REQUIRED &&
        statusMessage === message
      )
        return;
      status.set(REFRESH_STATUS.IDENTITY_REQUIRED, message, 5_000);
    }

    function cachedTietieResult() {
      const cached = cache.tietieFor(pageOwnerIdentifier);
      return cached ? { complete: true, ...cached } : null;
    }

    const remoteTargetConfigurations = {
      [SORT.ACTIVITY]: {
        armMessageFor: () => "上次活跃",
        startRefresh: (target, mode) => startActivity(target, mode),
      },
      [SORT.RELATION]: {
        armMessageFor: (selection) =>
          choiceLabelFor(RELATION_CHOICES, selection),
        defaultSelection: RELATION_CHOICES[0].value,
        identityMessage: visitorIdentifier ? null : "请登录后使用喜好契合排序",
        selections: RELATION_CHOICES.map(({ value }) => value),
        setSelection: (selection) => {
          relationMetric = selection;
        },
        startRefresh: (target, mode) => profileFields.refresh(target, mode),
      },
      [SORT.TIETIE]: {
        armMessageFor: () => "和 TA 贴贴",
        identityMessage: pageOwnerIdentifier ? null : "无法识别主页用户",
        startRefresh: (_target, mode) => tietieTasks.refresh(mode),
      },
      [SORT.COMPLETION]: {
        armMessageFor: (selection) =>
          choiceLabelFor(COMPLETION_CHOICES, selection),
        defaultSelection: COMPLETION_SCOPE.ALL,
        selections: COMPLETION_CHOICES.map(({ value }) => value),
        setSelection: (selection) => {
          completionScope = selection;
        },
        startRefresh: (target, mode) => profileFields.refresh(target, mode),
      },
    };

    function selectRemoteCriterion(
      criterion,
      configuration,
      requestedSubcriterion,
    ) {
      // Only dropdown criteria (relation/completion) carry a selection;
      // activity's target shape drops it, so no placeholder fallback here.
      const selection = requestedSubcriterion ?? configuration.defaultSelection;
      const currentTarget = remoteTargetFor(
        currentCriterion,
        selectionFor(currentCriterion),
      );
      const requestedTarget = remoteTargetFor(criterion, selection);
      if (
        configuration.identityMessage &&
        sameRemoteTarget(currentTarget, requestedTarget)
      ) {
        showIdentityRequiredStatus(configuration.identityMessage);
        return;
      }

      const action = nextRemoteSelectionAction(
        currentTarget,
        requestedTarget,
        status.getKind(),
      );
      if (action.kind === "ignore") return;
      if (action.clearPrompt) status.clear();
      if (action.kind === "arm") {
        status.set(
          REFRESH_STATUS.AWAITING_FULL_REFRESH,
          `5 秒内再次点击“${configuration.armMessageFor(selection)}”以全量刷新`,
          5_000,
        );
        return;
      }

      configuration.setSelection?.(selection);
      currentCriterion = criterion;
      if (criterion === SORT.TIETIE) {
        tietieResult = pageOwnerIdentifier ? cachedTietieResult() : null;
      }
      applyCurrentSort();

      if (!action.refreshMode) return;
      if (configuration.identityMessage) {
        showIdentityRequiredStatus(configuration.identityMessage);
        return;
      }
      configuration.startRefresh(requestedTarget, action.refreshMode);
    }

    function selectLocalCriterion(criterion) {
      // 本地标准（加好友时间/名称）没有远程目标，不走刷新状态机；
      // 切换时只需清掉可能挂起的全量刷新提示。
      if (status.getKind() === REFRESH_STATUS.AWAITING_FULL_REFRESH)
        status.clear();

      currentCriterion = criterion;
      applyCurrentSort();
    }

    // 会话唯一的排序选择入口：本地目标只更新选择并重排，远程目标按既有
    // 状态优先级决定增量刷新、全量待命、全量刷新或忽略。
    function choose(criterion, requestedSubcriterion) {
      if (!SORT_CONFIG[criterion]) {
        throw new Error(`未知的排序目标：${criterion}`);
      }
      const configuration = remoteTargetConfigurations[criterion];
      if (configuration) {
        if (
          requestedSubcriterion != null &&
          (!configuration.selections ||
            !configuration.selections.includes(requestedSubcriterion))
        ) {
          throw new Error(`未知的排序子选项：${requestedSubcriterion}`);
        }
        selectRemoteCriterion(criterion, configuration, requestedSubcriterion);
        return;
      }
      selectLocalCriterion(criterion);
    }

    function changeDirection(direction) {
      if (
        direction !== DIRECTION.ASCENDING &&
        direction !== DIRECTION.DESCENDING
      ) {
        throw new Error(`未知的排序方向：${direction}`);
      }
      if (directionByCriterion.get(currentCriterion) === direction) return;

      directionByCriterion.set(currentCriterion, direction);
      applyCurrentSort();
    }

    // 启动会话：按网页默认顺序呈现首个名次；重复启动是 programmer error。
    function start() {
      if (started) throw new Error("远程排序会话只能启动一次");
      started = true;
      render();
    }

    return { start, choose, changeDirection };
  }

  // src/page/initialize.mjs — page assembly.

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
          indexedDB:
            runtime.indexedDB ?? browserStorage(pageWindow, "indexedDB"),
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
        mutationObserver:
          runtime.mutationObserver ?? pageWindow.MutationObserver,
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
        pageOwnerIdentifier: currentPageOwnerIdentifier(
          pageDocument,
          pageWindow,
        ),
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

  // src/main.mjs — browser entry (the only module that auto-starts).

  initialize();
})();
