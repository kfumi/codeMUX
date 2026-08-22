# 07 — Plan Mode 与 Plan Approval 闭环

**What to build:** Plan Mode 作为与 Workflow Mode 正交的 composer toggle。开启时 `turn/start` 使用 plan collaborationMode；turn 正常完成后 emit 合成 Plan Approval Interactive Request（Implement / Dismiss）。Implement 后自动关闭 Plan Mode 并启动 implementation turn；Dismiss 后解挂且不跟 implementation turn。

**Blocked by:** 03 — 官方上游基础 Codex turn; 05 — Codex 工具级 Interactive Request 审批

**Status:** ready-for-agent

- [ ] Plan toggle 独立于 Workflow Mode selector（composer 控件区，与 Reasoning Effort 同级）
- [ ] ensure/turn 前 `collaborationMode/list` 解析 plan 与 code 协作模式
- [ ] Plan turn 完成后合成 Plan Approval（kind 可区分于 tool approval）；挂起 turn 等待用户
- [ ] Implement：关 Plan Mode、组装 implementation follow-up prompt、自动 `turn/start`
- [ ] Dismiss：解挂 Plan Approval，不启动 implementation turn
- [ ] 桌面 UI 展示 plan markdown + Implement / Dismiss 按钮
- [ ] fake-app-server 或集成测覆盖 Plan 闭环 happy path
