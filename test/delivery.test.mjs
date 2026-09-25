import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { artifact, generate } from "../scripts/build.mjs";

const html = `<!doctype html><html><head></head><body>
<div class="mainWrapper"><div class="columns"><div id="columnUserSingle">
<ul id="memberUserList" class="usersMedium">
<li><div class="userContainer"><strong><a class="avatar" href="/user/zed">Zed</a></strong></div></li>
<li><div class="userContainer"><strong><a class="avatar" href="/user/amy">Amy</a></strong></div></li>
</ul></div></div></div></body></html>`;

test("published userscript starts itself in a browser and sorts friends", async () => {
  const code = await readFile(artifact, "utf8");
  const page = new JSDOM(html, {
    url: "https://bgm.tv/user/sai/friends",
    runScripts: "outside-only",
  });
  try {
    page.window.eval(code);
    const { document } = page.window;
    const bar = document.querySelector('#browserTools[aria-label="好友排序"]');
    assert.ok(bar, "automatic browser entry mounts the sort bar");
    const names = () =>
      [...document.querySelectorAll("#memberUserList li a.avatar")].map(
        (a) => a.textContent,
      );
    assert.deepEqual(names(), ["Zed", "Amy"]);
    const nameButton = [...bar.querySelectorAll("button")].find(
      (button) => button.textContent === "名称",
    );
    assert.ok(nameButton);
    nameButton.click();
    assert.deepEqual(names(), ["Amy", "Zed"]);
    assert.equal(page.window.module, undefined);
    assert.equal(page.window.initialize, undefined);
  } finally {
    page.window.close();
  }
});

test("published browser entry fetches, parses and caches remote values before sorting; controls and hidden ranks remain live", async () => {
  const [code, active, empty, profile] = await Promise.all([
    readFile(artifact, "utf8"),
    readFile(
      new URL("./fixtures/timeline-active-seconds.html", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("./fixtures/timeline-empty.html", import.meta.url),
      "utf8",
    ),
    readFile(new URL("./fixtures/profile-stats.html", import.meta.url), "utf8"),
  ]);
  const page = new JSDOM(html, {
    url: "https://bgm.tv/user/sai/friends",
    runScripts: "outside-only",
  });
  try {
    const requests = [];
    page.window.fetch = async (url, options) => {
      requests.push(url);
      assert.equal(options.credentials, "same-origin");
      return {
        ok: true,
        headers: { get: () => "Wed, 26 Aug 2026 09:43:36 GMT" },
        text: async () =>
          url.endsWith("/timeline")
            ? url.includes("/zed/")
              ? empty
              : active
            : profile,
      };
    };
    page.window.eval(code);
    const { document } = page.window;
    const bar = document.querySelector('#browserTools[aria-label="好友排序"]');
    const names = () =>
      [...document.querySelectorAll("#memberUserList li a.avatar")].map(
        (anchor) => anchor.textContent,
      );
    const button = (label) =>
      [...bar.querySelectorAll("button")].find(
        (node) => node.textContent === label,
      );
    button("上次活跃").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(names(), ["Amy", "Zed"]);
    assert.deepEqual(requests, ["/user/zed/timeline", "/user/amy/timeline"]);
    const stored = JSON.parse(
      page.window.localStorage.getItem(
        "bangumi-friend-sorter:activity-cache:v3",
      ),
    );
    assert.equal(stored.records.amy.activity.kind, "active");
    assert.equal(stored.records.zed.activity.kind, "empty");

    button("完成条目数").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 4);
    assert.equal(
      JSON.parse(
        page.window.localStorage.getItem(
          "bangumi-friend-sorter:activity-cache:v3",
        ),
      ).records.amy.completion_all.value,
      20,
    );
    button("名称").click();
    assert.deepEqual(names(), ["Amy", "Zed"]);
    button("降序").click();
    assert.deepEqual(names(), ["Zed", "Amy"]);
    const items = [...document.querySelectorAll("#memberUserList li")];
    items[0].style.display = "none";
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      items[1].querySelector(".bangumi-friend-sorter-rank")?.textContent,
      "#1",
    );
  } finally {
    page.window.close();
  }
});

test("the delivered file is the reproducible, self-contained metadata-bearing output", async () => {
  const code = await readFile(artifact, "utf8");
  assert.equal(code, await generate());
  assert.equal(await generate(), await generate());
  assert.match(code, /^\/\/ ==UserScript==\n/);
  assert.match(
    code,
    /\/\/ ==\/UserScript==\n\/\/ Generated from src\/main\.mjs/,
  );
  for (const source of [
    "cache",
    "sorting",
    "sort-bar",
    "session",
    "http",
    "tietie-tasks",
  ]) {
    assert.ok(
      code.includes(`src/${source}.mjs`),
      `${source} source is identifiable`,
    );
  }
  assert.match(code, /The v3 store holds activity/);
  assert.doesNotMatch(
    code,
    /\bmodule\.exports\b|\brequire\s*\(|sourceMappingURL|^\s*(?:import|export)\s/m,
  );
});
