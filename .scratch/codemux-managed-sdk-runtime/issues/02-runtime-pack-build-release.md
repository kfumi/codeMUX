# 02 — 构建并发布可验证的 Runtime Pack

**What to build:** 发布流程可以生成 Claude、Codex 和 OpenCode 的 Windows x64 Runtime Pack，并通过项目 GitHub Release 提供带有完整元数据和签名的可验证资产。

**Blocked by:** 01 — 建立 Runtime 领域契约与可测试边界

**Status:** ready-for-agent

- [ ] 分别生成 Claude、Codex 和 OpenCode Runtime Pack。
- [ ] 每个 Pack 仅包含对应 SDK、平台相关二进制、传递依赖和最小 manifest。
- [ ] manifest 描述 Provider、Runtime 版本、平台、架构、sidecar 兼容版本、关键文件、文件大小和 SHA-256。
- [ ] Runtime Pack 资产使用现有 GitHub Release 发布流程和签名体系。
- [ ] 客户端可以验证 manifest 签名和 Pack 资产的 SHA-256。
- [ ] 构建测试能发现 Provider 内容串包、元数据不一致和关键文件缺失。