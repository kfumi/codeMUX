# 03 — 实现 Runtime Manager 安装与版本生命周期

**What to build:** 用户可以从 CodeMUX 安装、更新、切换、修复和删除任意 Provider Runtime；新版本写入独立版本目录，只有通过验证后才成为当前版本，任何失败都不会破坏仍可用的旧版本。

**Blocked by:** 01 — 建立 Runtime 领域契约与可测试边界；02 — 构建并发布可验证的 Runtime Pack

**Status:** done

- [x] 从正式 Runtime manifest 获取指定 Provider 的可用版本和下载资产。
- [x] 将 Runtime 安装到用户级版本化目录，不写入 CodeMUX 安装目录。
- [x] 在启用前完成签名、SHA-256、解压、关键文件和关键二进制完整性校验。
- [x] 支持安装、更新、版本切换、旧版本清理、删除和损坏 Runtime 修复。
- [x] 更新失败时保留旧版本并完成可验证的失败回滚。
- [x] 同一 Provider 的并发安装、更新和修复只允许一个实际任务执行。
- [x] Runtime 正在使用时，新版本操作不覆盖当前版本文件。
- [x] 测试覆盖 Node 缺失、版本过低、manifest 缺失、签名错误、哈希不匹配、解压失败、完整性失败、权限失败和回滚失败。