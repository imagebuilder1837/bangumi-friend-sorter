import test from "node:test";
import assert from "node:assert/strict";
import { parseTietieTimelineDocument } from "../../src/bangumi/tietie-parser.mjs";
import { documentFromFixture } from "../support/html.mjs";
test("贴贴时间胶囊解析反应者、内容链接和分页", () => {
  const parsed = parseTietieTimelineDocument(
    documentFromFixture("timeline-tietie.html"),
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

  const sayParsed = parseTietieTimelineDocument(
    documentFromFixture("timeline-tietie.html"),
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
  const parsed = parseTietieTimelineDocument(
    documentFromFixture("timeline-tietie-reaction-container.html"),
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
  const parsed = parseTietieTimelineDocument(
    documentFromFixture("timeline-tietie-reactionless-collections.html"),
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
  const parsed = parseTietieTimelineDocument(
    documentFromFixture("timeline-tietie-missing-content.html"),
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
    parseTietieTimelineDocument(documentFromFixture("timeline-empty.html")),
    { kind: "empty", contents: [], hasNextPage: false },
  );
  assert.deepEqual(
    parseTietieTimelineDocument(
      documentFromFixture("timeline-tietie-missing-data.html"),
      {
        baseUrl: "https://bgm.tv/user/visitor/timeline?type=subject",
        category: "subject",
        page: 1,
      },
    ),
    { kind: "invalid" },
  );
  assert.deepEqual(
    parseTietieTimelineDocument(documentFromFixture("timeline-partial.html")),
    { kind: "invalid" },
  );
});

test("贴贴解析接受分类时间胶囊省略动态容器的可靠空页", () => {
  assert.deepEqual(
    parseTietieTimelineDocument(
      documentFromFixture("timeline-tietie-empty-no-container.html"),
      {
        baseUrl: "https://bgm.tv/user/visitor/timeline?type=say",
        category: "say",
        page: 3,
      },
    ),
    { kind: "empty", contents: [], hasNextPage: false },
  );
  assert.deepEqual(
    parseTietieTimelineDocument(
      documentFromFixture("timeline-tietie-empty-subject-no-container.html"),
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
    parseTietieTimelineDocument(
      documentFromFixture("timeline-tietie-empty-no-container.html"),
      {
        baseUrl: "https://bgm.tv/user/visitor/timeline?type=subject",
        category: "subject",
        page: 3,
      },
    ),
    { kind: "invalid" },
  );
  assert.deepEqual(
    parseTietieTimelineDocument(
      documentFromFixture("timeline-tietie-empty-unknown.html"),
      {
        baseUrl: "https://bgm.tv/user/visitor/timeline?type=say",
        category: "say",
        page: 3,
      },
    ),
    { kind: "invalid" },
  );
});
