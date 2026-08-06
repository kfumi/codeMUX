# 04 — 让 sidecar 从外部 Runtime 动态加载 SDK

**What to build:** Claude、Codex 和 OpenCode 会话从 Rust 传入的显式 Provider Runtime 路径加载 SDK，不再依赖 sidecar 内置 SDK、用户全局 npm 目录或全局 CLI，同时保持现有会话行为。

**Blocked by:** 03 — 实现 Runtime Manager 安装与版本生命周期

**Status:** ready-for-agent

- [ ] Rust 启动 sidecar 时传入当前 Runtime 根目录和 Provider Runtime 路径。
- [ ] sidecar 启动前验证 Runtime 存在、完整且与 sidecar 兼容。
- [ ] Claude、Codex 和 OpenCode 均能从外部路径成功动态加载 SDK 并启动会话。
- [ ] Runtime 缺失、损坏、关键二进制缺失或版本不匹配时返回结构化 Provider 错误。
- [ ] Runtime 路径包含空格或非 ASCII 字符时可以正常启动和运行。
- [ ] Claude、Codex 和 OpenCode 的流式事件、权限请求、用户输入、中断和恢复行为保持现有语义。
- [ ] sidecar 不再从全局 npm 目录或安装包内旧 SDK fallback 加载实际运行时。