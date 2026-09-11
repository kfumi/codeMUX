# 06 — Electron 通知/对话框/更新器对齐

**What to build:** Electron 版补齐壳能力并准备发布面:应用内检查更新、下载、退出时安装(electron-updater + GitHub Releases);Windows 通知带正确应用身份(NSIS 快捷方式 + AppUserModelID)且点击回跳;文件/目录对话框、在资源管理器中显示、外部编辑器打开与 Tauri 版等价;electron-builder 打包配置初稿(安装包内嵌 daemon 二进制与资源根布局)。

**Blocked by:** 05 — Electron 壳骨架(日常路径跑通)

**Status:** ready-for-agent

- [ ] 应用内可检查更新并完成一次更新安装(手动验收,不进 CI)。
- [ ] 通知在 Windows 上归组正确、点击回跳应用。
- [ ] 对话框/资源管理器/外部编辑器与 Tauri 版行为等价。
- [ ] electron-builder 可产出可安装包,内嵌 daemon 二进制与资源根。
- [ ] 双壳一致性测试维持绿;发布指南更新草稿就绪。
