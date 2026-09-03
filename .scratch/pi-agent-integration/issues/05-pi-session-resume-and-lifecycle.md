# 05 — pi 会话恢复与生命周期清理

**What to build:** pi 会话的连续性：新会话沿用 pi 默认会话目录（`~/.pi/agent/sessions`，与用户手动使用 pi CLI 的会话互通），启动后经 `get_state` 回读会话文件路径存为 Native Session mapping；重启应用后以 `--session <file>` 恢复原生上下文并还原模型/思考等级；硬恢复失败走既有 `session_resume_failed` 事件路径；pi 子进程崩溃后下一轮 ensure 自动重新拉起并以上次会话文件 resume；关闭会话/退出应用时子进程清理不泄漏。

**Blocked by:** 03

**Status:** ready-for-agent

- [x] 新会话的 pi 会话文件路径经 get_state 回读并正确存为 mapping（fake-pi 测试覆盖）
- [x] 重启后继续会话：以 `--session <file>` 恢复，模型/思考等级经启动参数还原
- [x] 硬恢复失败走既有 `session_resume_failed` 事件路径，CodeMUX 时间线气泡不丢
- [x] 恢复时还原该会话的模型与思考等级（canReuse 比对含 provider/model/thinkingLevel）
- [x] 子进程崩溃后重试可继续会话（ensure 重入 + 最新会话文件 resume，fake-pi 测试覆盖）
- [x] 关闭会话/退出应用后无 pi 进程残留（优雅关闭阶梯测试覆盖）
