// src/sorting.mjs — stable ordering and direction labels.
import {
  SORT,
  COMPLETION_SCOPE,
  DIRECTION,
  RELATION_CHOICES,
} from "./choices.mjs";
import { userIdentifierFor } from "./identity.mjs";
import { isCompletionRecord, isRelationRecord } from "./cache.mjs";

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
    compare: numericValueCompare((friend, { completionScope, friendCache }) => {
      const completion = friendCache.completionFor(
        userIdentifierFor(friend),
        completionScope,
      );
      return isCompletionRecord(completion) ? completion.value : null;
    }),
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

export {
  SORT_CONFIG,
  directionLabelsFor,
  defaultDirectionFor,
  nameCollator,
  sortFriends,
};
