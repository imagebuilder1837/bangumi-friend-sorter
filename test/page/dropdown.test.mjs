import test from "node:test";
import assert from "node:assert/strict";
import { createSortBar } from "../../src/page/sort-bar.mjs";
import { friendPageWith } from "../support/dom.mjs";
import {
  dropdownButtonFor,
  menuItemFor,
  sortBarUnderTest,
  assertPointerKeepsCompletionMenuOpen,
} from "../support/sort-bar.mjs";
test("喜好契合菜单的焦点状态只控制自身菜单", () => {
  const page = friendPageWith([]);
  const sortBar = createSortBar(page.document, { list: page.list });
  sortBar.bind({ selectCriterion: () => {}, selectDirection: () => {} });
  sortBar.mount();
  const relationButton = dropdownButtonFor(page, "喜好契合");

  relationButton.focus();
  assert.equal(relationButton.getAttribute("aria-expanded"), "true");
  menuItemFor(page, "喜好契合", "共同喜好数").focus();
  assert.equal(relationButton.getAttribute("aria-expanded"), "true");
  page.document.createElement("div").focus();
  assert.equal(relationButton.getAttribute("aria-expanded"), "false");
});

test("完成条目数菜单悬停时打开、移开时关闭", () => {
  const page = friendPageWith([]);
  sortBarUnderTest(page);
  const toggle = dropdownButtonFor(page, "完成条目数");
  const dropdown = toggle.parentElement;

  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  dropdown.dispatchEvent({ type: "pointerenter", pointerType: "mouse" });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(dropdown.dataset.open, "true");

  dropdown.dispatchEvent({ type: "pointerleave", pointerType: "mouse" });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("完成条目数菜单的键盘焦点不因鼠标移出而关闭", () => {
  const selected = [];
  const page = friendPageWith([]);
  sortBarUnderTest(page, {
    onSelectCriterion: (criterion, scope) => selected.push([criterion, scope]),
  });
  const toggle = dropdownButtonFor(page, "完成条目数");
  const bookButton = menuItemFor(page, "完成条目数", "书籍");
  const musicButton = menuItemFor(page, "完成条目数", "音乐");

  toggle.focus();
  assert.equal(page.document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  toggle.parentElement.dispatchEvent({
    type: "pointerleave",
    pointerType: "mouse",
  });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  bookButton.focus();
  const keyboardEvent = { type: "keydown", key: "Enter" };
  bookButton.dispatchEvent(keyboardEvent);
  assert.equal(keyboardEvent.defaultPrevented, true);
  assert.deepEqual(selected, [["completion", "1"]]);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  musicButton.focus();
  const spaceEvent = { type: "keydown", key: " " };
  musicButton.dispatchEvent(spaceEvent);
  assert.equal(spaceEvent.defaultPrevented, true);
  assert.deepEqual(selected, [
    ["completion", "1"],
    ["completion", "3"],
  ]);

  page.document.createElement("div").focus();
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("完成条目数菜单支持触屏点击后保留菜单", () => {
  const { page, selected, toggle } =
    assertPointerKeepsCompletionMenuOpen("touch");
  const musicButton = menuItemFor(page, "完成条目数", "音乐");

  musicButton.focus();
  musicButton.click();
  assert.deepEqual(selected, [
    ["completion", "all"],
    ["completion", "3"],
  ]);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
});

test("完成条目数菜单支持触控笔点击后保留菜单", () => {
  assertPointerKeepsCompletionMenuOpen("pen");
});

test("完成条目数菜单在鼠标点击后移开指针时释放焦点并收起", () => {
  const selected = [];
  const page = friendPageWith([]);
  sortBarUnderTest(page, {
    onSelectCriterion: (criterion, scope) => selected.push([criterion, scope]),
  });
  const toggle = dropdownButtonFor(page, "完成条目数");
  const dropdown = toggle.parentElement;

  dropdown.dispatchEvent({ type: "pointerenter", pointerType: "mouse" });
  dropdown.dispatchEvent({ type: "pointerdown", pointerType: "mouse" });
  toggle.click();
  assert.deepEqual(selected, [["completion", "all"]]);
  assert.equal(page.document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  dropdown.dispatchEvent({ type: "pointerleave", pointerType: "mouse" });
  assert.equal(page.document.activeElement, null);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("鼠标创建的焦点不因后续按键改为键盘模态（ADR-0001）", () => {
  const selected = [];
  const page = friendPageWith([]);
  sortBarUnderTest(page, {
    onSelectCriterion: (criterion, scope) => selected.push([criterion, scope]),
  });
  const toggle = dropdownButtonFor(page, "完成条目数");
  const dropdown = toggle.parentElement;

  dropdown.dispatchEvent({ type: "pointerenter", pointerType: "mouse" });
  dropdown.dispatchEvent({ type: "pointerdown", pointerType: "mouse" });
  toggle.click();
  assert.deepEqual(selected, [["completion", "all"]]);
  assert.equal(page.document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  // 焦点由鼠标点击创建：按键只是触发选中，不改变焦点归属，指针离开时
  // 仍应释放焦点并收起菜单。
  const enterEvent = { type: "keydown", key: "Enter" };
  toggle.dispatchEvent(enterEvent);
  assert.equal(enterEvent.defaultPrevented, true);
  assert.deepEqual(selected, [
    ["completion", "all"],
    ["completion", "all"],
  ]);
  assert.equal(page.document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  dropdown.dispatchEvent({ type: "pointerleave", pointerType: "mouse" });
  assert.equal(page.document.activeElement, null);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});
