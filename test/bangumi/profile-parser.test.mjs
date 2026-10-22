import test from "node:test";
import assert from "node:assert/strict";
import { parseProfileDocument } from "../../src/bangumi/profile-parser.mjs";
import {
  ProfileNode,
  profileStatsDocument,
  profileStatsDocumentFromFixture,
  relationProfileDocument,
  duplicateCategoryProfileDocument,
} from "../support/profile.mjs";
test("主页解析同步率和共同喜好数，缺失字段不转换为零", () => {
  assert.deepEqual(
    parseProfileDocument(
      relationProfileDocument({ syncRate: "-3.5%", commonLikes: 0 }),
    ),
    { kind: "success", relation: { syncRate: -3.5, commonLikes: 0 } },
  );
  assert.deepEqual(
    parseProfileDocument(relationProfileDocument({ syncRate: "2.25%" })),
    { kind: "success", relation: { syncRate: 2.25 } },
  );
  assert.deepEqual(
    parseProfileDocument(
      relationProfileDocument({ syncRate: "2.25%", commonLikes: "-3" }),
    ),
    { kind: "success", relation: { syncRate: 2.25 } },
  );
  assert.deepEqual(
    parseProfileDocument(
      relationProfileDocument({ syncRate: "2.25%", commonLikes: "1.5" }),
    ),
    { kind: "success", relation: { syncRate: 2.25 } },
  );
  const beyondSafeInteger = Number.MAX_SAFE_INTEGER + 1;
  assert.deepEqual(
    parseProfileDocument(
      relationProfileDocument({ commonLikes: beyondSafeInteger }),
    ),
    { kind: "success", relation: { commonLikes: beyondSafeInteger } },
  );
});

test("主页完成统计按完成描述定位六个统计范围", () => {
  const parsed = parseProfileDocument(
    profileStatsDocumentFromFixture("profile-stats.html"),
  );

  assert.deepEqual(parsed, {
    kind: "success",
    completion: { all: 20, 2: 8, 1: 10, 3: 6, 4: 4, 6: 2 },
  });
});

test("统计块存在多个完成描述时视为结构矛盾", () => {
  assert.deepEqual(
    parseProfileDocument(
      profileStatsDocumentFromFixture("profile-stats-conflict.html"),
    ),
    { kind: "invalid" },
  );
});

test("唯一完成卡存在多个数量节点时视为结构矛盾", () => {
  const aggregate = new ProfileNode({
    id: "userStats_all",
    children: [
      new ProfileNode({
        children: [
          new ProfileNode({ className: "desc", textContent: "完成" }),
          new ProfileNode({ className: "num", textContent: "20" }),
          new ProfileNode({ className: "num", textContent: "21" }),
        ],
      }),
    ],
  });
  const container = new ProfileNode({
    id: "userStatsContainers",
    children: [aggregate],
  });

  assert.deepEqual(
    parseProfileDocument({
      querySelector: (selector) =>
        selector === "#userStatsContainers"
          ? container
          : container.querySelector(selector),
    }),
    { kind: "invalid" },
  );
});

test("缺失分类块可靠解析为零，缺失聚合块视为失败", () => {
  assert.deepEqual(parseProfileDocument(profileStatsDocument()), {
    kind: "success",
    completion: { all: 20, 1: 0, 2: 8, 3: 6, 4: 4, 6: 2 },
  });

  const invalid = new ProfileNode({
    id: "userStatsContainers",
    children: [new ProfileNode({ id: "userStats_2" })],
  });
  assert.deepEqual(
    parseProfileDocument({
      querySelector: (selector) =>
        selector === "#userStatsContainers"
          ? invalid
          : invalid.querySelector(selector),
    }),
    { kind: "invalid" },
  );

  const empty = new ProfileNode({ id: "userStatsContainers" });
  assert.deepEqual(
    parseProfileDocument({
      querySelector: (selector) =>
        selector === "#userStatsContainers"
          ? empty
          : empty.querySelector(selector),
    }),
    {
      kind: "success",
      completion: { all: 0, 1: 0, 2: 0, 3: 0, 4: 0, 6: 0 },
    },
  );

  const partial = parseProfileDocument(
    profileStatsDocument({ includeBooks: true, malformedBooks: true }),
  );
  assert.equal(partial.completion["1"], undefined);
});

test("统计范围只接受容器内的唯一统计块", () => {
  const statBlock = (scope, count) =>
    new ProfileNode({
      id: `userStats_${scope}`,
      children: [
        new ProfileNode({
          children: [
            new ProfileNode({ className: "desc", textContent: "完成" }),
            new ProfileNode({ className: "num", textContent: String(count) }),
          ],
        }),
      ],
    });
  const outsideAggregate = statBlock("all", 99);
  const incompleteContainer = new ProfileNode({
    id: "userStatsContainers",
    children: [statBlock("2", 8)],
  });
  const documentWithOutsideAggregate = {
    querySelector(selector) {
      if (selector === "#userStatsContainers") return incompleteContainer;
      if (selector === "#userStats_all") return outsideAggregate;
      return incompleteContainer.querySelector(selector);
    },
  };

  assert.deepEqual(parseProfileDocument(documentWithOutsideAggregate), {
    kind: "invalid",
  });

  const duplicateContainer = new ProfileNode({
    id: "userStatsContainers",
    children: [statBlock("all", 20), statBlock("all", 21)],
  });
  assert.deepEqual(
    parseProfileDocument({
      querySelector: (selector) =>
        selector === "#userStatsContainers"
          ? duplicateContainer
          : duplicateContainer.querySelector(selector),
    }),
    { kind: "invalid" },
  );
});

test("重复分类块使完成统计解析失败，契合指标照常成功", () => {
  assert.deepEqual(parseProfileDocument(duplicateCategoryProfileDocument()), {
    kind: "success",
    relation: { syncRate: 12, commonLikes: 5 },
  });
});
