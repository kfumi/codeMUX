# 01 — 能力分类与 Daemon / Shell 双门面（expand）

**What to build:** 桌面调用分成两扇门：Session、智能体、配置等业务走 Daemon 门面；窗口、托盘、更新、原生对话框、Browser Host 走 Shell 门面。此票不改变用户可见行为——Daemon 门面仍转发到现有本机命令——只让后面的迁移有明确入口，并禁止壳门面出现发消息这类权威操作。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 有一份「能力 → daemon | shell」清单，覆盖 spec 领域切分表（Session/Timeline/发消息 vs Browser Host/对话框/窗口等）。
- [ ] 桌面 UI 的业务 store/hooks 改为只通过 Daemon 门面取数与发指令；组件不直接打本机业务命令。
- [ ] Shell 门面只导出 Browser Host、文件/目录选择、窗口/托盘/updater、系统字体等壳能力。
- [ ] 本票范围内 Daemon 门面每个方法仍转到既有本机实现，会话列表、发送、内置浏览行为与改前一致。
- [ ] 门面边界测试：壳门面不得暴露发送 User Message / 中断 / 审批；清单上标为 daemon 的能力必须出现在 Daemon 门面上（可仍为转发）。
- [ ] 未迁移能力若被调用，不得悄悄走第二条路径；本票允许继续转发，但调用点只剩门面一处。
