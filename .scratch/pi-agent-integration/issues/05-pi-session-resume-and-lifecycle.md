# 05 — pi 会话恢复与生命周期清理

**What to build:** pi 会话的连续性：新会话以 `--session-dir` 落入 CodeMUX 管理目录，启动后回读会话文件路径存为 Native Session mapping；重启应用后以 `--session <file>` 恢复原生上下文并还原模型/思考等级；恢复失败时 mint 新会话并 emit System Event（native_session_rebuilt 语义）；进程崩溃后可重试恢复；关闭会话/退出应用时子进程清理不泄漏。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] 新会话的 pi 会话文件落入管理目录，mapping 正确保存
- [ ] 重启后继续会话：历史气泡完整且模型可继续对话（--session 恢复）
- [ ] 恢复失败时新建原生会话并 emit System Event，对话气泡不丢
- [ ] 恢复时还原该会话的模型与思考等级
- [ ] 子进程崩溃后重试可继续会话
- [ ] 关闭会话/退出应用后无 pi 进程残留；fake-pi 测试覆盖恢复与退出路径
