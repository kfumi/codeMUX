# 04 — 桌面对话写路径走协议

**What to build:** 日常对话从桌面打到现有 Companion 写路由：新建 Session、发 User Message、Queued Message / Immediate Run、中断、应答 Interactive Request，以及改 Kind Model Selection、Permission Snapshot、Plan Mode。切走后禁止再 invoke 同一条路径。桌面与手机抢同一队列、同一轮，不会出现两次 Turn Outcome。

**Blocked by:** 03 — 桌面只读走协议

**Status:** ready-for-agent

- [ ] 新建 Session、发送、中断、权限审批、问题作答、会话设置补丁对齐现有 Companion 处理，不复制第二套 agent 命令。
- [ ] Composer、Queued Message、Immediate Run 的用户可见行为与改前一致，落地改为 Daemon 转发。
- [ ] 上述能力从 Daemon 门面切到 HTTP/WS 后，桌面 UI 不得再调用对应本机命令（禁止双写；缺能力则入口报错或隐藏，不得静默回退 invoke）。
- [ ] 同一 Session 上桌面与手机同时发送时进入同一队列与同一 turn 规则。
- [ ] 改 Kind Model Selection / Permission Snapshot / Plan Mode 后，下一轮按新快照驾驶。
- [ ] 假 Daemon Client 断言发送/中断/审批变成客户端方法；已配对手机的发送与审批不回退。
- [ ] 日志仍带 Session 与可选 Message UUID 的 Log Context。
