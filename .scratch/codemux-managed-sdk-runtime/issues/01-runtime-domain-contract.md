# 01 — 建立 Runtime 领域契约与可测试边界

**What to build:** 建立统一的 CodeMUX Provider Runtime 契约，使 Rust、sidecar 和前端可以用一致的状态、版本、完整性、安装阶段和结构化错误描述运行时，并为后续安装流程提供可替换的 manifest、下载、签名和文件系统测试边界。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 定义 Claude、Codex、OpenCode 的 Provider、平台、架构、Runtime 版本和 sidecar 兼容性表达方式。
- [ ] 定义 `missing`、`installing`、`ready`、`outdated`、`corrupted`、`node_unavailable`、`error` 状态及其用户可读诊断信息。
- [ ] 定义 Node 18+ 检测结果、Runtime 完整性结果、安装阶段、进度和结构化错误契约。
- [ ] 定义同一 Provider 并发安装的互斥语义和可观察结果。
- [ ] 提供不依赖真实 GitHub、全局 CLI、真实用户目录和固定本地路径的测试夹具边界。
- [ ] 为 Rust、sidecar 和前端后续 tickets 提供通过测试的共享契约。