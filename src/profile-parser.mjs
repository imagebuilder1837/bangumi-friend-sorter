// src/profile-parser.mjs — profile field parsing.
import { COMPLETION_CHOICES, COMPLETION_SCOPE } from "./choices.mjs";

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
  return blocks[0] ? { block: blocks[0], kind: "found" } : { kind: "missing" };
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
    for (const [scope] of COMPLETION_CHOICES) {
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

  for (const [scope] of COMPLETION_CHOICES.slice(1)) {
    const stats = statsBlockFor(container, scope);
    if (stats.kind === "missing") {
      // 缺失的分类块可靠地为零（见 docs/spec.md）。
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

export {
  parseProfileDocument,
  parseProfileFieldOutcomes,
  successfulOutcomeValues,
};
