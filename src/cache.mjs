// src/cache.mjs — friend and visitor-scoped persistence.
import {
  SORT,
  COMPLETION_CHOICES,
  RELATION_CHOICES,
  COMPLETION_SCOPE,
} from "./choices.mjs";
import { userIdentifierFor } from "./identity.mjs";
import { openFriendCacheStorage } from "./cache-storage.mjs";

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

// 好友字段与访问者级贴贴结果的唯一领域读写边界。
// 先等待 ready 完成初始化；之后领域读取只访问内存，缺失返回 undefined。
// beginRefresh.accept 同步接纳有效结果；complete 只能调用一次，返回
// Promise<boolean> 表示本次持久化是否提交。replaceTietie 同步返回结果
// 是否被接纳，不保证落盘；它只接受完整的访问者统计。
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
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};

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
      for (const [visitor, value] of Object.entries(saved.tietie)) {
        const record = normalizedTietieRecord(value);
        if (visitor.trim() && record)
          entries.push({
            key: ["tietie", visitor],
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
    return records.get(userIdentifier)?.relation?.[visitorIdentifier]?.[metric];
  }

  function setField(userIdentifier, field, value) {
    const validator = validatorFor(field);
    if (typeof validator !== "function" || !validator(value)) return;
    const fields = records.get(userIdentifier) || {};
    fields[field] = value;
    records.set(userIdentifier, fields);
    remember([field, userIdentifier], value);
  }

  function setRelationField(userIdentifier, visitorIdentifier, metric, value) {
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

  function tietieFor(visitorIdentifier) {
    const record = tietieRecords.get(visitorIdentifier);
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
    tietieNeedsRefresh(visitorIdentifier) {
      const record = tietieRecords.get(visitorIdentifier);
      return !record || now() - record.fetchedAt > TIETIE_CACHE_TTL_MS;
    },
    replaceTietie(visitorIdentifier, result) {
      if (typeof visitorIdentifier !== "string" || !visitorIdentifier.trim()) {
        return false;
      }
      const record = normalizedTietieRecord(result);
      if (!record) return false;
      tietieRecords.set(visitorIdentifier, record);
      remember(["tietie", visitorIdentifier], serializedTietieRecord(record));
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

export { createFriendCache, isCompletionRecord, isRelationRecord };
