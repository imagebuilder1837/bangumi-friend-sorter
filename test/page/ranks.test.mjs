import test from "node:test";
import assert from "node:assert/strict";
import { createSortBar } from "../../src/page/sort-bar.mjs";
import { friendPageWith } from "../support/dom.mjs";
import {
  rankFor,
  statusFor,
  renderState,
  sortBarUnderTest,
  setFriendVisible,
  fakeMutationObserverClass,
} from "../support/sort-bar.mjs";
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
