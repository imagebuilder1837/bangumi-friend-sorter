# 脚本元数据治理

脚本元数据指 `src/index.user.js` 顶部 `==UserScript==` 头部块中的全部字段（`@name`、`@namespace`、`@version`、`@description`、`@author`、`@match`、`@run-at`、`@grant`、`@license`、`@downloadURL`、`@updateURL` 等）。

## 人工管理

- 脚本元数据由人工管理。agent 不得未经批准修改、添加或删除任何头部字段，包括看似无害的措辞润色。
- agent 发现需要改动元数据时，应在 issue 或对话中逐项提出提案，写明字段、现值、新值和理由，然后等待人工批准。
- 报批须逐项明确：人工对某一字段的批准不延伸到其他字段；批准"加一个 `@match`"不等于批准"改 `@run-at`"。
- 获得明确批准后，agent 才可执行修改并提交；提交信息或 PR 描述中应逐项列出本次元数据变更。
- 提交前，agent 须检查 `==UserScript==` 头部块相对基线（如 `origin/main`）的 diff；存在任何未获批的元数据变更时不得提交。

## 版本号

- `@version` 由人工 bump。agent 在交付涉及脚本行为变更的成果时，有义务提醒人工 bump `@version`，但不代为修改。
- `package.json` 的 `version` 不具权威性，以脚本头为准。agent 发现两者不一致时，先向人工确认，获批后再同步。

## 测试与元数据

- 测试可以锁定 `@match`、`@grant` 等行为性字段，作为生效范围与权限契约。
- 测试不得断言 `@description`、`@version` 等纯声明性字段的内容，否则人工修改元数据会破坏测试，反而诱使 agent 为让测试通过而改动元数据。
