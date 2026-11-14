# 08 — 收口：全量门禁与真实渲染验收

**What to build:** 跑完全部自动化门禁，按 spec 验收矩阵做 dev:desktop 真实渲染人工核对，浏览器宿主重建核对，文档状态收口。

**Blocked by:** 04–07

**Status:** in-progress（自动化门禁通过；dev:desktop 手工验收矩阵未执行）

- [x] 根目录 `npx vitest run` 全绿；`npm run build`（tsc ＋ vite）通过；`npm run build:web` 通过并在浏览器宿主核对。
- [x] 本特性不涉及 Rust daemon / Sidecar 则无需 `build:daemon`；实施中若触及则按仓库规则补跑对应构建。
- [ ] dev:desktop 人工验收矩阵逐项打勾：四个 Agent Kind 的历史与实时；单步骤不成组；同消息两步成组；正文 / 问询 / 委派边界；最近活动项摘要；完成分类统计；手动状态跨场景保持；精简两级折叠；失败只在工具条目；子智能体一致；暗色主题 / 字号 / 圆角 / 窄屏不破版；长会话滚动锚定与回到底部。
- [ ] 浏览器宿主（daemon 服务的 dist-web 页面）核对主对话分组行为一致。
- [x] spec Status 行与 `docs/README.md` 索引按最终交付状态收口。
- [x] 01–07 全部验收项复核并勾选，未完成项不得静默跳过。
