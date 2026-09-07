# 10 — 移动伴侣开关与托盘生命周期

**What to build:** 「移动伴侣」只控制局域网/中继暴露，不杀回环 Daemon。点窗口关闭则藏到托盘，正在跑的 Session 与 Scheduled Task 不中断；托盘「打开」接上已有 Daemon；托盘「退出」才停 Daemon、Sidecar 与回环。二次启动只激活已有窗口。Daemon 崩溃时窗口可重试，Composer 草稿不丢。本票仍允许 Daemon 与壳同进程。

**Blocked by:** 02 — 回环 Daemon 与 Local Daemon Token；04 — 桌面对话写路径走协议

**Status:** ready-for-agent

- [ ] `companion.enabled=false` 停配对码、局域网与中继，不停回环、不停 Sidecar、不停 Scheduled Task；文案不暗示本机权威已关闭。
- [ ] 关闭主窗口隐藏到托盘后，进行中的一轮与托盘外的发送/审批（若 UI 不可用则至少 Daemon 侧 turn 不因隐藏而中断）仍成立。
- [ ] 托盘「打开」恢复窗口并复用已有 Daemon Client 连接，不必重放「启动全部会话」。
- [ ] 托盘「退出」停止 sidecar、Companion Server（含回环）再退出壳。
- [ ] 已在托盘运行时再次启动只激活已有窗口，不拉起第二份回环监听、不抢 SQLite。
- [ ] Daemon 崩溃或回环断开：窗口提示并可重试；Composer 未发送草稿仍在。
- [ ] 内置浏览在关移动伴侣、藏窗口再打开后仍按 Browser Host 停放/恢复，不被本票误毁。
- [ ] 不把 Daemon 拆成独立系统服务。
