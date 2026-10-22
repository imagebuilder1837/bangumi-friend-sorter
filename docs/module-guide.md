# 维护源导航

`src/main.mjs` 是唯一自动启动的浏览器入口，`src/page/initialize.mjs` 验证页面并按原顺序装配好友、缓存、HTTP 适配器、排序栏和会话。修改行为先按下面的职责找到源文件，不要默认读取生成的 `src/index.user.js`。

| 要修改的行为 | 先读的维护源 |
| --- | --- |
| 排序标准、方向、平局、选择配置 | `src/sorting/order.mjs`、`src/sorting/choices.mjs`；远程目标的两击决策见 `src/sorting/remote-selection.mjs` |
| 好友与访客标识、页面好友读取 | `src/bangumi/identity.mjs`、`src/page/initialize.mjs` |
| 缓存验证、过期与领域读写 | `src/cache/friend-cache.mjs`；原生数据库事务、连接与一次性导入见 `src/cache/storage.mjs` |
| 上次活跃、分类时间胶囊及主页字段解析 | `src/bangumi/timeline-parser.mjs`、`src/bangumi/tietie-parser.mjs`、`src/bangumi/profile-parser.mjs` |
| 请求 URL、超时、凭据和响应时间 | `src/bangumi/http.mjs`；装配见 `src/page/initialize.mjs` |
| 并发、抢占、批次停止 | `src/workflow/scheduler.mjs` |
| 状态提示及刷新任务生命周期 | `src/workflow/status.mjs`、`src/workflow/refresh-lifecycle.mjs` |
| 页面故障提示与原始异常诊断 | `src/page/errors.mjs`；入口、排序栏和会话负责接入各自失败边界 |
| 主页字段与贴贴任务 | `src/workflow/profile-tasks.mjs`、`src/workflow/tietie-tasks.mjs` |
| 当前选择、排序记忆、刷新编排 | `src/workflow/session.mjs` |
| 排序栏 DOM、菜单、焦点、名次、隐藏好友观察与现有样式 | `src/page/sort-bar.mjs` |

测试按调用接口归入 `test/sorting/`、`test/cache/`、`test/bangumi/`、`test/workflow/` 与 `test/page/`；从页面初始化进入的跨模块流程在 `test/integration/`，浏览器产物及交付门禁在 `test/delivery/`。共用测试驱动与替身在 `test/support/`，HTML 样本在 `test/fixtures/`。`src/metadata.txt` 是人工管理的头部模板（仅版本占位），未经逐项批准不得修改元数据字段。`scripts/build.mjs` 生成并格式化旧地址的单文件；`scripts/check.mjs` 只读检查交付状态。仅在构建排障、审查或产物验收时定向阅读 `src/index.user.js`。
