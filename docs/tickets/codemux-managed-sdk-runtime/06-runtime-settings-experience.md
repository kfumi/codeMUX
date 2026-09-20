# 06 — 更新运行时设置页与下载交互

**What to build:** 设置页改为“CodeMUX 运行时环境”，用户可以按 Provider 安装、更新、修复、删除和重新检测，并能看到版本、路径、Node 状态、完整性、下载阶段、进度和失败重试。

**Blocked by:** 03 — 实现 Runtime Manager 安装与版本生命周期；05 — 分离 CodeMUX Runtime 检测与外部 CLI 诊断

**Status:** ready-for-agent

- [ ] 每个 Provider 卡片展示 Runtime 状态、当前版本、可用版本、Node 状态、安装路径和完整性结果。
- [ ] `missing` 显示安装操作，`outdated` 显示更新操作，`corrupted` 显示修复操作。
- [ ] `installing` 显示当前下载或校验阶段、进度和进行中状态。
- [ ] 安装、更新、修复、删除完成后自动刷新对应 Runtime 和整体检测结果。
- [ ] 下载、校验或切换失败时显示明确错误和重试入口。
- [ ] `node_unavailable` 显示 Node 18+ 安装要求和明确的恢复提示。
- [ ] 外部 CLI 诊断单独展示为“外部 CLI 环境”，不与 SDK Runtime 状态混淆。
- [ ] 前端测试覆盖各状态按钮、进度、刷新、错误、重试和外部 CLI 缺失不影响 Runtime 的行为。