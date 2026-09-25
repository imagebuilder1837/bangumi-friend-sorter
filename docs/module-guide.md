# 维护源导航

`src/main.mjs` 是唯一自动启动的浏览器入口，`src/entry.mjs` 验证页面并按原顺序装配好友、缓存、HTTP 适配器、排序栏和会话。修改行为先按下面的职责找到源文件，不要默认读取生成的 `src/index.user.js`。

| 要修改的行为 | 先读的维护源 |
| --- | --- |
| 排序标准、方向、平局、选择配置 | `src/sorting.mjs`、`src/choices.mjs`；远程目标的两击决策见 `src/remote-selection.mjs` |
| 好友与访客标识、页面好友读取 | `src/identity.mjs`、`src/entry.mjs` |
| 缓存验证、过期、迁移与持久化 | `src/cache.mjs` |
| 上次活跃、分类时间胶囊及主页字段解析 | `src/timeline-parser.mjs`、`src/tietie-parser.mjs`、`src/profile-parser.mjs` |
| 请求 URL、超时、凭据和响应时间 | `src/http.mjs`；装配见 `src/entry.mjs` |
| 并发、抢占、批次停止 | `src/scheduler.mjs` |
| 状态提示及刷新任务生命周期 | `src/status.mjs`、`src/refresh.mjs` |
| 主页字段与贴贴任务 | `src/profile-tasks.mjs`、`src/tietie-tasks.mjs` |
| 当前选择、排序记忆、刷新编排 | `src/session.mjs` |
| 排序栏 DOM、菜单、焦点、名次、隐藏好友观察与现有样式 | `src/sort-bar.mjs` |

测试按公开接口直接导入对应职责模块，浏览器产物级回归在 `test/delivery.test.mjs`；共用替身在 `test/support/`。`src/metadata.txt` 是人工管理的头部模板（仅版本占位），未经逐项批准不得修改元数据字段。`scripts/build.mjs` 生成并格式化旧地址的单文件；`scripts/check.mjs` 只读检查交付状态。仅在构建排障、审查或产物验收时定向阅读 `src/index.user.js`。
