# 0003 — 统一 CodeMUX Event 协议

## 状态

已接受

## 背景

不同智能体运行时的原始事件目前在 Sidecar 和前端分别解释。OpenCode 已经在 Sidecar 中做了部分转换，Codex、Claude 和历史恢复路径仍存在不同的事件形态；前端还需要从多个字段推导流式状态、错误和一轮结束状态。

这会使 provider 语义穿过 Sidecar 到达前端。实时路径和历史路径也可能对同一轮对话产生不同的事件序列。

## 决策

1. 在 Sidecar provider adapter 输出到前端之前建立 CodeMUX Event seam。
2. CodeMUX Event 使用领域事件，而不是继续暴露 Anthropic 风格的 `stream_event`。
3. 实时事件和历史恢复事件共用同一套 envelope，包含会话、消息和 Event Sequence 元数据。
4. Sidecar 负责 provider 解释、去重、顺序、工具生命周期、错误语义和结束状态；前端负责 session store、UI 节流及内部 `AgentMessage` 转换。
5. 错误事件描述原因，Turn Outcome 描述最终状态；前端不再从 provider 字段推导最终状态。
6. 批处理属于 transport concern。传输层可以批量发送连续增量事件，但进入 store 前必须展开为单条 CodeMUX Event。
7. Event Sequence 在会话内单调递增。重复事件在 Sidecar 去重；发现缺口时产生诊断但继续处理后续事件；重复结束事件不得生成第二个结果。

## 取舍

这会增加 Sidecar provider adapter 的实现复杂度，并要求历史恢复路径也遵守协议；换取前端 interface 更小、provider 变化的 locality 更好，以及实时和历史事件可以使用同一组等价性测试。

保留前端 `AgentMessage` 作为内部模型，避免一次性改动 UI 和测试。它不再承担跨层 wire interface 的职责。

## 测试

- 每个 provider adapter 使用原始事件 fixture 验证 CodeMUX Event 序列。
- 实时输入和历史输入验证产生等价的 CodeMUX Event 序列。
- 前端 adapter 和 store 使用 CodeMUX Event 序列验证 `AgentMessage` 与 streaming 状态。
