import test from "node:test";
import assert from "node:assert/strict";
import { initialize } from "../../src/page/initialize.mjs";
import { friendPageWith } from "../support/dom.mjs";
import {
  mainSortControl,
  directionButtonsFor,
  rankFor,
} from "../support/sort-bar.mjs";
import { documentFromFixture } from "../support/html.mjs";
test("页面交互按排序维度记忆方向并仅重排当前缓存", async () => {
  const page = friendPageWith([
    { href: "/user/z", name: "Zed" },
    { href: "/user/b", name: "Bob" },
    { href: "/user/a", name: "Ada" },
  ]);
  const previousDocument = global.document;
  const previousWindow = global.window;
  global.document = page.document;
  global.window = {
    localStorage: {
      getItem: () => null,
      removeItem() {},
      setItem() {},
    },
    location: { href: "https://bgm.tv/user/sai/friends" },
  };

  try {
    await initialize();
  } finally {
    global.document = previousDocument;
    global.window = previousWindow;
  }

  const directionButtons = directionButtonsFor(page);
  const nameButton = mainSortControl(page, "名称");
  const addedButton = mainSortControl(page, "加好友时间");
  const activityButton = mainSortControl(page, "上次活跃");

  nameButton.click();
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["Ada", "Bob", "Zed"],
  );
  directionButtons[1].click();
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["Zed", "Bob", "Ada"],
  );
  addedButton.click();
  assert.deepEqual(
    directionButtons.map(({ textContent }) => textContent),
    ["从旧到新", "从新到旧"],
  );
  assert.equal(directionButtons[0].getAttribute("aria-current"), "true");
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["Zed", "Bob", "Ada"],
  );
  directionButtons[1].click();
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["Ada", "Bob", "Zed"],
  );
  nameButton.click();
  assert.equal(directionButtons[1].getAttribute("aria-current"), "true");
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["Zed", "Bob", "Ada"],
  );
});

test("上次活跃刷新完成后沿用刷新期间选择的方向", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "Ada" },
    { href: "/user/b", name: "Bob" },
  ]);
  const previousDocument = global.document;
  const previousWindow = global.window;
  const previousDomParser = global.DOMParser;
  const fetchedAt = Date.now();
  global.document = page.document;
  global.DOMParser = class {
    parseFromString() {
      return documentFromFixture("timeline-active-seconds.html");
    }
  };
  global.window = {
    fetch: async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => "fixture",
    }),
    localStorage: {
      getItem(key) {
        if (key !== "bangumi-friend-sorter:activity-cache:v3") return null;
        return JSON.stringify({
          version: 3,
          records: {
            b: {
              activity: {
                kind: "active",
                activityAtSeconds: Date.UTC(2026, 7, 27) / 1_000,
                fetchedAt,
              },
            },
          },
        });
      },
      removeItem() {},
      setItem() {},
    },
    location: { href: "https://bgm.tv/user/sai/friends" },
  };

  try {
    await initialize();
    const directionButtons = directionButtonsFor(page);

    mainSortControl(page, "上次活跃").click();
    directionButtons[0].click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      page.list.children.map((item) => item.textContent),
      ["Ada", "Bob"],
    );
  } finally {
    global.document = previousDocument;
    global.window = previousWindow;
    global.DOMParser = previousDomParser;
  }
});

test("名次随每次重排更新，#1 始终是当前展示顺序的第一位", async () => {
  const page = friendPageWith([
    { href: "/user/z", name: "Zed" },
    { href: "/user/b", name: "Bob" },
    { href: "/user/a", name: "Ada" },
  ]);
  const previousDocument = global.document;
  const previousWindow = global.window;
  global.document = page.document;
  global.window = {
    localStorage: {
      getItem: () => null,
      removeItem() {},
      setItem() {},
    },
    location: { href: "https://bgm.tv/user/sai/friends" },
  };

  try {
    await initialize();
  } finally {
    global.document = previousDocument;
    global.window = previousWindow;
  }

  const pairs = () =>
    page.list.children.map((item) => [item.textContent, rankFor(item)]);
  const directionButtons = directionButtonsFor(page);
  const nameButton = mainSortControl(page, "名称");
  const addedButton = mainSortControl(page, "加好友时间");
  nameButton.click();
  assert.deepEqual(pairs(), [
    ["Ada", "#1"],
    ["Bob", "#2"],
    ["Zed", "#3"],
  ]);

  directionButtons[1].click();
  assert.deepEqual(pairs(), [
    ["Zed", "#1"],
    ["Bob", "#2"],
    ["Ada", "#3"],
  ]);

  addedButton.click();
  assert.deepEqual(pairs(), [
    ["Zed", "#1"],
    ["Bob", "#2"],
    ["Ada", "#3"],
  ]);
});
