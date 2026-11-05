# 06 — 收口：删死代码与全量验证

**What to build:** 移除被新模型取代的代码路径，更新文档状态，跑完所有门禁。

**Blocked by:** 01–05

**Status:** done（代码与自动化验证完成；Windows 手工验收未执行）

- [x] 删除 `src/components/workspace/terminal/TerminalPanel.tsx` 与其专属测试（能力已由 registry + TerminalView 覆盖）。
- [x] 删除 `sidePanelStore` 中只为旧模型存在的 `terminalId` / `setTerminalId` / `pendingTerminalStarts` 相关分支；`isTabPresent` 只保留面板标签需要的语义。
- [x] `docs/specs/2026-08-19-terminal-session-persistence.md` 的 Status 行标注「生命周期目标仍有效，实现口径由 2026-11-06 spec 取代」。
- [x] `docs/README.md` 索引：新增 ADR 0022、spec、plan、`terminal-dock` 工单组。
- [x] 根目录 `npx vitest run` 全绿；`npm run build` 通过。
- [x] `cd crates/daemon && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test` 通过。
- [x] `npm run build:daemon` 通过；`npm run build:web` 在涉及浏览器宿主行为时验证。
- [x] 手工验收按 plan 的 10 条清单逐项打勾。
