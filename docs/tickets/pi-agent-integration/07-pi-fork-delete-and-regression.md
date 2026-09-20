# 07 — pi Fork、Delete 与收尾回归

**What to build:** pi 会话收尾：Fork 当前会话生成同种类独立副本（sidecar 整卷拷贝 pi 会话文件 + 新 Native Session mapping + 新 CodeMUX 会话，`fork_pi_session` 命令对齐既有三种 fork）；删除会话时清理对应 pi 会话文件（sidecar delete + native 清理路径双保险，仅限绝对路径 .jsonl）；移动端 Companion 查看/继续 pi 会话回归验证；结构化日志覆盖 pi 关键生命周期与协议错误（ADR 0002，`[pi-task]` 前缀）。全量测试套件作为合入 gate。

**Blocked by:** 05、06

**Status:** ready-for-agent

- [x] Fork pi 会话生成独立副本（会话文件拷贝 + fork_pi_session + 前端分发），原会话不受影响
- [x] 删除 pi 会话时对应会话文件一并清理（sidecar deleteSession + native 清理路径）
- [x] 移动端查看/继续 pi 会话时间线不破坏（Companion 通道为通用时间线，provider 校验测试覆盖 pi）
- [x] pi 生命周期与协议错误进入结构化日志（`[pi-task]` writeLog + setLogCtx）
- [x] 全量套件通过：根 + sidecar vitest（存量失败经 master 基线核对为零新增）、mobile 无改动、`cargo fmt --check`、`cargo check`；clippy 存量报错均在未触碰文件
