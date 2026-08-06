# 05 — 分离 CodeMUX Runtime 检测与外部 CLI 诊断

**What to build:** CodeMUX 根据 Node、sidecar、Provider Runtime、完整性、关键二进制和兼容性返回统一 Runtime 状态；PATH 中的 `claude`、`codex`、`opencode` 仅作为独立的外部 CLI 诊断，不再决定 CodeMUX 会话是否可用。

**Blocked by:** 03 — 实现 Runtime Manager 安装与版本生命周期；04 — 让 sidecar 从外部 Runtime 动态加载 SDK

**Status:** ready-for-agent

- [ ] Runtime 检测报告 Node 版本、Node 可执行路径、sidecar 状态、Provider Runtime 版本、安装路径和完整性结果。
- [ ] Runtime 检测返回统一的 `missing`、`installing`、`ready`、`outdated`、`corrupted`、`node_unavailable` 和 `error` 状态。
- [ ] Runtime 缺失或损坏时能定位到可执行的安装、修复或升级操作。
- [ ] 提供安装、升级、修复、删除和重新检测的统一 Tauri 调用入口。
- [ ] 提供独立的外部 CLI 诊断，报告 PATH、版本、路径、多安装冲突和可运行性。
- [ ] 外部 CLI 未安装或版本冲突时，不改变 CodeMUX 自有 Runtime 的 `ready` 状态。
- [ ] 测试覆盖 Node 版本边界、Runtime 完整性、sidecar 兼容性和外部 CLI 缺失场景。