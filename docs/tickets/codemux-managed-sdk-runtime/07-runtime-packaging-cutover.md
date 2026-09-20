# 07 — 移除安装包内 SDK 并完成 Runtime 发布验收

**What to build:** CodeMUX 安装包不再包含 Claude、Codex、OpenCode SDK 或相关二进制，sidecar 只保留核心代码；正式发布后的全新用户可以仅安装 Node，再从设置页获得并使用所需 Runtime。

**Blocked by:** 02 — 构建并发布可验证的 Runtime Pack；04 — 让 sidecar 从外部 Runtime 动态加载 SDK；05 — 分离 CodeMUX Runtime 检测与外部 CLI 诊断；06 — 更新运行时设置页与下载交互

**Status:** ready-for-agent

- [ ] 安装包资源不再包含三个 SDK、平台相关 SDK 二进制或完整 sidecar `node_modules`。
- [ ] sidecar 构建产物在没有安装包内 SDK 的情况下仍可启动并加载外部 Runtime。
- [ ] 全新 Windows x64 环境仅安装 Node 18+ 后，可以从设置页安装并使用任意一个 Provider。
- [ ] 只安装一个 Provider 时，其他 Provider 保持 `missing` 且不影响已安装 Provider。
- [ ] 会话运行期间更新另一个 Provider 不会覆盖当前会话使用的 Runtime 文件。
- [ ] CodeMUX 主程序更新不再触发 SDK 文件占用或 `Error opening file for writing`。
- [ ] 删除 Runtime 后可以重新下载并恢复会话能力。
- [ ] 断网、重启和下载中断后可以重试或继续，而不会留下不可识别的半安装状态。
- [ ] 完成 Windows x64 手工验收，并确认不保留旧 SDK fallback 或旧 Runtime 兼容路径。