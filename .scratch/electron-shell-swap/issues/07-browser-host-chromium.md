# 07 — Browser Host Chromium 重写

**What to build:** 内置浏览在 Electron 下等价重建:沙箱 webview + 独立 session partition 实现标签、地址、刷新、元素检查注入、浏览器资料清除、切走标签停放不销毁、devtools;guest 页面无任何应用 IPC 能力;原为壳子视图做的手工遮挡逻辑退役或大幅简化;Browser Host 契约在 Electron 宿主全覆盖并由能力清单测试断言。换引擎不换用法。

**Blocked by:** 05 — Electron 壳骨架(日常路径跑通)

**Status:** ready-for-agent

- [ ] 标签/地址/刷新/元素检查/清资料/停放与 Tauri 版行为等价(手动验收)。
- [ ] guest 页面运行于独立 session partition,attach 前校验,无应用 IPC 能力。
- [ ] 关闭「移动伴侣」后内置浏览仍可用(浏览器属壳,不属局域网开关)。
- [ ] Electron 宿主对 Browser Host 契约全覆盖,能力清单测试断言。
- [ ] 手工遮挡逻辑退役;devtools 可用。
