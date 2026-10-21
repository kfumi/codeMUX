# 03 — macOS / Linux 应用级角标

**What to build:** 让同一份未读计数在 macOS 与 Linux 上也显示出来：macOS 走 Dock 角标，Linux 走启动器角标（Unity / KDE 的 LauncherEntry），Linux 同时保留 02 的托盘红点作为兜底 —— 原生 GNOME 没有角标 API，托盘是唯一可见的提示。

平台分叉只发生在壳侧角标模块的最后一公里，计数口径与同步通道完全复用 01。这一票只做平台分叉与单元测试；macOS 与 Linux 的实机效果标注为未实测。

**Blocked by:** 01 — Windows 任务栏红点（最小闭环）

**Status:** done

- [x] 壳侧按平台分叉：Windows 走 overlay，macOS / Linux 走应用级角标，其余平台 no-op
- [x] macOS 不合成托盘红点（托盘角标只在 Windows / Linux 生效），由 Dock 角标承担
- [x] Linux 同时保留托盘红点（依赖 02）
- [x] 单元测试覆盖：平台分叉选对了调用、未知平台不做任何调用、应用级角标在计数归零时被清零
- [ ] 手工验收（macOS / Linux）：制造未读 → Dock / 启动器出现角标；打开会话 → 消失 —— 若无法实机验证，在 PR 描述里明确标注未实测
