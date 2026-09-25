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

test("the delivered file is the reproducible, self-contained metadata-bearing output", async () => {
  const code = await readFile(artifact, "utf8");
  assert.equal(code, await generate());
  assert.equal(await generate(), await generate());
  assert.match(code, /^\/\/ ==UserScript==\n/);
  assert.match(
    code,
    /\/\/ ==\/UserScript==\n\/\/ Generated from src\/main\.mjs/,
  );
  assert.match(code, /src\/legacy\.mjs/);
  assert.match(code, /The v3 store holds activity/);
  assert.doesNotMatch(
    code,
    /\bmodule\.exports\b|\brequire\s*\(|sourceMappingURL|^\s*(?:import|export)\s/m,
  );
});
