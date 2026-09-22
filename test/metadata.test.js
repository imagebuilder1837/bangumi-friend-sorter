const test = require("node:test");
const assert = require("node:assert/strict");
const sorter = require("../src/index.user.js");
const fs = require("node:fs");
const path = require("node:path");


test("单文件 userscript 元数据匹配三个站点的双好友页", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "index.user.js"),
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
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
});
