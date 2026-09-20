# 01 — Daemon 基础接缝脱 Tauri

**What to build:** 把权威侧对外部环境的依赖改为显式注入:应用数据目录与资源根(sidecar 构建产物、移动端静态资源)的解析不再经过 Tauri 路径 API;sidecar 事件从 Tauri IPC 通道改为进程内通道抽象。桌面应用行为零变化(仍同进程运行),但 daemon 侧受影响模块可以在无 Tauri 类型的情况下构造与单测。这是「先让改动变容易」的 prefactor,expand–contract 的 expand 侧:新旧两条路并存,旧路径仍被壳使用。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 应用数据目录与资源根由注入的路径根解析,不再依赖 Tauri 路径 API。
- [x] sidecar 事件传递改为进程内通道抽象;事件仍单点持久化并扇出到 WS,无可观察变化。
- [x] daemon 侧受影响模块在测试中不构造 Tauri 应用即可实例化。
- [x] 受影响模块的既有测试绿;桌面行为无可观察变化。
