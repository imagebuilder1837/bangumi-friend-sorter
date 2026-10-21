# 开发与交付

## 构建与发布

- 使用 Node.js 运行构建与校验；开发依赖版本由锁文件固定。运行 `npm ci` 安装开发依赖。
- 提交给 Bangumi 运营者审核的最终发布物必须是零运行时依赖、自包含且可直接阅读的单文件 userscript；审核者不需要拼装多个文件或执行构建步骤，也不应收到经过混淆或压缩的输出。以 `src/main.mjs` 为浏览器入口，职责模块见 [`docs/module-guide.md`](module-guide.md)；构建生成原地址 `src/index.user.js` 并入库。
- 使用 Rollup 保留注释、不压缩地生成 IIFE，并由 Prettier 格式化，以保持审核可读性。编辑 `.mjs` 维护源后运行 `npm run build`，在原安装地址生成并格式化可读的单文件。
- 生成产物仅由 build 修正。`npm run format` 修正维护源格式，`npm run format:check` 只读检查维护源与产物格式。

## 验证

- 提交前在最终改动状态运行 `npm run check`，只读验证格式、语法、版本、产物一致性与测试；失败后修复并重跑。
- 测试运行器使用 Node 内置测试；DOM 环境使用 JSDOM，数据库行为使用 `fake-indexeddb`，均只作开发依赖。缓存测试通过领域读写及重新打开缓存验证，不绑定数据库表结构；原生浏览器冒烟使用隔离上下文，避免触碰已有缓存。

## 版本号

- 项目检查流程已在当前开发环境验证；未单独界定跨 Node.js 版本的兼容范围。
- 由人工决定版本变更，运行 `npm version <显式版本>` 同步 package 和锁文件，然后运行 `npm run build`。构建与校验不自动发布、提交或打 tag。
