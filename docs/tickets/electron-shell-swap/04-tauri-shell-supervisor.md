# 04 — Tauri 壳 supervisor 化

**What to build:** 桌面应用默认全流程跑在独立 daemon 上:壳内 supervisor 模块实现 start/attach/status/stop/restart 契约——run-state 存在且版本匹配且健康检查通过则 attach;版本不匹配停旧起新;否则 spawn(debug 构建由 dev 流程产出)。daemon 崩溃时窗口明确提示并可重试;托盘退出只停自己管理的 daemon;单实例语义不变。dev 循环照常,并支持手工先起 daemon、壳 attach 的外部模式。

**Blocked by:** 03 — daemon 独立二进制 + run-state 契约(含 stub daemon)

**Status:** ready-for-agent

- [ ] 应用启动即得可用会话列表,启动体验与今天无感;二次启动只激活已有窗口。
- [x] attach 决策表(无 run-state / 版本匹配 / 版本不匹配 / 健康检查失败)行为正确,由 stub daemon 驱动的 supervisor 契约测试覆盖。
- [ ] 杀掉 daemon 进程:窗口出现明确错误与重试入口,重试后恢复;Composer 草稿不丢。
- [ ] 托盘退出停 managed daemon 与 sidecar;attach 的外部 daemon 在壳退出后存活。
- [ ] dev 全流程照常可用;手工先起 daemon 再开壳走 attach。
- [ ] 阶段验收:桌面与手机行为与迁移前等价(全量测试门)。
