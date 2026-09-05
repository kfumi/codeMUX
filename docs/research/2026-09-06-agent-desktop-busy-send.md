# 主流 Agent 桌面 / TUI：忙时发送（queue / steer / interrupt）

调研日期：2026-09-06。问题：集成 Claude Code / Codex / OpenCode / Pi 时，运行中再发消息怎么处理。

结论先说：行业里是 **三档**，不是两档。把「立即」同时当 steer 和 interrupt，会和成熟产品分叉。

## 三档语义

| 档 | 当前轮 | 这条消息何时生效 |
|---|---|---|
| Queue / follow-up | 继续跑完 | 整轮结束后作为下一轮 |
| Steer | 不打断 | 下一个工具 / step 边界注入本轮 |
| Interrupt / send-now | 打断 | 立刻开新轮 |

Stop 是纯取消，不附带新消息。

## 原生 CLI（agent 自己的 TUI）

默认忙时发送更接近 **steer**，排队是第二条快捷键。

- **Pi**：Enter = steering（当前工具结束后送达）；Alt+Enter = follow-up（全部做完再发）；Escape = abort 并把队列退回编辑器。[npm `@mariozechner/pi-coding-agent` Message Queue](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
- **Codex TUI**：队列文案是 “Messages to be submitted after next tool call”；Esc = interrupt and send immediately。协议有 `turn/steer`。[openai/codex#17095](https://github.com/openai/codex/issues/17095)、app-server schema
- **Claude Code TUI**：输入在下一个 LLM pause / 工具边界 flush（用户另有 issue 要求「真正等整轮结束」的队列）。Agent SDK / `stream-json` 是否等价有争议：Paseo 用同一条 query `push`；HAPI 实测 `--print --input-format stream-json` 中途 stdin 会被忽略。[anthropics/claude-code#49373](https://github.com/anthropics/claude-code/issues/49373)、[tiann/hapi#888](https://github.com/tiann/hapi/issues/888)
- **OpenCode**：core 已有 inbox，busy 时可 queue 或 steer。桌面正在做「Enter=Queue 或 Steer，Ctrl/Cmd+Enter=另一档，Steer 为默认」。[anomalyco/opencode#44683](https://github.com/anomalyco/opencode/issues/44683)

## 多 Agent 桌面壳

默认忙时发送更接近 **queue**；「现在发」多数是 **interrupt**。Steer 单独露出。

- **Zed Agent Panel**：生成中默认入队，结束后再发。队列条目可 toggle **Steer**（仅 Zed Agent；外部 ACP agent 因看不到 turn 边界而不可用）。**Send Now** / 连按 Enter = 立刻打断。[zed.dev/docs/ai/agent-panel](https://zed.dev/docs/ai/agent-panel)
- **Cursor**：Enter = 入队；Cmd/Ctrl+Enter = 立即发送。文档另有 **Steer a running agent**：Send now / 连按 Enter，下一次 tool call 送达、不中途砍掉。CLI 则是 Enter=steer，再按 Enter=interrupt。[cursor.com/docs/agent/overview](https://cursor.com/docs/agent/overview)
- **Augment**：Enter = 入队；Cmd/Ctrl+Enter = 打断当前轮立即发。队列上的 Send now = 跳过队列立刻发（打断语义）。出错自动暂停队列。[docs.augmentcode.com/using-augment/message-queue](https://docs.augmentcode.com/using-augment/message-queue)
- **Paseo**：设置三档 `interrupt | steer | queue`，默认已迁到 `steer`。Queue 模式下点 queued **send now** 目前仍走 interrupt，被当成 bug：期望能 steer 的 provider 应注入当前轮，不能再回落打断。[getpaseo/paseo#4061](https://github.com/getpaseo/paseo/issues/4061)

## 对 CodeMUX 的含义

CodeMUX 现状 = Zed/Augment 的 queue + Send Now(interrupt)，没有第三档 Steer。

把「立即」改成「能 steer 就 steer，否则打断」= Paseo #4061 / Cursor Send now 的方向。

更稳的主流拆法（Zed + Pi）：

1. 运行中普通发送 → 排队（已有）
2. 队列上「立即」→ 打断重发（已有）
3. 另加「注入 / Steer」→ 有能力才显示，失败再回落打断
