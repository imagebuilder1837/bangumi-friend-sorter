import test from "node:test";
import assert from "node:assert/strict";
import { createSortBar } from "../src/sort-bar.mjs";
import { directionLabelsFor } from "../src/sorting.mjs";
import { initialize } from "../src/entry.mjs";
import { friendPageWith } from "./support/dom.mjs";
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
  setFriendVisible,
  fakeMutationObserverClass,
  assertPointerKeepsCompletionMenuOpen,
} from "./support/sort-bar.mjs";
import { friendCacheStorage } from "./support/cache.mjs";
import { topLevelCssRules, normalizeCssSelector } from "./support/css.mjs";

test("纯空白展示名称不会阻止排序栏初始化", async () => {
  const page = friendPageWith([
    { href: "/user/normal", name: "正常好友" },
    { href: "/user/ato", name: "\u3000" },
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

  assert.equal(page.list.beforeNodes.length, 1);
  assert.equal(page.list.beforeNodes[0].dataset.friendSorter, "");
});

test("初始化后每个好友项显示网页默认顺序名次", async () => {
  const page = friendPageWith([
    { href: "/user/c", name: "Cara" },
    { href: "/user/a", name: "Ann" },
    { href: "/user/b", name: "Ben" },
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

  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2", "#3"]);
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

test("页面初始化提供六个主排序目标、全部子项和各自主按钮方向", async () => {
  const failedRequest = async () => ({ kind: "http-error", status: 404 });
  const page = friendPageWith([
    { href: "/user/z", name: "Zed" },
    { href: "/user/a", name: "Ada" },
  ]);

  await initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/sai/friends" },
    },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    http: {
      fetchActivity: failedRequest,
      fetchProfile: failedRequest,
      fetchTietiePage: failedRequest,
    },
    setTimeout: () => 1,
    clearTimeout() {},
  });

  const directionButtons = directionButtonsFor(page);
  const directButtons = ["加好友时间", "名称", "上次活跃", "和我贴贴"].map(
    (label) => mainSortControl(page, label),
  );
  const relationToggle = dropdownButtonFor(page, "喜好契合");
  const completionToggle = dropdownButtonFor(page, "完成条目数");

  assert.deepEqual(
    [
      ...directButtons.map(({ textContent }) => textContent),
      relationToggle.textContent,
      completionToggle.textContent,
    ],
    ["加好友时间", "名称", "上次活跃", "和我贴贴", "喜好契合", "完成条目数"],
  );
  assert.deepEqual(
    dropdownItems(page, "喜好契合").map(({ textContent }) => textContent),
    ["同步率", "共同喜好数"],
  );
  assert.deepEqual(
    dropdownItems(page, "完成条目数").map(({ textContent }) => textContent),
    ["全部", "动画", "书籍", "音乐", "游戏", "三次元"],
  );
  assert.equal(directButtons[0].getAttribute("aria-current"), "true");
  assert.deepEqual(
    directionButtons.map(({ textContent }) => textContent),
    ["从旧到新", "从新到旧"],
  );

  for (const button of [
    directButtons[1],
    directButtons[2],
    directButtons[3],
    relationToggle,
    completionToggle,
  ]) {
    button.click();
    assert.deepEqual(
      directionButtons.map(({ textContent }) => textContent),
      [
        ...(button.textContent === "上次活跃"
          ? ["从旧到新", "从新到旧"]
          : button.textContent === "名称"
            ? ["升序", "降序"]
            : ["从低到高", "从高到低"]),
      ],
    );
    directionButtons[0].click();
    directButtons[0].click();
    button.click();
    assert.equal(directionButtons[0].getAttribute("aria-current"), "true");
    directionButtons[1].click();
    assert.equal(directionButtons[1].getAttribute("aria-current"), "true");
  }
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

test("首次渲染条目已就位时只标注名次，不移动列表项", () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const sortBar = sortBarUnderTest(page);
  const appendedNodes = [];
  const originalAppend = page.list.append.bind(page.list);
  page.list.append = (...nodes) => {
    appendedNodes.push(...nodes);
    return originalAppend(...nodes);
  };

  sortBar.render(
    renderState({
      orderedFriends: [{ originalIndex: 0 }, { originalIndex: 1 }],
    }),
  );
  assert.deepEqual(appendedNodes, []);
  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2"]);

  // 展示顺序变化时仍然移动条目并更新名次。
  sortBar.render(
    renderState({
      direction: "desc",
      orderedFriends: [{ originalIndex: 1 }, { originalIndex: 0 }],
    }),
  );
  assert.deepEqual(appendedNodes, [
    page.list.children[0],
    page.list.children[1],
  ]);
  assert.equal(page.list.children[0].textContent, "B");
  assert.equal(page.list.children[1].textContent, "A");
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

test("名次只对可见好友连续编号，隐藏好友项不参与名次", () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
    { href: "/user/c", name: "C" },
  ]);
  const sortBar = sortBarUnderTest(page);
  const ordered = [
    { originalIndex: 0 },
    { originalIndex: 1 },
    { originalIndex: 2 },
  ];

  // 无隐藏时与既有语义一致：全部连续编号。
  sortBar.render(renderState({ orderedFriends: ordered }));
  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2", "#3"]);

  // 隐藏中间项后，可见好友重新编号，隐藏项徽章保留旧文本不擦除。
  setFriendVisible(page.list.children[1], false);
  sortBar.render(renderState({ orderedFriends: ordered }));
  assert.equal(rankFor(page.list.children[0]), "#1");
  assert.equal(rankFor(page.list.children[2]), "#2");
  assert.equal(rankFor(page.list.children[1]), "#2");

  // 恢复可见后名次恢复连续编号。
  setFriendVisible(page.list.children[1], true);
  sortBar.render(renderState({ orderedFriends: ordered }));
  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2", "#3"]);
});

test("外部筛选切换后名次经可见性观察自动重排", () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
    { href: "/user/c", name: "C" },
  ]);
  const { instances, FakeMutationObserver } = fakeMutationObserverClass();
  const sortBar = createSortBar(page.document, {
    list: page.list,
    mutationObserver: FakeMutationObserver,
  });
  sortBar.bind({ selectCriterion: () => {}, selectDirection: () => {} });
  sortBar.mount();
  const ordered = [
    { originalIndex: 0 },
    { originalIndex: 1 },
    { originalIndex: 2 },
  ];
  sortBar.render(renderState({ orderedFriends: ordered }));
  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2", "#3"]);

  // 观察范围符合 ADR 0002：列表子树的 style/class 属性变化；
  // 另一个实例是祖先观察（ADR 0007），另行断言。
  assert.equal(instances.length, 2);
  assert.equal(instances[0].observedTarget, page.list);
  assert.deepEqual(instances[0].observedOptions, {
    attributes: true,
    attributeFilter: ["style", "class"],
    subtree: true,
  });

  // 模拟 friend-tag 的筛选切换：属性变化后回调重放最近一次渲染，
  // 可见好友重新编号，隐藏项徽章保留旧文本。
  setFriendVisible(page.list.children[1], false);
  instances[0].callback();
  assert.equal(rankFor(page.list.children[0]), "#1");
  assert.equal(rankFor(page.list.children[2]), "#2");
  assert.equal(rankFor(page.list.children[1]), "#2");

  // 可见性未变的重复回调幂等退出，名次保持正确。
  instances[0].callback();
  assert.deepEqual(
    [page.list.children[0], page.list.children[2]].map(rankFor),
    ["#1", "#2"],
  );

  // 恢复可见后名次恢复连续编号。
  setFriendVisible(page.list.children[1], true);
  instances[0].callback();
  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2", "#3"]);
});

test("好友视图不可呈现时挂起列表呈现，恢复后从真实 DOM 重新 reconciliation", () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
    { href: "/user/c", name: "C" },
  ]);
  const sortBar = createSortBar(page.document, { list: page.list });
  sortBar.bind({ selectCriterion: () => {}, selectDirection: () => {} });
  sortBar.mount();
  const ordered = [
    { originalIndex: 0 },
    { originalIndex: 1 },
    { originalIndex: 2 },
  ];
  sortBar.render(renderState({ orderedFriends: ordered }));
  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2", "#3"]);

  // 呈现挂起（ADR 0007）：整个好友视图不可呈现时列表重排与名次更新
  // 停摆，排序栏 chrome（状态提示）照常更新。
  page.list.style = { display: "none" };
  sortBar.render(
    renderState({
      orderedFriends: [
        { originalIndex: 2 },
        { originalIndex: 1 },
        { originalIndex: 0 },
      ],
      statusMessage: "挂起期间的提示",
    }),
  );
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["A", "B", "C"],
  );
  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2", "#3"]);
  assert.equal(statusFor(page).textContent, "挂起期间的提示");

  // 挂起期间只保留最新状态：另一种顺序的渲染同样只更新 chrome。
  const latestOrder = [
    { originalIndex: 1 },
    { originalIndex: 0 },
    { originalIndex: 2 },
  ];
  sortBar.render(renderState({ orderedFriends: latestOrder }));
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["A", "B", "C"],
  );

  // 恢复可呈现：呈现缓存已失效（null），从真实 DOM 开始 reconciliation，
  // 一次呈现最新顺序并重写名次。
  page.list.style = { display: "" };
  sortBar.render(
    renderState({ orderedFriends: latestOrder, statusMessage: "恢复后的提示" }),
  );
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["B", "A", "C"],
  );
  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2", "#3"]);
  assert.equal(statusFor(page).textContent, "恢复后的提示");
});

test("祖先属性观察器覆盖好友列表到文档根的整条祖先链", () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  // 仿真实好友页结构搭出祖先链：列表到文档根（ADR 0007）。
  const html = page.document.createElement("html");
  const body = page.document.createElement("body");
  const wrapper = page.document.createElement("div");
  const main = page.document.createElement("div");
  const columns = page.document.createElement("div");
  const column = page.document.createElement("div");
  main.append(columns);
  wrapper.append(main);
  body.append(wrapper);
  html.append(body);
  column.append(page.list);
  columns.append(column);

  const { instances, FakeMutationObserver } = fakeMutationObserverClass();
  const sortBar = createSortBar(page.document, {
    list: page.list,
    mutationObserver: FakeMutationObserver,
  });
  sortBar.bind({ selectCriterion: () => {}, selectDirection: () => {} });
  sortBar.mount();

  // 子树观察（ADR 0002）保持不变。
  assert.equal(instances.length, 2);
  assert.equal(instances[0].observedTarget, page.list);
  assert.deepEqual(instances[0].observedOptions, {
    attributes: true,
    attributeFilter: ["style", "class"],
    subtree: true,
  });

  // 祖先观察（ADR 0007）：列表之上的每个祖先各一个目标，不过滤属性名
  // —— topics 等组件用 data-* 标记驱动整体显隐，style/class 过滤会漏。
  assert.deepEqual(
    instances[1].observations.map(({ target }) => target),
    [column, columns, main, wrapper, body, html],
  );
  for (const { options } of instances[1].observations) {
    assert.deepEqual(options, { attributes: true });
  }
});

test("祖先回调只在做表现状态门控后重放，未变化时零列表写入", () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
    { href: "/user/c", name: "C" },
  ]);
  const html = page.document.createElement("html");
  const body = page.document.createElement("body");
  body.append(page.list);
  html.append(body);

  const { instances, FakeMutationObserver } = fakeMutationObserverClass();
  const sortBar = createSortBar(page.document, {
    list: page.list,
    mutationObserver: FakeMutationObserver,
  });
  sortBar.bind({ selectCriterion: () => {}, selectDirection: () => {} });
  sortBar.mount();
  const ordered = [
    { originalIndex: 0 },
    { originalIndex: 1 },
    { originalIndex: 2 },
  ];
  sortBar.render(renderState({ orderedFriends: ordered }));
  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2", "#3"]);

  let reorderWrites = 0;
  const originalAppend = page.list.append.bind(page.list);
  page.list.append = (...nodes) => {
    reorderWrites += 1;
    return originalAppend(...nodes);
  };

  // 模拟 topics 接管：祖先属性变化触发回调，列表进入不可呈现。
  page.list.style = { display: "none" };
  instances[1].callback();
  assert.equal(reorderWrites, 0);

  // 挂起期间的渲染只更新 chrome、保留最新状态。
  const latestOrder = [
    { originalIndex: 2 },
    { originalIndex: 1 },
    { originalIndex: 0 },
  ];
  sortBar.render(renderState({ orderedFriends: latestOrder }));
  assert.equal(reorderWrites, 0);

  // 模拟 topics 退出：恢复可呈现，同一属性翻转再次触发回调，
  // 重放最近一次渲染，从真实 DOM reconciliation 出最新顺序。
  page.list.style = { display: "" };
  instances[1].callback();
  assert.equal(reorderWrites, 3);
  assert.deepEqual(
    page.list.children.map((item) => item.textContent),
    ["C", "B", "A"],
  );
  assert.deepEqual(page.list.children.map(rankFor), ["#1", "#2", "#3"]);

  // 表现状态未变的后续回调门控早退，零写入。
  instances[1].callback();
  assert.equal(reorderWrites, 3);
});

test("页面初始化把可见性观察器接到好友列表上", async () => {
  const page = friendPageWith([
    { href: "/user/a", name: "A" },
    { href: "/user/b", name: "B" },
  ]);
  const { instances, FakeMutationObserver } = fakeMutationObserverClass();
  await initialize({
    document: page.document,
    window: {
      CHOBITS_USERNAME: "visitor",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    },
    storage: friendCacheStorage({}),
    now: () => 1_000,
    setTimeout: () => 1,
    clearTimeout() {},
    mutationObserver: FakeMutationObserver,
  });
  // 子树观察器接列表；祖先观察器在测试替身 DOM 无祖先时无目标，
  // 目标拓扑由专门测试断言。
  assert.equal(instances.length, 2);
  assert.equal(instances[0].observedTarget, page.list);
  assert.deepEqual(instances[1].observations, []);
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

test("非空好友列表缺少挂载布局时明确报错，保留列表且不注入样式", async () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
  const original = [...page.list.children];
  const errors = [];
  page.list.closest = () => null;

  await assert.rejects(
    initialize({
      document: page.document,
      window: {
        location: { href: "https://bgm.tv/user/sai/friends" },
        console: { error: (...args) => errors.push(args) },
      },
      storage: { getItem: () => null, setItem() {}, removeItem() {} },
    }),
    /排序栏挂载/,
  );

  assert.deepEqual(page.list.children, original);
  assert.equal(page.list.beforeNodes[0].getAttribute("role"), "alert");
  assert.match(page.list.beforeNodes[0].textContent, /排序栏挂载/);
  assert.equal(errors.length, 1);
  assert.equal(page.document.head.children.length, 0);
});

test("注入样式支持固定标签与相邻按钮之间的空隙", async () => {
  const page = friendPageWith([{ href: "/user/a", name: "A" }]);
  await initialize({
    document: page.document,
    window: { location: { href: "https://bgm.tv/user/sai/friends" } },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
  });

  const style = page.document.head.children.find(
    (child) => child?.tagName === "style",
  );
  assert.ok(style, "样式元素应已注入");
  const rules = topLevelCssRules(style.textContent);

  const expected = [
    [
      "#bangumi-friend-sorter .bangumi-friend-sorter-prefix",
      "margin-right: .25em;",
    ],
    [
      "#bangumi-friend-sorter .bangumi-friend-sorter-suffix",
      "margin-left: .25em;",
    ],
  ];
  for (const [selector, declaration] of expected) {
    const rule = rules.find(
      ({ prelude }) => normalizeCssSelector(prelude) === selector,
    );
    assert.ok(
      rule,
      `${selector} 规则应作为独立规则存活（而不是被上一行非法注释吞掉）`,
    );
    assert.ok(
      rule.block.includes(declaration),
      `${selector} 应声明 ${declaration}`,
    );
  }
});
