# 维护源导航（#24 过渡阶段）

目前业务逻辑暂集中在 `src/legacy.mjs`，尚未按职责拆分；后续票需将此模块删除。修改排序、缓存、解析、HTTP、调度、刷新、会话或排序栏，先在该文件中按函数名定位相应代码；页面装配 `initialize` 也暂在该文件。`src/main.mjs` 仅负责浏览器自动启动。`src/metadata.txt` 是手写头部模板（仅版本有占位符）；`scripts/build.mjs` 生成并格式化旧地址的发布文件，`scripts/check.mjs` 提供只读交付检查。测试位于 `test/*.test.mjs`，替身位于 `test/support/`；产物浏览器验收在 `test/delivery.test.mjs`。

`src/index.user.js` 是生成产物，不是业务维护入口；仅在构建排障、审核或产物验收时定向检查。后续按职责拆分后更新本导航。
