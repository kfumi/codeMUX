# 07 — pi Fork、Delete 与收尾回归

**What to build:** pi 会话收尾：Fork 当前会话生成同种类独立副本（pi 会话文件拷贝 + 新 Native Session mapping + 新 CodeMUX 会话）；删除会话时清理对应 pi 会话文件；移动端 Companion 查看/继续 pi 会话回归验证；结构化日志覆盖 pi 关键生命周期与协议错误（ADR 0002）。全量测试套件作为合入 gate。

**Blocked by:** 05、06

**Status:** ready-for-agent

- [ ] Fork pi 会话生成独立副本，原会话不受影响，副本可继续对话
- [ ] 删除 pi 会话时对应会话文件一并清理
- [ ] 移动端查看/继续 pi 会话时间线不破坏
- [ ] pi 生命周期与协议错误进入结构化日志，可按现有日志排查路径定位
- [ ] 全量套件通过：根 + sidecar vitest、mobile vitest、`cargo fmt --check`、`cargo clippy -D warnings`、`cargo check`
