// src/sort-bar.mjs — sort controls and DOM presentation.
import {
  SORT,
  DIRECTION,
  SORT_CHOICES,
  COMPLETION_CHOICES,
  COMPLETION_SCOPE,
  RELATION_CHOICES,
} from "./choices.mjs";
import { directionLabelsFor } from "./sorting.mjs";

function installStyles(document) {
  const style = document.createElement("style");
  // The site styles #browserTools itself, but its filter rules target links.
  // These button rules mirror them; aria-current remains semantic only.
  // See docs/spec/ui.md, "原站样式基线", for the verified source and selectors.
  style.textContent = `
    #bangumi-friend-sorter.filters {
      align-items: baseline;
      display: flex;
      flex-wrap: wrap;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-sort-options,
    #bangumi-friend-sorter .bangumi-friend-sorter-direction-options {
      align-items: baseline;
      display: flex;
      flex-wrap: wrap;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-direction-options {
      margin-left: auto;
    }
    #browserTools.bangumi-friend-sorter-bar {
      box-sizing: border-box;
      width: 100%;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown {
      display: inline-block;
      position: relative;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown-menu {
      -webkit-backdrop-filter: blur(5px);
      backdrop-filter: blur(5px);
      background-color: rgba(254, 254, 254, .9);
      border-radius: 15px;
      box-shadow: inset 0 1px 1px hsla(0, 100%, 100%, .3),
        inset 0 -1px 0 hsla(0, 100%, 100%, .1),
        0 3px 15px hsla(214, 100%, 0%, .2);
      display: flex;
      flex-direction: column;
      left: -5px;
      opacity: 0;
      padding: 4px 0;
      pointer-events: none;
      position: absolute;
      top: 100%;
      transform: translateY(-4px);
      transition: opacity .15s ease, transform .15s ease, visibility .15s;
      visibility: hidden;
      width: max-content;
      min-width: 118px;
      z-index: 10;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown[data-open="true"]
      .bangumi-friend-sorter-dropdown-menu,
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown:hover
      .bangumi-friend-sorter-dropdown-menu,
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown:focus-within
      .bangumi-friend-sorter-dropdown-menu {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
      visibility: visible;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown-menu button.l {
      border-radius: 100px;
      box-sizing: border-box;
      font-size: 12px;
      line-height: 100%;
      margin: 2px 5px;
      padding: 7px 15px;
      text-align: left;
      transition: all .2s ease-in-out;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-dropdown-menu button.l:hover,
    #bangumi-friend-sorter
      .bangumi-friend-sorter-dropdown-menu button.l:focus-visible {
      background: #369cf8;
      color: #fff;
    }
    html[data-theme="dark"] #bangumi-friend-sorter
      .bangumi-friend-sorter-dropdown-menu {
      background-color: rgba(80, 80, 80, .7);
    }
    html[data-theme="dark"] #bangumi-friend-sorter
      .bangumi-friend-sorter-dropdown-menu button.l {
      color: #fff;
    }
    /* CSS has no // comments: one would be absorbed into the next
       selector, silently dropping the whole rule. */
    /* Keep a one-space gap between the fixed "按"/"排序" labels and the
       adjacent buttons so hover/focus backgrounds never touch the text. */
    #bangumi-friend-sorter .bangumi-friend-sorter-prefix {
      margin-right: .25em;
    }
    #bangumi-friend-sorter .bangumi-friend-sorter-suffix {
      margin-left: .25em;
    }
    #bangumi-friend-sorter button.l {
      appearance: none;
      background: none;
      border: 0;
      border-radius: 15px;
      color: #0084b4;
      cursor: pointer;
      font: inherit;
      margin: 0;
      padding: 2px 8px;
    }
    html[data-theme="dark"] #bangumi-friend-sorter button.l {
      color: #2ea6ff;
    }
    #bangumi-friend-sorter button.l:hover,
    #bangumi-friend-sorter button.l:focus-visible {
      background: var(--primary-color, #f09199);
      color: #fff;
      text-decoration: none;
    }
    #bangumi-friend-sorter-status {
      color: #999;
      margin-left: .6em;
    }
    /* 名次 badge: the host strong is the site's name block whose bottom
       border is the gray rule; the badge hangs just below that line,
       flush with its right end. */
    #memberUserList div.userContainer > strong {
      position: relative;
    }
    #memberUserList .bangumi-friend-sorter-rank {
      color: #000;
      font-weight: bold;
      position: absolute;
      right: 0;
      top: 100%;
    }
    html[data-theme="dark"] #memberUserList
      .bangumi-friend-sorter-rank {
      color: #ddd;
    }
  `;
  document.head.append(style);
}

function setAriaCurrent(button, isCurrent) {
  if (isCurrent) button.setAttribute("aria-current", "true");
  else button.removeAttribute("aria-current");
}

// 可见好友的判定交给浏览器的 checkVisibility，覆盖所有隐藏途径；
// 不可用时回退到内联 display 检查，兼容以 style.display 隐藏条目的
// 组件（如好友标签筛选，见 ADR 0002）。
function isEntryVisible(element) {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility();
  }
  return element.style?.display !== "none";
}

// 排序栏 deep module：排序交互与呈现的唯一边界。`bind` 一次性接收领域
// 意图回调（选择排序目标、切换方向），`render` 幂等地接收可呈现状态；
// 菜单、按钮、方向文案、状态提示、名次、ARIA、输入模态、焦点与展开
// 状态全部留在模块内部，调用方不持有或修改任何原始 DOM 节点。列表项
// 与名次锚点由排序栏自行从 list 读取，render 收到的好友记录只携带
// 领域数据并以 originalIndex（网页默认顺序位置）定位条目。模块不
// 发起远程请求，也不决定刷新策略。
// 接口约定：bind 必须在首次 render 前恰好调用一次（相对 mount 的先后
// 不限）；render 接收完整的可呈现状态，重复调用安全，展示顺序不变时
// 跳过重排与名次更新。
function createSortBar(pageDocument, { list, mutationObserver } = {}) {
  const bar = pageDocument.createElement("div");
  // Reuse the site's #browserTools frame, including its horizontal borders.
  bar.id = "browserTools";
  bar.className = "clearit bangumi-friend-sorter-bar";
  bar.dataset.friendSorter = "";
  bar.setAttribute("aria-label", "好友排序");

  // 领域意图只通过 bind 声明的回调离开排序栏；绑定前发生的事件（正常
  // 时序下不可能）被静默忽略。
  let handlers = null;

  function bind({ selectCriterion, selectDirection }) {
    if (handlers) throw new Error("排序栏的意图回调只能绑定一次");
    handlers = { selectCriterion, selectDirection };
  }

  const filters = pageDocument.createElement("div");
  filters.className = "filters";
  filters.id = "bangumi-friend-sorter";

  const sortOptions = pageDocument.createElement("span");
  sortOptions.className = "bangumi-friend-sorter-sort-options";
  // Bare text nodes are anonymous flex items and cannot carry margins, so
  // the fixed labels get wrapper spans for the breathing-room gaps.
  const prefix = pageDocument.createElement("span");
  prefix.className = "bangumi-friend-sorter-prefix";
  prefix.textContent = "按";
  sortOptions.append(prefix);

  const buttons = new Map();
  for (const { value: criterion, label } of SORT_CHOICES) {
    const button = pageDocument.createElement("button");
    button.type = "button";
    button.className = "l";
    button.textContent = label;
    button.addEventListener("click", () =>
      handlers?.selectCriterion(criterion),
    );
    sortOptions.append(button);
    buttons.set(criterion, button);
  }

  function createDropdown({
    id,
    label,
    choices,
    onDefaultSelect,
    onSelect: onChoiceSelect,
  }) {
    const dropdown = pageDocument.createElement("span");
    dropdown.className = "bangumi-friend-sorter-dropdown";

    const toggle = pageDocument.createElement("button");
    toggle.type = "button";
    toggle.className = "l bangumi-friend-sorter-dropdown-toggle";
    toggle.textContent = label;
    toggle.setAttribute("aria-haspopup", "true");
    toggle.setAttribute("aria-controls", id);
    toggle.addEventListener("click", () => {
      onDefaultSelect();
      toggle.focus?.();
    });

    const menu = pageDocument.createElement("span");
    menu.id = id;
    menu.className = "bangumi-friend-sorter-dropdown-menu";
    menu.setAttribute("role", "menu");
    const buttons = new Map();
    for (const { value, label: choiceLabel } of choices) {
      const button = pageDocument.createElement("button");
      button.type = "button";
      button.className = "l";
      button.textContent = choiceLabel;
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", () => onChoiceSelect(value));
      menu.append(button);
      buttons.set(value, button);
    }

    function setMenuOpen(isOpen) {
      dropdown.dataset.open = String(isOpen);
      toggle.setAttribute("aria-expanded", String(isOpen));
    }

    function isInsideDropdown(node) {
      return Boolean(dropdown.contains?.(node));
    }

    // Input modality of whichever pointer/keyboard interaction last took
    // focus inside the dropdown; null means programmatic or unknown focus.
    // Mouse-created focus is transient: it is released when the pointer
    // leaves, while touch/keyboard focus intentionally persists (see ADR 0001).
    let focusModality = null;

    dropdown.addEventListener("pointerdown", (event) => {
      focusModality = event.pointerType || "pointer";
    });

    function keepMenuOpenOnFocus(button) {
      button.addEventListener("focus", () => setMenuOpen(true));
      button.addEventListener("focusout", (event) => {
        if (!isInsideDropdown(event.relatedTarget)) {
          focusModality = null;
          setMenuOpen(false);
        }
      });
      button.addEventListener("keydown", (event) => {
        // 按键不接管焦点：只有键盘创建或来源不明的焦点才改记键盘模态，
        // 鼠标点击创建的焦点不因后续按键改变归属，指针离开时仍按
        // ADR-0001 释放。
        if (focusModality !== "mouse") focusModality = "keyboard";
        // 键盘创建的焦点按 ADR-0001 持久保留，Esc 不主动释放焦点。
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault?.();
        button.click();
      });
    }

    dropdown.addEventListener("pointerenter", () => setMenuOpen(true));
    dropdown.addEventListener("pointerleave", (event) => {
      // A desktop mouse click focuses the toggle; when that focus itself
      // came from the mouse, leaving the dropdown releases it so the menu
      // closes instead of lingering.
      if (
        event.pointerType === "mouse" &&
        focusModality === "mouse" &&
        isInsideDropdown(pageDocument.activeElement)
      ) {
        pageDocument.activeElement.blur?.();
        setMenuOpen(false);
        return;
      }
      if (!isInsideDropdown(pageDocument.activeElement)) setMenuOpen(false);
    });
    keepMenuOpenOnFocus(toggle);
    for (const button of buttons.values()) keepMenuOpenOnFocus(button);
    setMenuOpen(false);

    dropdown.append(toggle, menu);
    return { dropdown, button: toggle, menu, buttons };
  }

  const completionControl = createDropdown({
    id: "bangumi-friend-sorter-completion-menu",
    label: "完成条目数",
    choices: COMPLETION_CHOICES,
    onDefaultSelect: () =>
      handlers?.selectCriterion(SORT.COMPLETION, COMPLETION_SCOPE.ALL),
    onSelect: (scope) => handlers?.selectCriterion(SORT.COMPLETION, scope),
  });
  const completionDropdown = completionControl.dropdown;

  const relationControl = createDropdown({
    id: "bangumi-friend-sorter-relation-menu",
    label: "喜好契合",
    choices: RELATION_CHOICES,
    onDefaultSelect: () =>
      handlers?.selectCriterion(SORT.RELATION, RELATION_CHOICES[0].value),
    onSelect: (metric) => handlers?.selectCriterion(SORT.RELATION, metric),
  });
  const relationDropdown = relationControl.dropdown;

  sortOptions.append(relationDropdown);
  sortOptions.append(completionDropdown);

  const suffix = pageDocument.createElement("span");
  suffix.className = "bangumi-friend-sorter-suffix";
  suffix.textContent = "排序";
  sortOptions.append(suffix);
  const status = pageDocument.createElement("span");
  status.id = "bangumi-friend-sorter-status";
  status.setAttribute("aria-live", "polite");
  sortOptions.append(status);

  const directionOptions = pageDocument.createElement("span");
  directionOptions.className = "bangumi-friend-sorter-direction-options";
  const directionButtons = new Map();
  const initialDirectionLabels = directionLabelsFor(SORT.ADDED);
  for (const direction of [DIRECTION.ASCENDING, DIRECTION.DESCENDING]) {
    const button = pageDocument.createElement("button");
    button.type = "button";
    button.className = "l";
    button.textContent = initialDirectionLabels[direction];
    button.addEventListener("click", () =>
      handlers?.selectDirection(direction),
    );
    directionOptions.append(button);
    directionButtons.set(direction, button);
  }

  filters.append(sortOptions, directionOptions);
  bar.append(filters);

  // 挂载复用原站 .mainWrapper 布局：排序栏插入 .columns 之前占据整行；
  // 布局不符合预期时不修改页面。站点样式复用与必要 CSS 属于本模块，
  // 在挂载成功后注入。
  function mount() {
    const canWalkAncestors = typeof list.closest === "function";
    let mainWrapper = canWalkAncestors ? list.closest(".mainWrapper") : null;
    if (!mainWrapper && !canWalkAncestors) {
      try {
        mainWrapper = pageDocument.querySelector?.(".mainWrapper");
      } catch {
        // Lightweight test doubles may only implement the list selector.
      }
    }
    const columns = mainWrapper?.querySelector?.(".columns");
    if (
      mainWrapper &&
      columns &&
      typeof mainWrapper.insertBefore === "function"
    ) {
      mainWrapper.insertBefore(bar, columns);
      installStyles(pageDocument);
      return true;
    }
    if (!canWalkAncestors) {
      list.before(bar);
      installStyles(pageDocument);
      return true;
    }
    return false;
  }

  // 名次徽章按需创建：锚点是排序栏自行读取的原站名称块，初始名次
  // 随第一次 render 按当时展示顺序标注。
  let friendEntries = null;

  // 列表项与名次锚点由排序栏一次性自读，调用方的好友记录只携带
  // 领域数据；条目按网页默认顺序定位，与记录的 originalIndex 对齐。
  function readFriendEntries() {
    friendEntries = Array.from(list.children, (element) => ({
      element,
      rankHost: element.querySelector(".userContainer strong"),
    }));
    return friendEntries;
  }

  function entryFor(friend) {
    const entries = friendEntries ?? readFriendEntries();
    const entry = entries[friend.originalIndex];
    if (!entry) {
      throw new Error(`未知的好友条目：${friend.originalIndex}`);
    }
    return entry;
  }

  function rankBadgeFor(entry) {
    if (!entry.badge) {
      const badge = pageDocument.createElement("span");
      badge.className = "bangumi-friend-sorter-rank";
      entry.rankHost.append(badge);
      entry.badge = badge;
    }
    return entry.badge;
  }

  let lastOrderElements = null;
  let lastVisibleElements = null;
  // 最近一次收到的可呈现状态：可见性观察回调重放它以重排名次。
  let lastState = null;

  // 幂等呈现：当前选择、方向文案、菜单选中态、刷新状态提示与好友名次
  // 都由这一次渲染更新。展示顺序与上次相同（例如只有状态提示变化）时
  // 跳过重排，保持既有 DOM 操作量级。名次只对可见好友（见 CONTEXT.md）
  // 连续编号：可见集合变化而顺序未变时只重写名次、不移动列表项，
  // 隐藏项徽章保留旧文本。调用方始终传入完整的可呈现状态。
  function render(state) {
    lastState = state;
    const { criterion, direction, selection, statusMessage, orderedFriends } =
      state;
    for (const [value, button] of buttons) {
      setAriaCurrent(button, value === criterion);
    }
    setAriaCurrent(completionControl.button, criterion === SORT.COMPLETION);
    setAriaCurrent(relationControl.button, criterion === SORT.RELATION);
    for (const [scope, button] of completionControl.buttons) {
      setAriaCurrent(
        button,
        criterion === SORT.COMPLETION && scope === selection,
      );
    }
    for (const [metric, button] of relationControl.buttons) {
      setAriaCurrent(
        button,
        criterion === SORT.RELATION && metric === selection,
      );
    }
    const labels = directionLabelsFor(criterion);
    for (const [value, button] of directionButtons) {
      button.textContent = labels[value];
      setAriaCurrent(button, value === direction);
    }
    if (status.textContent !== statusMessage) {
      status.textContent = statusMessage;
    }

    const renderEntries = orderedFriends.map(entryFor);
    const elements = renderEntries.map((entry) => entry.element);
    const visibleEntries = renderEntries.filter((entry) =>
      isEntryVisible(entry.element),
    );
    const visibleElements = visibleEntries.map((entry) => entry.element);
    const currentElements = lastOrderElements ?? Array.from(list.children);
    const orderChanged =
      currentElements.length !== elements.length ||
      currentElements.some((element, index) => element !== elements[index]);
    const ranksChanged =
      lastVisibleElements === null ||
      lastVisibleElements.length !== visibleElements.length ||
      lastVisibleElements.some(
        (element, index) => element !== visibleElements[index],
      );
    lastOrderElements = elements;
    lastVisibleElements = visibleElements;
    // 已就位且可见集合未变的重复渲染连名次都不重写；首渲染由
    // lastVisibleElements 为空触发，补齐初始名次。
    if (!orderChanged && !ranksChanged) return;
    if (orderChanged) {
      for (const entry of renderEntries) list.append(entry.element);
    }
    visibleEntries.forEach((entry, index) => {
      rankBadgeFor(entry).textContent = `#${index + 1}`;
    });
  }

  // 可见性观察（ADR 0002）：任何组件切换好友项的 style/class 都视为
  // 可能的筛选变化，回调重放最近一次渲染；可见集合未变时渲染幂等
  // 退出，零 DOM 写入。首渲染前无状态可重放，静默忽略。无
  // MutationObserver（测试环境或极端浏览器）时不观察，名次仅在后续
  // 渲染时修正，属可接受的降级。
  if (typeof mutationObserver === "function") {
    new mutationObserver(() => {
      if (lastState) render(lastState);
    }).observe(list, {
      attributes: true,
      attributeFilter: ["style", "class"],
      subtree: true,
    });
  }

  return { bind, mount, render };
}

export { createSortBar };
