import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { initialize } from "../../src/page/initialize.mjs";
import { createSortBar } from "../../src/page/sort-bar.mjs";
import { waitForCondition } from "../support/timing.mjs";
function friend(identifier, name = identifier) {
  return `<li class="user"><div class="userContainer"><strong><a class="avatar" href="/user/${identifier}">${name}</a></strong></div></li>`;
}

function pageFor(t, items) {
  const page = new JSDOM(
    `<div class="mainWrapper"><div class="columns"><ul id="memberUserList">${items}</ul></div></div>`,
    { url: "https://bgm.tv/user/viewed/friends" },
  );
  t.after(() => page.window.close());
  page.window.addEventListener("error", (event) => event.preventDefault());
  const { document } = page.window;
  const errors = [];
  const summaries = [];
  page.window.console.error = (...args) => errors.push(args);
  page.window.console.info = (...args) => summaries.push(args);
  return {
    window: page.window,
    document,
    list: document.querySelector("#memberUserList"),
    errors,
    summaries,
    button: (label) =>
      [...document.querySelectorAll("#browserTools button")].find(
        (node) => node.textContent === label,
      ),
  };
}

test("相同用户标识保留首个原节点，即使名称不同，排序与名次仍正确", async (t) => {
  const page = pageFor(
    t,
    friend("zed", "Zed") + friend("amy", "Amy") + friend("zed", "另一个名称"),
  );
  const [zed, amy, duplicate] = page.list.children;

  await initialize(page);

  assert.deepEqual([...page.list.children], [zed, amy]);
  assert.equal(duplicate.isConnected, false);
  page.button("名称").click();
  assert.deepEqual([...page.list.children], [amy, zed]);
  assert.equal(
    amy.querySelector(".bangumi-friend-sorter-rank").textContent,
    "#1",
  );
  assert.equal(
    zed.querySelector(".bangumi-friend-sorter-rank").textContent,
    "#2",
  );
  page.button("加好友时间").click();
  assert.deepEqual([...page.list.children], [zed, amy]);
  assert.equal(page.document.querySelector('[role="alert"]'), null);
  assert.equal(page.summaries.length, 1);
});

test("缺少名次展示位置在实际渲染时明确报错，不伪装成空列表", async (t) => {
  const page = pageFor(t, friend("zed", "Zed"));
  const anchor = page.list.querySelector("a.avatar");
  anchor.parentElement.replaceWith(anchor);
  let failure;

  await assert.rejects(initialize(page), (error) => {
    failure = error;
    return /名次.*缺少/.test(error.message);
  });

  assert.ok(page.button("名称"), "好友读取成功，排序栏已经挂载");
  assert.match(
    page.document.querySelector('[role="alert"]').textContent,
    /名次/,
  );
  assert.equal(page.errors[0][1], failure);
});

test("异步远程解析异常显示原始原因，后续本地排序不覆盖故障提示", async (t) => {
  const page = pageFor(t, friend("zed", "Zed") + friend("amy", "Amy"));
  const failure = new Error("parser bug");
  await initialize({
    ...page,
    domParser: {
      parseFromString() {
        throw failure;
      },
    },
    fetchImpl: async () => ({ ok: true, text: async () => "html" }),
    setTimeout: () => 1,
    clearTimeout() {},
  });

  page.button("上次活跃").click();
  await waitForCondition(() => page.errors.length > 0);

  assert.equal(page.errors[0][1], failure);
  assert.match(
    page.document.querySelector('[role="alert"]').textContent,
    /远程.*parser bug/,
  );
  page.button("名称").click();
  assert.equal(
    page.list.firstElementChild.querySelector("a").textContent,
    "Amy",
  );
  assert.match(
    page.document.querySelector('[role="alert"]').textContent,
    /parser bug/,
  );
});

test("缺少远程能力不阻断本地排序，真正请求远程数据时才报告缺失能力", async (t) => {
  const page = pageFor(t, friend("zed", "Zed") + friend("amy", "Amy"));
  await initialize({ ...page, setTimeout: () => 1, clearTimeout() {} });
  page.button("名称").click();
  assert.equal(
    page.list.firstElementChild.querySelector("a").textContent,
    "Amy",
  );
  assert.equal(page.errors.length, 0);

  page.button("上次活跃").click();
  await waitForCondition(() => page.errors.length > 0);

  assert.match(
    page.document.querySelector('[role="alert"]').textContent,
    /fetch/,
  );
});

test("排序交互回调的异常在页面可见，同时保留原始宿主异常", (t) => {
  const page = pageFor(t, friend("zed"));
  const failure = new Error("selection bug");
  const hostErrors = [];
  page.window.addEventListener("error", (event) => {
    hostErrors.push(event.error);
    event.preventDefault();
  });
  const bar = createSortBar(page.document, { list: page.list });
  bar.bind({
    selectCriterion() {
      throw failure;
    },
    selectDirection() {},
  });
  bar.mount();

  page.button("名称").click();

  assert.deepEqual(hostErrors, [failure]);
  assert.match(
    page.document.querySelector('[role="alert"]').textContent,
    /排序选择.*selection bug/,
  );
  assert.equal(page.errors[0][1], failure);
});

test("远程任务程序异常停止该批未发出的请求，不继续刷屏或保留获取中状态", async (t) => {
  const page = pageFor(
    t,
    Array.from({ length: 6 }, (_, index) => friend(`friend-${index}`)).join(""),
  );
  const failure = new Error("adapter bug");
  let requests = 0;
  await initialize({
    ...page,
    http: {
      fetchActivity: async () => {
        requests += 1;
        throw failure;
      },
    },
    setTimeout: () => 1,
    clearTimeout() {},
  });

  page.button("上次活跃").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests, 4, "已在途请求可以完成，未发出的请求停止");
  assert.equal(page.errors[0][1], failure);
  assert.doesNotMatch(
    page.document.querySelector("#bangumi-friend-sorter-status").textContent,
    /正在获取/,
  );
  page.button("名称").click();
  assert.equal(page.list.children.length, 6);
});

test("三类远程任务缺少实际调用方法时都明确报错，不静默忽略", async (t) => {
  for (const label of ["上次活跃", "完成条目数", "和我贴贴"]) {
    const page = pageFor(t, friend("zed"));
    page.window.CHOBITS_USERNAME = "visitor";
    await initialize({
      ...page,
      http: {},
      setTimeout: () => 1,
      clearTimeout() {},
    });
    page.button(label).click();
    await waitForCondition(() => page.errors.length > 0);
    assert.match(
      page.document.querySelector('[role="alert"]').textContent,
      /远程/,
    );
  }
});

test("无效项清理至空列表时不挂载也不报错，原本空列表不产生清理摘要", async (t) => {
  const page = pageFor(t, friend("", "") + '<li class="user">缺少链接</li>');
  await initialize(page);
  assert.equal(page.list.children.length, 0);
  assert.equal(page.document.querySelector("#browserTools"), null);
  assert.equal(page.document.querySelector('[role="alert"]'), null);
  assert.equal(page.summaries.length, 1);

  const empty = pageFor(t, "");
  await initialize(empty);
  assert.equal(empty.summaries.length, 0);
  assert.equal(empty.document.querySelector("#browserTools"), null);
});

test("后续挂载失败不撤销已经完成的条目清理", async (t) => {
  const page = pageFor(
    t,
    friend("zed") + friend("") + friend("zed", "重复名称"),
  );
  const first = page.list.firstElementChild;
  page.document.querySelector(".mainWrapper").className = "unsupported";

  await assert.rejects(initialize(page), /排序栏挂载/);

  assert.deepEqual([...page.list.children], [first]);
  assert.equal(page.summaries.length, 1);
  assert.match(
    page.document.querySelector('[role="alert"]').textContent,
    /排序栏挂载/,
  );
});

test("缓存等待期间外部改变排列也不会错配好友与原节点", async (t) => {
  const page = pageFor(t, friend("zed", "Zed") + friend("amy", "Amy"));
  const [zed, amy] = page.list.children;
  const initializing = initialize(page);
  page.list.prepend(amy);
  await initializing;

  assert.deepEqual([...page.list.children], [zed, amy]);
  assert.equal(
    zed.querySelector(".bangumi-friend-sorter-rank").textContent,
    "#1",
  );
  page.button("名称").click();
  assert.deepEqual([...page.list.children], [amy, zed]);
});

test("隐藏视图不检查名次锚点，恢复呈现的观察回调才明确报告结构错误", async (t) => {
  const page = pageFor(t, friend("zed"));
  const anchor = page.list.querySelector("a.avatar");
  anchor.parentElement.replaceWith(anchor);
  page.list.style.display = "none";
  let replay;
  class Observer {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      if (target === page.list) replay = this.callback;
    }
  }
  await initialize({ ...page, mutationObserver: Observer });
  assert.ok(page.button("名称"));
  assert.equal(page.errors.length, 0);

  page.list.style.display = "";
  assert.throws(() => replay(), /名次.*缺少/);
  assert.match(
    page.document.querySelector('[role="alert"]').textContent,
    /名次/,
  );
  assert.equal(page.errors.length, 1);
});

test("失败的名次渲染不视为已完成，结构恢复后相同状态可重新呈现", (t) => {
  const page = pageFor(t, friend("zed", "Zed"));
  const anchor = page.list.querySelector("a.avatar");
  anchor.parentElement.replaceWith(anchor);
  const bar = createSortBar(page.document, { list: page.list });
  bar.bind({ selectCriterion() {}, selectDirection() {} });
  bar.mount();
  const state = {
    criterion: "added",
    direction: "asc",
    selection: "all",
    statusMessage: "",
    orderedFriends: [
      { userIdentifier: "zed", displayName: "Zed", originalIndex: 0 },
    ],
  };
  assert.throws(() => bar.render(state), /名次.*缺少/);
  const strong = page.document.createElement("strong");
  anchor.parentElement.append(strong);
  strong.append(anchor);

  bar.render(state);

  assert.equal(
    strong.querySelector(".bangumi-friend-sorter-rank")?.textContent,
    "#1",
  );
});

test("无有效用户标识的好友项局部删除，未知节点保留，其余原节点继续排序", async (t) => {
  const page = pageFor(
    t,
    friend("", "") +
      friend("zed", "Zed") +
      '<li class="user">缺少链接</li><li class="user"><a class="avatar" href="/subject/1">坏链接</a></li><li class="notice">公告</li>' +
      friend("amy", "Amy"),
  );
  const [, zed, , , notice, amy] = page.list.children;

  await initialize(page);

  assert.deepEqual([...page.list.children], [notice, zed, amy]);
  page.button("名称").click();
  assert.deepEqual([...page.list.children], [notice, amy, zed]);
  assert.equal(
    amy.querySelector(".bangumi-friend-sorter-rank").textContent,
    "#1",
  );
  assert.equal(page.document.querySelector('[role="alert"]'), null);
  assert.equal(page.summaries.length, 1);
});
