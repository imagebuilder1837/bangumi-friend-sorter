# 脚本元数据治理

脚本元数据指人工维护的 `src/metadata.txt` 模板及生成产物 `src/index.user.js` 顶部 `==UserScript==` 头部块中的全部字段（`@name`、`@namespace`、`@version`、`@description`、`@author`、`@match`、`@run-at`、`@grant`、`@license`、`@downloadURL`、`@updateURL` 等）。

## 人工管理

- 元数据模板由人工管理，构建只从 package 版本填充 `@version`。agent 不得未经批准修改、添加或删除其他头部字段，包括看似无害的措辞润色。#23/#24 已专项批准模板迁移及版本生成机制，不授权其他字段变更。
- agent 发现需要改动元数据时，应在 issue 或对话中逐项提出提案，写明字段、现值、新值和理由，然后等待人工批准。
- 报批须逐项明确：人工对某一字段的批准不延伸到其他字段；批准"加一个 `@match`"不等于批准"改 `@run-at`"。
- 获得明确批准后，agent 才可执行修改并提交；提交信息或 PR 描述中应逐项列出本次元数据变更。
- 提交前，agent 须检查 `==UserScript==` 头部块相对基线（如 `origin/main`）的 diff；存在任何未获批的元数据变更时不得提交。

## 版本号

- `package.json` 的 `version` 是唯一权威版本，人工决定是否 bump；agent 交付行为变更时提醒人工，但不代为升级。使用 `npm version <显式版本> --no-git-tag-version` 同步 package 和锁文件，再运行 `npm run build` 生成 `@version`；不自动提交、tag 或发布。发现不一致时先让人工确认修复方案。

## 测试与元数据

- 测试可以锁定 `@match`、`@grant` 等行为性字段，作为生效范围与权限契约。
- 测试不得锁定 `@description` 等纯声明性字段的内容；版本一致性仅比较 package、锁文件和生成产物的版本关系，不锁定某个版本值。
