const test = require("node:test");
const assert = require("node:assert/strict");
const sorter = require("../src/index.user.js");
const {
  timelineDocumentFromFixture,
  tietieDocumentFromFixture,
  ProfileNode,
  profileStatsDocument,
  profileStatsDocumentFromFixture,
  relationProfileDocument,
  duplicateCategoryProfileDocument,
} = require("./support");


test("贴贴时间胶囊解析反应者、内容链接和分页", () => {
  const parsed = sorter.parseTietieTimelineDocument(
    tietieDocumentFromFixture("timeline-tietie.html"),
    {
      baseUrl: "https://bgm.tv/user/visitor/timeline?type=subject",
      category: "subject",
      page: 1,
    },
  );

  assert.equal(parsed.kind, "success");
  assert.equal(parsed.hasNextPage, true);
  assert.deepEqual(
    parsed.contents.map(({ contentKey, reactorIdentifiers }) => [
      contentKey,
      reactorIdentifiers,
    ]),
    [
      ["/subject/42", ["friend-a", "friend-b"]],
      ["/user/visitor/timeline/status/101", ["friend-b", "unknown"]],
      ["/subject/42", ["friend-a", "friend-b"]],
      ["/subject/99", ["friend-b", "friend-c"]],
    ],
  );

  const sayParsed = sorter.parseTietieTimelineDocument(
    tietieDocumentFromFixture("timeline-tietie.html"),
    {
      baseUrl: "https://bgm.tv/user/visitor/timeline?type=say",
      category: "say",
      page: 1,
    },
  );
  assert.deepEqual(
    sayParsed.contents.map(({ contentKey }) => contentKey),
    [
      "/user/visitor/timeline/status/100",
      "/user/visitor/timeline/status/101",
      "/user/visitor/timeline/status/102",
      "/user/visitor/timeline/status/103",
    ],
  );
});

test("贴贴解析按反应容器标识读取反应者", () => {
  const parsed = sorter.parseTietieTimelineDocument(
    tietieDocumentFromFixture("timeline-tietie-reaction-container.html"),
    {
      baseUrl: "https://bgm.tv/user/visitor/timeline?type=subject",
      category: "subject",
      page: 1,
    },
  );

  assert.deepEqual(parsed, {
    kind: "success",
    contents: [
      {
        contentKey: "/subject/42",
        dynamicIdentifier: "tml_55260024",
        reactionContainerIdentifier: "likes_grid_41965814",
        reactorIdentifiers: ["friend-from-reaction"],
      },
    ],
    hasNextPage: false,
  });
});

test("贴贴解析接受没有反应容器的正常收藏动态", () => {
  const parsed = sorter.parseTietieTimelineDocument(
    tietieDocumentFromFixture("timeline-tietie-reactionless-collections.html"),
    {
      baseUrl: "https://bgm.tv/user/visitor/timeline?type=subject",
      category: "subject",
      page: 1,
    },
  );

  assert.deepEqual(parsed, {
    kind: "success",
    contents: [
      {
        contentKey: "/subject/72474594",
        dynamicIdentifier: "tml_72474594",
        reactionContainerIdentifier: null,
        reactorIdentifiers: [],
      },
      {
        contentKey: "/subject/72245434",
        dynamicIdentifier: "tml_72245434",
        reactionContainerIdentifier: null,
        reactorIdentifiers: [],
      },
    ],
    hasNextPage: false,
  });
});

test("贴贴解析没有内容链接但有动态和反应容器标识时仍纳入统计", () => {
  const parsed = sorter.parseTietieTimelineDocument(
    tietieDocumentFromFixture("timeline-tietie-missing-content.html"),
    {
      baseUrl: "https://bgm.tv/user/visitor/timeline?type=say",
      category: "say",
      page: 1,
    },
  );

  assert.deepEqual(parsed, {
    kind: "success",
    contents: [
      {
        contentKey: null,
        dynamicIdentifier: "tml_55260025",
        reactionContainerIdentifier: "likes_grid_41965815",
        reactorIdentifiers: ["friend-from-reaction"],
      },
    ],
    hasNextPage: false,
  });
});

test("贴贴解析区分合法空页与缺少数据的残缺页", () => {
  assert.deepEqual(
    sorter.parseTietieTimelineDocument(
      tietieDocumentFromFixture("timeline-empty.html"),
    ),
    { kind: "empty", contents: [], hasNextPage: false },
  );
  assert.deepEqual(
    sorter.parseTietieTimelineDocument(
      tietieDocumentFromFixture("timeline-tietie-missing-data.html"),
      {
        baseUrl: "https://bgm.tv/user/visitor/timeline?type=subject",
        category: "subject",
        page: 1,
      },
    ),
    { kind: "invalid" },
  );
  assert.deepEqual(
    sorter.parseTietieTimelineDocument(
      tietieDocumentFromFixture("timeline-partial.html"),
    ),
    { kind: "invalid" },
  );
});

test("贴贴解析接受分类时间胶囊省略动态容器的可靠空页", () => {
  assert.deepEqual(
    sorter.parseTietieTimelineDocument(
      tietieDocumentFromFixture("timeline-tietie-empty-no-container.html"),
      {
        baseUrl: "https://bgm.tv/user/visitor/timeline?type=say",
        category: "say",
        page: 3,
      },
    ),
    { kind: "empty", contents: [], hasNextPage: false },
  );
  assert.deepEqual(
    sorter.parseTietieTimelineDocument(
      tietieDocumentFromFixture(
        "timeline-tietie-empty-subject-no-container.html",
      ),
      {
        baseUrl: "https://bgm.tv/user/visitor/timeline?type=subject",
        category: "subject",
        page: 1,
      },
    ),
    { kind: "empty", contents: [], hasNextPage: false },
  );
});

test("贴贴解析拒绝分类不匹配或含未知内容的无容器页", () => {
  assert.deepEqual(
    sorter.parseTietieTimelineDocument(
      tietieDocumentFromFixture("timeline-tietie-empty-no-container.html"),
      {
        baseUrl: "https://bgm.tv/user/visitor/timeline?type=subject",
        category: "subject",
        page: 3,
      },
    ),
    { kind: "invalid" },
  );
  assert.deepEqual(
    sorter.parseTietieTimelineDocument(
      tietieDocumentFromFixture("timeline-tietie-empty-unknown.html"),
      {
        baseUrl: "https://bgm.tv/user/visitor/timeline?type=say",
        category: "say",
        page: 3,
      },
    ),
    { kind: "invalid" },
  );
});

test("从时间胶囊首条动态读取活跃时刻", () => {
  const document = timelineDocumentFromFixture("timeline-active.html");

  assert.deepEqual(
    sorter.parseTimelineDocument(
      document,
      Date.UTC(2026, 7, 26, 6, 37, 34) / 1_000,
    ),
    {
      kind: "active",
      activityAtSeconds: Date.UTC(2026, 6, 4, 6, 37) / 1_000,
    },
  );
});

test("省略秒的大单位文案不推测更小单位", () => {
  const document = timelineDocumentFromFixture("timeline-active.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 6, 4, 6, 37) / 1_000,
  });
});

test("活跃时刻保留页面提供的整数 Unix 秒精度", () => {
  const document = timelineDocumentFromFixture("timeline-active-seconds.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
  });
});

test("只有分钟的相对文案不推测秒数", () => {
  const document = timelineDocumentFromFixture(
    "timeline-active-minutes-only.html",
  );
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 34) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42) / 1_000,
  });
});

test("“分钟”后缀不阻止分秒文案恢复秒数", () => {
  const document = timelineDocumentFromFixture(
    "timeline-active-minutes-suffix-seconds.html",
  );
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 36) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
  });
});

test("含“分钟”的大单位文案不推测秒数", () => {
  const document = timelineDocumentFromFixture(
    "timeline-active-minutes-suffix-large.html",
  );
  const responseTime = Date.UTC(2026, 7, 26, 9, 43, 34) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 7, 42) / 1_000,
  });
});

test("刚刚按参考时间恢复秒数并保持绝对分钟", () => {
  const document = timelineDocumentFromFixture("timeline-active-just-now.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42, 34) / 1_000,
  });
});

test("相对秒数与绝对分钟冲突时回退到分钟起点", () => {
  const document = timelineDocumentFromFixture("timeline-active-seconds.html");
  const responseTime = Date.UTC(2026, 7, 26, 9, 44, 36) / 1_000;

  assert.deepEqual(sorter.parseTimelineDocument(document, responseTime), {
    kind: "active",
    activityAtSeconds: Date.UTC(2026, 7, 26, 9, 42) / 1_000,
  });
});

test("有效的空时间胶囊被识别为无公开动态", () => {
  const document = timelineDocumentFromFixture("timeline-empty.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), { kind: "empty" });
});

test("只有孤立时间线容器的残缺页面被识别为失败", () => {
  const document = timelineDocumentFromFixture("timeline-partial.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), { kind: "invalid" });
});

test("首条动态缺失精确时间时被识别为失败", () => {
  const document = timelineDocumentFromFixture("timeline-missing-time.html");

  assert.deepEqual(sorter.parseTimelineDocument(document), { kind: "invalid" });
});

test("主页解析同步率和共同喜好数，缺失字段不转换为零", () => {
  assert.deepEqual(
    sorter.parseProfileDocument(
      relationProfileDocument({ syncRate: "-3.5%", commonLikes: 0 }),
    ),
    { kind: "success", relation: { syncRate: -3.5, commonLikes: 0 } },
  );
  assert.deepEqual(
    sorter.parseProfileDocument(relationProfileDocument({ syncRate: "2.25%" })),
    { kind: "success", relation: { syncRate: 2.25 } },
  );
  assert.deepEqual(
    sorter.parseProfileDocument(
      relationProfileDocument({ syncRate: "2.25%", commonLikes: "-3" }),
    ),
    { kind: "success", relation: { syncRate: 2.25 } },
  );
  assert.deepEqual(
    sorter.parseProfileDocument(
      relationProfileDocument({ syncRate: "2.25%", commonLikes: "1.5" }),
    ),
    { kind: "success", relation: { syncRate: 2.25 } },
  );
  const beyondSafeInteger = Number.MAX_SAFE_INTEGER + 1;
  assert.deepEqual(
    sorter.parseProfileDocument(
      relationProfileDocument({ commonLikes: beyondSafeInteger }),
    ),
    { kind: "success", relation: { commonLikes: beyondSafeInteger } },
  );
});

test("主页完成统计按完成描述定位六个统计范围", () => {
  const parsed = sorter.parseProfileDocument(
    profileStatsDocumentFromFixture("profile-stats.html"),
  );

  assert.deepEqual(parsed, {
    kind: "success",
    completion: { all: 20, 2: 8, 1: 10, 3: 6, 4: 4, 6: 2 },
  });
});

test("统计块存在多个完成描述时视为结构矛盾", () => {
  assert.deepEqual(
    sorter.parseProfileDocument(
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
    sorter.parseProfileDocument({
      querySelector: (selector) =>
        selector === "#userStatsContainers"
          ? container
          : container.querySelector(selector),
    }),
    { kind: "invalid" },
  );
});

test("缺失分类块可靠解析为零，缺失聚合块视为失败", () => {
  assert.deepEqual(sorter.parseProfileDocument(profileStatsDocument()), {
    kind: "success",
    completion: { all: 20, 1: 0, 2: 8, 3: 6, 4: 4, 6: 2 },
  });

  const invalid = new ProfileNode({
    id: "userStatsContainers",
    children: [new ProfileNode({ id: "userStats_2" })],
  });
  assert.deepEqual(
    sorter.parseProfileDocument({
      querySelector: (selector) =>
        selector === "#userStatsContainers"
          ? invalid
          : invalid.querySelector(selector),
    }),
    { kind: "invalid" },
  );

  const empty = new ProfileNode({ id: "userStatsContainers" });
  assert.deepEqual(
    sorter.parseProfileDocument({
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

  const partial = sorter.parseProfileDocument(
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

  assert.deepEqual(sorter.parseProfileDocument(documentWithOutsideAggregate), {
    kind: "invalid",
  });

  const duplicateContainer = new ProfileNode({
    id: "userStatsContainers",
    children: [statBlock("all", 20), statBlock("all", 21)],
  });
  assert.deepEqual(
    sorter.parseProfileDocument({
      querySelector: (selector) =>
        selector === "#userStatsContainers"
          ? duplicateContainer
          : duplicateContainer.querySelector(selector),
    }),
    { kind: "invalid" },
  );
});

test("重复分类块使完成统计解析失败，契合指标照常成功", () => {
  assert.deepEqual(
    sorter.parseProfileDocument(duplicateCategoryProfileDocument()),
    {
      kind: "success",
      relation: { syncRate: 12, commonLikes: 5 },
    },
  );
});
