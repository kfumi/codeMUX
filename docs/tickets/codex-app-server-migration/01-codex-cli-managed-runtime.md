# 01 — 托管 Runtime 切换至 Codex CLI

**What to build:** CodeMUX 托管 Runtime 安装 `@openai/codex` CLI（替换 `@openai/codex-sdk`），完整性检查校验 `codex` / `codex.exe` binary，设置页安装指引与 Runtime 实际安装包一致。用户安装/升级 Runtime 后可验证 CLI 就绪，为后续 spawn app-server 提供可执行文件。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 托管 Runtime npm 安装目标改为 `@openai/codex@<version>`，`key_binaries` 包含 CLI 路径
- [x] Runtime 完整性失败时给出可读诊断（缺失 binary、版本不匹配等）
- [x] 设置页与 Agent 安装指引中的 npm 包名、命令与托管 Runtime 行为一致
- [x] 相关 Rust Runtime 测试更新并通过
- [x] spawn 时可将 Runtime `node_modules/.bin` 前置到 PATH（为 03 预留，本 ticket 至少验证 binary 可解析）
