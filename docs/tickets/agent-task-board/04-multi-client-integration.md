# 04 — 多端收敛与集成验证

**What to build:** 待办看板作为 Daemon Client 功能在所有宿主上成立：Mobile Companion（浏览器形态）完整走一遍看板——创建、启动、旁观/跳会话、处理 awaiting_input、验收合并、取消/重试、归档；桌面与移动两个客户端同时打开时状态实时收敛（一侧动、另一侧 nudge 后 refetch 同步）。作为发布门，跑全量回归（根 + sidecar 的 vitest、cargo fmt / clippy / check、build daemon）并做一次 `dev:desktop` 手动走查。

**Blocked by:** 03 — worktree 隔离、验收合并与重新开始

**Status:** ready-for-agent

- [ ] Mobile Companion 上看板可完整操作：创建任务、拖拽启动、跳会话、awaiting_input 回复路径、验收合并、取消/重试、归档与删除
- [ ] 双客户端收敛：桌面启动任务，移动端实时看到状态流转；反向（移动端验收）桌面同步；刷新后状态一致
- [ ] 浏览器形态验证以 build web 产物为准（dist-web 刷新后才可见的回归点确认覆盖）
- [ ] 全量回归门：根与 sidecar 的 vitest 全量通过；cargo fmt / clippy / check 通过；build daemon（含 release 行为如涉打包则补 build daemon release 验证）
- [ ] `dev:desktop` 手动走查一遍 spec 的 40 条 user stories 中涉及 UI 的关键路径（创建 → 执行 → 验收 → 恢复 → 归档），记录发现的问题

## Comments

- 2026-09-21（实现会话）：票 01–03 已实现并通过代码审查两轴复审；本票的**自动化回归门全部通过**——根 vitest 226 文件 / 1835 用例全绿、sidecar vitest 全绿（需先 `cd apps/sidecar && npm run build` 生成 dist；verbatim-path 用例在本机 Node 22 下自动 skip，属环境限制）、cargo fmt / clippy / test（546 用例）全绿、`npm run build:daemon` 与 `npm run build:web` 成功。**剩余待人工完成**：`npm run dev:desktop` 的桌面手动走查与 Mobile Companion 双客户端收敛走查（无头环境无法执行 GUI）。走查完成前本票保持 open。
