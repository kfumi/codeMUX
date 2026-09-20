# 02 — Daemon 核心状态组装脱 AppHandle

**What to build:** 完成 expand–contract 的 contract 侧:companion actions/events、agent、skills、scheduled tasks 等业务调用面不再经 Tauri 应用状态注入取态,统一改为显式状态结构;出现一个不含任何 Tauri 类型的 daemon 核心组装入口,可在无窗口环境下构建并跑通 Companion HTTP 测试。壳仍同进程运行、行为不变;Tauri 专属旧注入路径删除。这是全计划风险最大的一次性工程,机械但面广。

**Blocked by:** 01 — Daemon 基础接缝脱 Tauri

**Status:** ready-for-agent

- [x] 业务调用面不再经 Tauri 应用状态取态;显式状态结构被 companion、agent 等共享。
- [x] 存在无 Tauri 类型的 daemon 核心组装入口,可在无窗口环境构建并启动回环服务。
- [x] 既有 Companion 鉴权与业务 HTTP 测试原样绿(改为打核心组装入口,无窗口运行)。
- [x] 桌面应用行为无可观察变化;旧注入路径已删除。
