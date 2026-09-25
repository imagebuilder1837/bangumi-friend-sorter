import assert from "node:assert/strict";
import { createSortBar } from "../../src/sort-bar.mjs";
import { friendPageWith } from "./dom.mjs";

function mountedSortBar(page) {
  return page.list.beforeNodes[0];
}

function collectNodes(root, predicate) {
  const found = [];
  const visit = (node) => {
    if (predicate(node)) found.push(node);
    for (const child of node?.children ?? []) visit(child);
  };
  visit(root);
  return found;
}

function buttonsIn(root) {
  return collectNodes(root, (node) => node?.tagName === "button");
}

function rankFor(item) {
  const strong = item.querySelector(".userContainer strong");
  return strong.children.at(-1).textContent;
}

function statusFor(page) {
  return collectNodes(
    mountedSortBar(page),
    (node) => node?.id === "bangumi-friend-sorter-status",
  )[0];
}

function mainSortControl(page, label) {
  return buttonsIn(mountedSortBar(page)).find(
    (button) =>
      button.textContent === label &&
      button.getAttribute("aria-haspopup") !== "true",
  );
}

function directionOptionsFor(page) {
  return collectNodes(
    mountedSortBar(page),
    (node) =>
      typeof node?.className === "string" &&
      node.className
        .split(/\s+/)
        .includes("bangumi-friend-sorter-direction-options"),
  )[0];
}

function directionButtonsFor(page) {
  return directionOptionsFor(page).children.filter(
    (child) => child?.tagName === "button",
  );
}

function dropdownButtonFor(page, label) {
  return buttonsIn(mountedSortBar(page)).find(
    (button) =>
      button.textContent === label &&
      button.getAttribute("aria-haspopup") === "true",
  );
}

function dropdownItems(page, label) {
  const menu = dropdownButtonFor(page, label).parentElement.children.find(
    (child) => child.getAttribute?.("role") === "menu",
  );
  return menu.children;
}

// Locate a dropdown item by its visible label, never by child-node position.
function menuItemFor(page, label, itemText) {
  return dropdownItems(page, label).find(
    (item) => item.textContent === itemText,
  );
}

// sortBar.render 的默认状态：测试按需覆盖单个字段，避免五字段字面量重复。
function renderState(overrides = {}) {
  return {
    criterion: "added",
    direction: "asc",
    selection: "all",
    statusMessage: "",
    orderedFriends: [],
    ...overrides,
  };
}

function sortBarUnderTest(page, { onSelectCriterion = () => {} } = {}) {
  const sortBar = createSortBar(page.document, { list: page.list });
  sortBar.bind({
    selectCriterion: onSelectCriterion,
    selectDirection: () => {},
  });
  sortBar.mount();
  return sortBar;
}

// 模拟外部筛选组件切换可见性的入口：隐藏与恢复好友项。
function setFriendVisible(item, visible) {
  item.style.display = visible ? "" : "none";
}

// 注入用的 MutationObserver 替身：记录观察目标与选项，暴露回调供测试
// 手动触发属性变化后的重排路径。
function fakeMutationObserverClass() {
  const instances = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      instances.push(this);
    }
    observe(target, options) {
      this.observedTarget = target;
      this.observedOptions = options;
    }
  }
  return { instances, FakeMutationObserver };
}

function assertPointerKeepsCompletionMenuOpen(pointerType) {
  const selected = [];
  const page = friendPageWith([]);
  sortBarUnderTest(page, {
    onSelectCriterion: (criterion, scope) => selected.push([criterion, scope]),
  });
  const toggle = dropdownButtonFor(page, "完成条目数");
  const dropdown = toggle.parentElement;

  dropdown.dispatchEvent({ type: "pointerdown", pointerType });
  toggle.click();
  assert.deepEqual(selected, [["completion", "all"]]);
  assert.equal(page.document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  dropdown.dispatchEvent({ type: "pointerleave", pointerType });
  assert.equal(page.document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  return { page, selected, toggle };
}

export {
  mountedSortBar,
  collectNodes,
  buttonsIn,
  rankFor,
  statusFor,
  mainSortControl,
  directionOptionsFor,
  directionButtonsFor,
  dropdownButtonFor,
  dropdownItems,
  menuItemFor,
  renderState,
  sortBarUnderTest,
  setFriendVisible,
  fakeMutationObserverClass,
  assertPointerKeepsCompletionMenuOpen,
};
