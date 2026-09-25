import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

test("单文件 userscript 元数据匹配三个站点的双好友页", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../src/index.user.js", import.meta.url)),
    "utf8",
  );
  const matches = [...source.matchAll(/^\/\/ @match\s+(\S+)$/gm)].map(
    ([, value]) => value,
  );

  assert.deepEqual(matches, [
    "https://bgm.tv/user/*/friends",
    "https://bgm.tv/user/*/rev_friends",
    "https://bangumi.tv/user/*/friends",
    "https://bangumi.tv/user/*/rev_friends",
    "https://chii.in/user/*/friends",
    "https://chii.in/user/*/rev_friends",
  ]);
  // @description 等声明性字段由人工管理，测试只确认其存在，不断言内容。
  assert.match(source, /^\/\/ @description\s+\S.*$/m);
  assert.match(source, /^\/\/ @run-at\s+document-end$/m);
  assert.match(source, /^\/\/ @grant\s+none$/m);
  const url =
    "https://raw.githubusercontent.com/imagebuilder1837/bangumi-friend-sorter/refs/heads/main/src/index.user.js";
  assert.ok(source.includes(`// @downloadURL  ${url}\n`));
  assert.ok(source.includes(`// @updateURL    ${url}\n`));
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
});
