# 07 — Scheduled Task 与 Runtime 诊断走协议

**What to build:** 创建、暂停、立即跑 Scheduled Task，以及查看托管 Runtime 安装状态与诊断，都走 Daemon。主窗口藏到托盘时，到点的 Task Run 仍创建 Session 并发出 Task Instruction。Sidecar / SDK 运行时继续由 Daemon 拉起，不由壳 spawn。

**Blocked by:** 03 — 桌面只读走协议

**Status:** ready-for-agent

- [ ] Scheduled Task 的 CRUD、暂停/恢复、立即跑、Task Run 列表经 Companion，领域模型（Task Instruction、Schedule、Run Delivery）不变。
- [ ] 关闭移动伴侣或隐藏主窗口不停止调度；到点仍会发 Task Instruction。
- [ ] 托管 Runtime 状态与诊断查询经 Daemon 门面；安装/修复动作若本票纳入，同样走 Daemon 而非壳进程直接 spawn sidecar。
- [ ] 切走后设置页与任务 UI 不得再 invoke 对应本机命令。
- [ ] 测试：假客户端覆盖任务列表与立即跑；调度不依赖窗口可见性（至少用「无窗口 tick」或同等夹具证明 Task Run 仍发生）。
