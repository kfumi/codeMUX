# 09 — 发布面切换 + Tauri 下线 + ADR

**What to build:** 仓库只留一套壳:移除 Tauri 壳(窗口、托盘、updater、commands、capabilities 及 Windows 专属手写通知与开始菜单修复脚本),能力清单最终态只接受 Electron 壳后端;electron-builder/electron-updater 发布配置定稿,发布指南更新;验证旧壳用户一次性安装迁移(数据目录共享,零搬家);新 ADR 记录 daemon 独立进程、supervisor 语义与 Electron 壳选择,并修订 ADR 0011 的过渡表述;全量测试门通过。

**Blocked by:** 04 — Tauri 壳 supervisor 化;06 — Electron 通知/对话框/更新器对齐;07 — Browser Host Chromium 重写;08 — 浏览器自动化接缝

**Status:** ready-for-agent

- [x] Tauri 壳及其 commands/capabilities 从仓库移除;Rust 构建只剩库与 daemon bin。
- [x] 能力清单最终态:出现 invoke 壳后端即测试红。
- [x] 发布配置与指南定稿;安装包签名链覆盖 Electron 应用与 daemon 二进制。
- [ ] 手动验收:从旧壳版本机器一次性安装,会话/配置/配对全保留。
- [x] ADR 落地:新 ADR + 修订 ADR 0011。
- [x] 全量门通过:根与 sidecar 的 Vitest 全量、Rust fmt/clippy/check。
