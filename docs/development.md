# 开发与交付

使用 Node.js 18+（Rollup 4.60.0 声明支持 Node >=18，Prettier 3.6.2 声明支持 Node >=14；依赖版本由锁文件固定）。运行 `npm ci` 安装开发依赖。编辑 `.mjs` 维护源后运行 `npm run build`，在原安装地址生成并格式化可读的单文件。`npm run format` 修正维护源格式，`npm run format:check` 只读检查维护源与产物格式；生成产物仅由 build 修正。

提交前在最终改动状态运行 `npm run check`，只读验证格式、语法、版本、产物一致性与测试；失败后修复并重跑。开发环境已验证 Node.js 26.10.0、Rollup 4.60.0、Prettier 3.6.2；Node 18 是所选工具声明的兼容下限，非本机实测版本。

由人工决定版本变更，运行 `npm version <显式版本> --no-git-tag-version` 同步 package 和锁文件，然后运行 `npm run build`。构建与校验不自动发布、提交或打 tag。
