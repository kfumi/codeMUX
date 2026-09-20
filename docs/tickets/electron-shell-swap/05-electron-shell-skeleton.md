# 05 — Electron 壳骨架(日常路径跑通)

**What to build:** Electron 版桌面应用跑通日常会话路径:main 进程实现同一 supervisor 契约(TS 实现,复用 03 的 stub daemon 驱动决策表测试)与壳门面后端(preload 桥:token 读取、对话框、打开资源管理器、通知基础面);窗口、托盘(关闭到托盘/打开/退出)、单实例锁;渲染层经自定义 scheme 加载打包 dist;userData 显式指向现有应用数据目录实现零迁移。前端应用代码零改动,仅壳门面后端换实现。与 04 并行推进。

**Blocked by:** 03 — daemon 独立二进制 + run-state 契约(含 stub daemon)

**Status:** ready-for-agent

- [ ] Electron 版启动流程:spawn/attach daemon → Local Daemon Token 健康检查 → 会话列表、时间线、发送、审批可用。
- [ ] 关闭到托盘、托盘打开/退出、二次启动激活已有窗口,行为与 Tauri 版一致。
- [ ] supervisor 契约测试(决策表、崩溃重试、只停 managed)在 TS 实现上绿。
- [ ] 壳门面双实现(Tauri invoke 与 Electron preload)一致性测试绿;能力清单边界测试继续守护 daemon/shell 归属。
- [ ] 渲染层经自定义 scheme 加载,无本地文件协议限制问题。
- [ ] 会话、配置、配对数据与旧壳共享(零搬家)。
