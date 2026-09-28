# 02 — 托管 Runtime 安装 pi CLI

**What to build:** CodeMUX 托管 Runtime 安装锁定版本的 `@earendil-works/pi-coding-agent`（bin 为 `pi`），完整性检查包含 `pi` 可执行文件，缺失或损坏时给出可读诊断；设置页安装指引与托管 Runtime 实际安装的 npm 包名、命令一致。用户安装/升级 Runtime 后可验证 pi CLI 就绪，为后续 spawn RPC 子进程提供可执行文件（对齐 Codex CLI 托管化改造的既有做法）。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 托管 Runtime npm 安装目标为 `@earendil-works/pi-coding-agent@<版本>`；pi 为纯 Node 包（无平台二进制），关键完整性凭证取 bin 入口 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，运行时由 sidecar 以自身 node 进程启动（规避 .cmd shim 与 PATH 依赖）
- [x] Runtime 完整性检查覆盖 pi 入口文件，失败时给出可读诊断（缺失文件、版本不匹配等）
- [x] 设置页与安装指引中的 npm 包名、命令与托管 Runtime 行为一致
- [x] 相关 Rust Runtime 测试更新并通过

**勘误 2026-09-28：** 本 ticket 原写包名 `@mariozechner/pi-coding-agent`、入口 `dist/cli.js`，随 npm 包迁移已纠正为 `@earendil-works/pi-coding-agent` 与入口 `dist/bundle/cli.js`（旧包名停在 0.73.1 的根因、入口路径变化与迁移决定见 `docs/research/2026-09-28-pi-npm-package-migration.md`）。该契约现由 `crates/daemon/src/runtime/resolver.rs` 的测试 `pi_runtime_pack_contract_pins_package_and_entry_path` 钉住，改动即红灯。
