// src/cache.mjs — friend and visitor-scoped persistence.
import {
  SORT,
  COMPLETION_CHOICES,
  RELATION_CHOICES,
  COMPLETION_SCOPE,
} from "./choices.mjs";
import { userIdentifierFor } from "./identity.mjs";

const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
// Completion counts and relation metrics both come from profile pages and
// share one validity window, so the TTL is named after the source.
const PROFILE_CACHE_TTL_MS = 72 * 60 * 60 * 1_000;
const TIETIE_CACHE_TTL_MS = 72 * 60 * 60 * 1_000;
// The v3 store holds activity, visitor-nested relation, completion fields,
// and visitor-scoped full tietie results, but the storage key keeps its
// historical "activity-cache" name: renaming it would strand every
// existing visitor's v3 payload.
const FRIEND_CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v3";
const PREVIOUS_CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v2";
const LEGACY_CACHE_STORAGE_KEY = "bangumi-friend-sorter:activity-cache:v1";
const COMPLETION_CACHE_FIELD_PREFIX = "completion_";
const RELATION_METRICS = new Set(RELATION_CHOICES.map(([metric]) => metric));
// 空的访问者映射或空的访问者条目按原样接受：这类形状只来自外部损坏
// 的存储载荷（脚本自身永不写出），整体拒绝会让混合映射中其他访问者
// 的有效数据一并丢失；只有未知指标或无效的指标记录使整个映射判为损坏。
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
    COMPLETION_CHOICES.map(([scope]) => [
      completionFieldFor(scope),
      isCompletionRecord,
    ]),
  );
}

// 好友缓存 deep module：好友级字段（上次活跃、完成统计、契合指标）
// 与访问者级的和我贴贴完整统计的唯一读写边界。接口约定——
// 读取：activityFor / completionFor / relationFor 只读，字段缺失或从未
//   写入时返回 null，永不写存储。friendsNeedingRefresh 按目标与模式
//   返回待请求好友：mode "full" 返回全部好友，"incremental" 只返回
//   无记录或超出对应 TTL 的好友，未知目标返回空数组。不发起请求，
//   也不改动缓存内容。tietieFor 按访问者读取完整结果；
//   tietieNeedsRefresh 只判断其 72 小时有效期，不改动缓存。
// 写入：beginRefresh 打开一个批次，accept 按好友写入校验通过的字段值，
//   complete 恰好调用一次并触发持久化；重复 complete 抛错，批次内
//   写入无效值时静默丢弃。replaceTietie 一次性替换某访问者的完整结果，
//   只有整体结果通过校验才写入。调用方不直接接触存储或校验器。
// 不变量：损坏或过期版本的存量数据在加载时被丢弃；字段值不通过校验
//   则不落盘，因此无效结果永不覆盖仍有效的旧值；持久化失败时新记录
//   保留在内存，下次成功写入再落盘。
// 错误模式：localStorage 不可用或抛错一律按尽力而为处理，读取返回
//   null、写入保持内存态，不向调用方抛出存储异常。
function createFriendCache(storage, { now = Date.now } = {}) {
  const records = new Map();
  const tietieRecords = new Map();
  const validators = new Map([
    ["activity", isActivityRecord],
    ["relation", isRelationMap],
    ...Object.entries(completionCacheFieldValidators()),
  ]);

  function read(key) {
    try {
      const value = storage?.getItem?.(key);
      return JSON.parse(value || "null");
    } catch {
      return null;
    }
  }

  function remove(key) {
    try {
      storage?.removeItem?.(key);
    } catch {
      // Removing obsolete data is best effort.
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

  function loadFields(saved) {
    if (
      saved?.version !== 3 ||
      !saved.records ||
      typeof saved.records !== "object" ||
      Array.isArray(saved.records)
    ) {
      return false;
    }

    for (const [userIdentifier, value] of Object.entries(saved.records)) {
      const fields = validateFields(value);
      if (Object.keys(fields).length > 0) records.set(userIdentifier, fields);
    }
    return true;
  }

  function loadTietie(saved) {
    if (
      saved?.version !== 3 ||
      !saved.tietie ||
      typeof saved.tietie !== "object" ||
      Array.isArray(saved.tietie)
    ) {
      return;
    }

    for (const [visitorIdentifier, value] of Object.entries(saved.tietie)) {
      if (!visitorIdentifier.trim()) continue;
      const record = normalizedTietieRecord(value);
      if (record) tietieRecords.set(visitorIdentifier, record);
    }
  }

  function persist() {
    try {
      if (!storage?.setItem) return false;
      const payload = {
        version: 3,
        records: Object.fromEntries(records),
      };
      if (tietieRecords.size > 0) {
        payload.tietie = Object.fromEntries(
          [...tietieRecords.entries()].map(([visitorIdentifier, record]) => [
            visitorIdentifier,
            serializedTietieRecord(record),
          ]),
        );
      }
      storage.setItem(FRIEND_CACHE_STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch {
      // Keep newly written records in memory when persistence is unavailable.
      return false;
    }
  }

  const current = read(FRIEND_CACHE_STORAGE_KEY);
  const hasCurrentCache = loadFields(current);
  loadTietie(current);
  const previous = read(PREVIOUS_CACHE_STORAGE_KEY);
  if (
    previous?.version === 2 &&
    previous.records &&
    typeof previous.records === "object" &&
    !Array.isArray(previous.records)
  ) {
    const migrationNow = now();
    let migrated = false;
    for (const [userIdentifier, record] of Object.entries(previous.records)) {
      if (
        validators.get("activity")?.(record) &&
        Number.isFinite(migrationNow) &&
        migrationNow - record.fetchedAt <= CACHE_TTL_MS &&
        !records.get(userIdentifier)?.activity
      ) {
        records.set(userIdentifier, {
          ...records.get(userIdentifier),
          activity: record,
        });
        migrated = true;
      }
    }
    if (migrated) {
      if (persist()) remove(PREVIOUS_CACHE_STORAGE_KEY);
    } else if (hasCurrentCache) {
      remove(PREVIOUS_CACHE_STORAGE_KEY);
    } else if (persist()) {
      remove(PREVIOUS_CACHE_STORAGE_KEY);
    }
  }

  remove(LEGACY_CACHE_STORAGE_KEY);

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
  }

  function tietieFor(visitorIdentifier) {
    const record = tietieRecords.get(visitorIdentifier);
    return record
      ? { counts: new Map(record.counts), fetchedAt: record.fetchedAt }
      : undefined;
  }

  const cache = {
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
          persist();
          completed = true;
        },
      };
    },
  };
  return cache;
}

export { createFriendCache, isCompletionRecord, isRelationRecord };
