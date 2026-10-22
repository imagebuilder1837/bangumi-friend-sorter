import test from "node:test";
import assert from "node:assert/strict";
import { createSortBar } from "../../src/page/sort-bar.mjs";
import { directionLabelsFor } from "../../src/sorting/order.mjs";
import { friendPageWith } from "../support/dom.mjs";
import {
  mountedSortBar,
  collectNodes,
  buttonsIn,
  rankFor,
  statusFor,
  mainSortControl,
  directionButtonsFor,
  dropdownButtonFor,
  dropdownItems,
  menuItemFor,
  renderState,
  sortBarUnderTest,
} from "../support/sort-bar.mjs";
test("方向文案随排序维度切换", () => {
  assert.deepEqual(directionLabelsFor("name"), {
    asc: "升序",
    desc: "降序",
  });
  assert.deepEqual(directionLabelsFor("added"), {
    asc: "从旧到新",
    desc: "从新到旧",
  });
  assert.deepEqual(directionLabelsFor("activity"), {
    asc: "从旧到新",
    desc: "从新到旧",
  });
  assert.deepEqual(directionLabelsFor("relation"), {
    asc: "从低到高",
    desc: "从高到低",
  });
  assert.deepEqual(directionLabelsFor("tietie"), {
    asc: "从低到高",
    desc: "从高到低",
  });
});

test("排序栏通过 bind 回传意图并经 render 更新方向文案", () => {
  const page = friendPageWith([]);
  const selections = [];
  const directions = [];
  const sortBar = createSortBar(page.document, { list: page.list });
  sortBar.bind({
    selectCriterion: (criterion, selection) =>
      selections.push([criterion, selection]),
    selectDirection: (direction) => directions.push(direction),
  });
  assert.equal(sortBar.mount(), true);

  const bar = mountedSortBar(page);
  assert.equal(bar.id, "browserTools");
  assert.equal(bar.className, "clearit bangumi-friend-sorter-bar");
  const allButtons = buttonsIn(bar);
  assert.deepEqual(
    ["加好友时间", "名称", "上次活跃", "喜好契合", "完成条目数"].map((label) =>
      allButtons.some(
        (button) =>
          button.textContent === label &&
          button.className.split(/\s+/).includes("l"),
      ),
    ),
    [true, true, true, true, true],
  );
  const directionButtons = directionButtonsFor(page);

  sortBar.render(renderState({ criterion: "name", direction: "desc" }));
  assert.deepEqual(
    directionButtons.map(({ textContent }) => textContent),
    ["升序", "降序"],
  );
  assert.equal(
    mainSortControl(page, "名称").getAttribute("aria-current"),
    "true",
  );
  assert.equal(directionButtons[1].getAttribute("aria-current"), "true");

  directionButtons[0].click();
  mainSortControl(page, "上次活跃").click();
  assert.deepEqual(directions, ["asc"]);
  assert.deepEqual(selections, [["activity", undefined]]);

  sortBar.render(renderState({ criterion: "activity", direction: "asc" }));
  assert.deepEqual(
    directionButtons.map(({ textContent }) => textContent),
    ["从旧到新", "从新到旧"],
  );
  assert.equal(directionButtons[0].getAttribute("aria-current"), "true");
});

test("和我贴贴是位于上次活跃与喜好契合之间的独立排序按钮", () => {
  const page = friendPageWith([]);
  const sortBar = createSortBar(page.document, { list: page.list });
  sortBar.bind({ selectCriterion() {}, selectDirection() {} });
  assert.equal(sortBar.mount(), true);

  const sortOptions = collectNodes(
    mountedSortBar(page),
    (node) =>
      typeof node?.className === "string" &&
      node.className
        .split(/\s+/)
        .includes("bangumi-friend-sorter-sort-options"),
  )[0];
  const labels = sortOptions.children
    .filter(
      (child) =>
        child?.tagName === "button" || child?.className?.includes("dropdown"),
    )
    .map((child) =>
      child.tagName === "button"
        ? child.textContent
        : child.children[0].textContent,
    );

  assert.deepEqual(labels, [
    "加好友时间",
    "名称",
    "上次活跃",
    "和我贴贴",
    "喜好契合",
    "完成条目数",
  ]);
});

test("完成条目数菜单按范围回调并只表达当前子项的无障碍状态", () => {
  const selected = [];
  const page = friendPageWith([]);
  const sortBar = createSortBar(page.document, { list: page.list });
  sortBar.bind({
    selectCriterion: (criterion, scope) => selected.push([criterion, scope]),
    selectDirection: () => {},
  });
  sortBar.mount();
  const toggle = dropdownButtonFor(page, "完成条目数");
  const menu = dropdownItems(page, "完成条目数");

  assert.equal(toggle.textContent, "完成条目数");
  assert.deepEqual(
    menu.map(({ textContent }) => textContent),
    ["全部", "动画", "书籍", "音乐", "游戏", "三次元"],
  );
  sortBar.render(
    renderState({ criterion: "completion", direction: "desc", selection: "2" }),
  );
  assert.equal(toggle.getAttribute("aria-current"), "true");
  assert.equal(
    menuItemFor(page, "完成条目数", "动画").getAttribute("aria-current"),
    "true",
  );
  assert.equal(menuItemFor(page, "完成条目数", "动画").className, "l");
  menuItemFor(page, "完成条目数", "音乐").click();
  toggle.click();
  assert.deepEqual(selected, [
    ["completion", "3"],
    ["completion", "all"],
  ]);
});

test("喜好契合菜单按指标回调并直接点击默认选择同步率", () => {
  const selected = [];
  const page = friendPageWith([]);
  const sortBar = createSortBar(page.document, { list: page.list });
  sortBar.bind({
    selectCriterion: (criterion, metric) => selected.push([criterion, metric]),
    selectDirection: () => {},
  });
  sortBar.mount();
  const toggle = dropdownButtonFor(page, "喜好契合");
  const menu = dropdownItems(page, "喜好契合");

  assert.equal(toggle.textContent, "喜好契合");
  assert.deepEqual(
    menu.map(({ textContent }) => textContent),
    ["同步率", "共同喜好数"],
  );
  sortBar.render(
    renderState({
      criterion: "relation",
      direction: "desc",
      selection: "commonLikes",
    }),
  );
  assert.equal(toggle.getAttribute("aria-current"), "true");
  assert.equal(
    menuItemFor(page, "喜好契合", "共同喜好数").getAttribute("aria-current"),
    "true",
  );
  toggle.click();
  menuItemFor(page, "喜好契合", "共同喜好数").click();
  assert.deepEqual(selected, [
    ["relation", "syncRate"],
    ["relation", "commonLikes"],
  ]);
});

test("排序栏重复渲染相同展示顺序时不重排列表，且意图回调只能绑定一次", () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const sortBar = sortBarUnderTest(page);
  assert.throws(
    () =>
      sortBar.bind({ selectCriterion: () => {}, selectDirection: () => {} }),
    /只能绑定一次/,
  );

  const ordered = [{ originalIndex: 0 }, { originalIndex: 1 }];
  sortBar.render(renderState({ orderedFriends: ordered }));
  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2"]);

  // 传入逆序记录时按网页默认顺序位置重排条目，名次跟随展示顺序。
  sortBar.render(
    renderState({ direction: "desc", orderedFriends: [...ordered].reverse() }),
  );
  assert.equal(page.list.children[0].textContent, "B");
  assert.equal(page.list.children[1].textContent, "A");
  assert.deepEqual(page.list.children.slice(0, 2).map(rankFor), ["#1", "#2"]);

  // 同一展示顺序的重复渲染（例如只有状态提示变化）不得重排好友列表。
  const sentinel = page.document.createElement("span");
  page.list.append(sentinel);
  sortBar.render(
    renderState({
      direction: "desc",
      statusMessage: "“名称”获取完成",
      orderedFriends: [...ordered].reverse(),
    }),
  );
  assert.equal(statusFor(page).textContent, "“名称”获取完成");
  assert.equal(page.list.children.at(-1), sentinel);
  assert.deepEqual(page.list.children.slice(0, 2).map(rankFor), ["#1", "#2"]);
});
