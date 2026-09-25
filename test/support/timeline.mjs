import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures");

// 用真实 HTML 解析（与浏览器 DOMParser 同一保真度）把 fixture 变成可查询
// 文档；生产解析代码直接跑在上面，而不是对着手写 fake 的固定选择器。
function documentFromFixture(filename) {
  const html = fs.readFileSync(path.join(FIXTURE_DIR, filename), "utf8");
  return new JSDOM(html, { url: "https://bgm.tv/" }).window.document;
}

function timelineDocumentFromFixture(filename) {
  return documentFromFixture(filename);
}

function tietieDocumentFromFixture(filename) {
  return documentFromFixture(filename);
}

export { timelineDocumentFromFixture, tietieDocumentFromFixture };
