# Claude Code 与 OpenCode 流式链路排查记录

## 结论

本次性能快照中的主要问题发生在 Claude Code SDK 消息入口，不是统一滚动容器本身。

- `AgentThread` 在一轮思考期间出现数百到近两千次提交。
- Claude Agent SDK 的 `includePartialMessages: true` 会额外产生 `stream_event`，用于增量渲染；它不应该被当作历史 assistant 消息保存。
- Claude SDK 还会产生 `tool_progress`、`thinking_tokens`、`task_progress` 等运行态消息。当前界面没有这些消息的渲染或状态消费，却把它们追加到了 `events`，从而触发完整 assistant-ui 历史重算。
- OpenCode 链路在订阅层已经按事件 ID、消息 ID 和 payload 做去重，并在终态后忽略终态事件；Claude 链路此前没有等价的入口筛选。

## 官方资料

以下资料来自 Anthropic 官方 SDK 包和官方仓库元数据：

- [Claude Agent SDK TypeScript 官方仓库](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Claude Agent SDK 流式输出文档](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [OpenCode SDK JS 仓库](https://github.com/sst/opencode-sdk-js)

项目当前安装的 `@anthropic-ai/claude-agent-sdk` 类型定义明确声明：

- `includePartialMessages` 开启后会发出 `SDKPartialAssistantMessage`。
- `SDKPartialAssistantMessage.type` 为 `stream_event`，内容是底层 Anthropic 流事件。
- `SDKAssistantMessage` 是完整 assistant 消息，并带有 `parent_tool_use_id`；它与 partial stream 是两类不同消息。
- SDK 消息联合类型还包括 `tool_progress`、`thinking_tokens`、`task_progress`、`task_updated` 等运行态消息。

因此，Claude 的正确边界应当是：流式增量进入实时预览缓冲，完整 assistant/user/result 进入 transcript，只有界面明确消费的系统消息才进入前端事件历史。

## 与 OpenCode 的差异

OpenCode 的 `handleSdkEvent` 在订阅入口维护 `seenEventIds` 和 `seenPayloadKeys`，并根据 `messageID`、part ID、终态 session 等信息过滤重复或无效事件。Claude 目前使用 SDK async iterator 直接消费消息，原先每条 SDK 消息都会经过 sidecar 输出，再由前端追加或解析。

这意味着两条链路虽然都支持流式思考，但事件压力不同：OpenCode 的高频更新主要留在增量状态机内；Claude 的无 UI 消费消息此前会穿透到 `events`，导致整个历史树被反复计算。

## 本次修复

- 为 Claude `iterator.next()` 的 idle timeout 增加 `finally` 清理，避免每条消息遗留一个 5 分钟定时器闭包。
- 在 sidecar 入口丢弃没有 transcript 消费者的 Claude 运行态消息，保留 assistant、user、result、stream_event，以及 init、api_retry、compact_boundary。
- 保留统一外层滚动容器，消息、思考、计时和 footer 仍在同一滚动面板中。

## 验证方式

修复后应重新执行一轮较长 Claude Code 思考并导出性能快照，重点观察：

- `AgentThread.commitCount` 是否从每秒数十到数百次降到接近流式刷新频率。
- FPS 是否恢复稳定，缩放窗口时是否仍有明显延迟。
- 内存是否在一轮结束后趋于稳定，而不是随消息数持续增长。
- thinking 文本、工具调用、最终 result 和 footer 是否仍按原顺序显示。

## 官方一手资料核验

> 研究日期：2026-08-01。以下只引用 Anthropic、OpenCode 官方文档、官方仓库源码和官方 issue。Claude Agent SDK 类型以官方 npm 包 `@anthropic-ai/claude-agent-sdk@0.3.220` 为准；OpenCode 源码以官方仓库 `dev` 分支提交 `19231fce4b70aa5f7894a0a0eb20ff29bd417db5` 为准。

### 关键结论

1. Claude Agent SDK 的 `query()` 返回 `Query`，本质是 `AsyncGenerator<SDKMessage>`。`SDKMessage` 同时包含完整 `assistant` 消息和 `stream_event` partial 消息；两者是不同的消息形态，不能把每个 partial 当成一条独立 assistant 消息持久化。
2. `includePartialMessages: true` 才会让 SDK 发出 `SDKPartialAssistantMessage`。它的 `event` 是底层 Anthropic `BetaRawMessageStreamEvent`，所以 `content_block_delta` 是 partial 消息内部的事件类型，不是另一条顶层 `SDKMessage`。
3. `content_block_delta` 的文本和思考增量应追加；`signature_delta` 是思考块签名更新，不能按文本追加。完整 `assistant.message` 应作为一个消息/回合的最终权威快照提交或替换 partial 聚合结果。官方类型没有承诺 partial 与完整 assistant 之间的一对一、去重或替换协议。
4. 一个 API assistant turn 可能产生多个 SDK `assistant` 消息，并且这些消息可能共享同一个 API `message.id`；不能只用 `message.id` 去重。SDK 同时提供每帧 `uuid`，以及用于替换旧消息的 `supersedes` 字段，应把它们纳入聚合键和替换逻辑。
5. thinking streaming 是可选且模型/显示模式相关的：`thinking_delta` 是思考文本增量，`signature_delta` 是签名，`thinking.display: "omitted"` 时可能只有脱敏块/签名以及粗略 token 进度。`SDKThinkingTokensMessage` 明确是近似进度，不是计费权威值。
6. 未发现 Claude Agent SDK 官方提供固定聚合窗口、节流参数或面向 UI 的背压（backpressure）API。Anthropic TypeScript SDK 的官方实现有内部事件队列，但没有替调用方处理多个消息；调用方仍需自行设计消费、聚合和 UI 更新策略。
7. OpenCode 的 `/event` 是 SSE 事件总线订阅。官方 SDK 示例是直接 `for await` 消费；服务端先发 `server.connected`，随后发送总线事件，并每 10 秒发送一次心跳。当前服务端使用无界队列；源码另有 `allBounded` 丢弃型队列辅助函数，但当前 HTTP SSE 路由没有使用它。
8. OpenCode 明确区分仅实时的增量和可回放的完整结束事件：`session.next.text.delta`、`reasoning.delta`、`tool.input.delta` 等是高频增量；`text.ended`、`reasoning.ended`、`tool.input.ended` 携带完整值，是回放/最终状态边界。官方 issue 还提出进度事件应为临时事件、进行节流/合并、按增量传输，但该 issue 仍是开放设计提案，不是稳定协议保证。

### Claude Agent SDK：`query`、`SDKMessage` 与 partial

官方类型定义了：

```ts
interface Query extends AsyncGenerator<SDKMessage, void> {}

function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query
```

`SDKMessage` 是联合类型，其中至少包含：

- `SDKAssistantMessage`：`type: "assistant"`，完整内容在 `message: BetaMessage`。
- `SDKPartialAssistantMessage`：`type: "stream_event"`，原始流事件在 `event: BetaRawMessageStreamEvent`。
- `SDKResultMessage`：回合结果/终止信息，不等同于完整 assistant 内容。

`Options.includePartialMessages` 的官方注释只承诺：设为 `true` 时会在流式过程中发出 `SDKPartialAssistantMessage`。因此消费端应对 `stream_event` 做增量展示，对 `assistant` 做最终状态提交；不能假定只会收到其中一种，也不能假定每个 partial 都对应一条新的完整消息。

来源：

- [Claude Agent SDK TypeScript 官方仓库](https://github.com/anthropics/claude-agent-sdk-typescript)
- [官方 npm 包 0.3.220](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.220)
- [官方 Agent SDK 流式输出文档](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [官方 Agent SDK TypeScript 文档](https://platform.claude.com/docs/en/agent-sdk/typescript)

### `content_block_delta` 与 thinking streaming

Anthropic 官方 TypeScript SDK 将 `BetaRawMessageStreamEvent` 定义为消息起止、内容块起止和内容块增量事件的联合类型。`BetaRawContentBlockDeltaEvent` 的结构包含 `index` 和 `delta`。在一条长文本或思考块中，`content_block_delta` 会反复出现，是最可能成为高频事件的类型；事件次数、每次增量大小和时间间隔没有固定保证。

增量类型包括：

- `text_delta`：追加到对应文本块。
- `thinking_delta`：追加到对应 thinking 块的 `thinking` 字段。
- `input_json_delta`：追加到 tool input 的部分 JSON，不能当作完整 JSON 解析。
- `citations_delta`：追加引用项。
- `signature_delta`：更新 thinking 块的签名，语义不是文本追加。

官方 `BetaMessageStream` 的聚合实现按 `message_start` 到 `message_stop` 维护一个 snapshot：文本和 thinking 使用字符串追加，签名直接更新，`message_stop` 返回该 snapshot。该实现同时明确说明：如果有多个消息，多个消息之间的 aggregation 需要调用方处理。

thinking 配置支持 `adaptive`、固定预算的 `enabled` 和 `disabled`；显示模式支持 `summarized` 与 `omitted`。当 thinking 被 omitted 或模型处于脱敏思考阶段时，SDK 还可能发出 `SDKThinkingTokensMessage`。官方类型注释明确它是从 `thinking_delta.estimated_tokens` 消化出的近似运行进度，只适合进度指示器，不是准确计费 token；`usage.output_tokens` 才是权威值。

官方 issue #25 记录了历史版本/配置下开启 `maxThinkingTokens` 后只有最终 `AssistantMessage` 能看到 thinking，而 `StreamEvent` 可能完全没有。该 issue 处于开放状态，不能当作当前所有版本的协议定义，但说明消费端必须容忍“有完整 thinking、没有可见 thinking partial”的情况。

来源：

- [Anthropic 官方 SDK：消息流事件类型](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/beta/messages/messages.ts)
- [Anthropic 官方 SDK：BetaMessageStream 聚合实现](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/BetaMessageStream.ts)
- [Anthropic 官方消息流文档](https://platform.claude.com/docs/en/api/messages-streaming)
- [官方 extended thinking 文档](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [官方 adaptive thinking 文档](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
- [官方 issue #25：Agent SDK 中 thinking 不可见](https://github.com/anthropics/claude-agent-sdk-typescript/issues/25)

### partial、完整 assistant、重复与背压

官方类型层面没有声明以下保证：每个 `stream_event` 最终恰好对应一条 `assistant`；`assistant` 会在每个 partial 后立即出现；partial 与完整 assistant 使用同一个外层 `uuid`；收到完整 assistant 后之前的 partial 会自动被删除或标记为已替换。

`SDKAssistantMessage` 的注释还说明，一个 API assistant turn 可能产生多个 assistant 消息，它们可能共享 `message.id`；该 `message.id` 不能独立作为“已经处理过”的键。每条 SDK 消息都有 `uuid`；完整 assistant 还可以带 `supersedes`，表示需要被当前消息替换的旧 wire UUID。

因此合理的消费模型是“事件日志 + 当前投影”：partial 只更新当前内容块的投影，完整 assistant 到达时以完整内容覆盖/提交该投影；重连、重试或替换时按 `uuid`、`request_id`、内容块索引和 `supersedes` 处理，而不是简单地对所有文本字段继续追加。

没有在 Agent SDK 的官方类型或文档中找到“重复 partial 的去重保证”、固定发送频率、固定心跳间隔、聚合窗口或 UI 背压选项。官方 issue #44 报告过普通文本流出现三分钟以上没有任何事件的空档；该 issue 是用户报告且开放，不能证明所有请求都会如此，但说明“没有新 delta”不能直接等同于“查询已结束”。Anthropic 官方 TypeScript SDK 的 `BetaMessageStream` 迭代器会把未及时消费的事件放入内部数组队列；它没有向 Agent SDK 消费者暴露可配置的高低水位或丢弃策略。

来源：

- [官方 issue #44：文本流长时间无事件](https://github.com/anthropics/claude-agent-sdk-typescript/issues/44)
- [Anthropic 官方 SDK：流迭代器队列实现](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/BetaMessageStream.ts)

### OpenCode：SSE event/subscription 语义

OpenCode 官方 SDK 文档给出的消费方式是：

```ts
const events = await client.event.subscribe()
for await (const event of events.stream) {
  console.log(event.type, event.properties)
}
```

官方 server 文档说明 `GET /event` 是 SSE 流，首个事件是 `server.connected`，之后是总线事件。当前 `dev` 源码显示：

- SSE 数据统一编码为 `event: message`，JSON 数据包含 `id`、`type`、`properties`。
- 订阅建立时先注册 listener，再开始输出，因此注册之后发布的事件不会因初始化顺序被漏掉。
- 当前服务端按 instance directory 和 workspace 过滤事件；该路由没有按 session 做更细粒度的订阅过滤。
- 每 10 秒生成一个 `server.heartbeat`，用于保持流活跃。
- 断开时执行 unsubscribe；正常业务事件没有在该路由中做去重或合并。

OpenCode 官方 JS SDK 的通用 SSE 生成器支持 `Last-Event-ID`、默认 3 秒重试起点和指数退避上限 30 秒，但当前 OpenCode `/event` 路由本身没有按 `Last-Event-ID` 回放历史事件。因此这属于传输重连能力，不等于 OpenCode 已提供可靠的断线续传或“恰好一次”语义。

来源：

- [OpenCode 官方 SDK 文档](https://opencode.ai/docs/sdk/)
- [OpenCode 官方 server/API 文档](https://opencode.ai/docs/server/)
- [SSE 路由实现](https://github.com/anomalyco/opencode/blob/19231fce4b70aa5f7894a0a0eb20ff29bd417db5/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts)
- [SSE SDK 生成器](https://github.com/anomalyco/opencode/blob/19231fce4b70aa5f7894a0a0eb20ff29bd5/packages/sdk/js/src/gen/core/serverSentEvents.gen.ts)

### OpenCode：高频增量与完整边界

官方 schema 把流式内容拆成仅实时增量和完整结束事件：

- 文本：`session.next.text.started`、`session.next.text.delta`、`session.next.text.ended`。
- 思考：`session.next.reasoning.started`、`session.next.reasoning.delta`、`session.next.reasoning.ended`。
- tool input：`session.next.tool.input.started`、`session.next.tool.input.delta`、`session.next.tool.input.ended`。
- 其它可能高频的过程事件包括 tool progress 和 compaction delta。

源码注释明确：`Text.Delta`、`Reasoning.Delta` 等流片段仅用于实时传递；`Text.Ended`、`Reasoning.Ended` 等携带完整值，是可回放的完整值边界。处理器在收到 `text-delta` / `reasoning-delta` 时把增量追加到内存状态并发布 `updatePartDelta`；结束时发布完整 `updatePart`。因此消费者不应把 `text.delta` 和随后 `text.ended.text` 都 append 到同一个字符串，否则完整结束值会被重复计算；正确做法是增量阶段追加，ended 阶段替换/提交该 part 的完整值。

来源：

- [OpenCode 会话事件 schema](https://github.com/anomalyco/opencode/blob/19231fce4b70aa5f7894a0a0eb20ff29bd5/packages/schema/src/session-event.ts)
- [OpenCode 会话处理器](https://github.com/anomalyco/opencode/blob/19231fce4b70aa5f7894a0a0eb20ff29bd5/packages/opencode/src/session/processor.ts)
- [OpenCode 事件类型定义](https://github.com/anomalyco/opencode/blob/19231fce4b70aa5f7894a0a0eb20ff29bd5/packages/core/src/event.ts)

### OpenCode：重复投递、无界队列与官方设计提案

当前 HTTP SSE handler 使用 `Queue.unbounded` 接收事件，事件总线的全量 PubSub 也使用无界实现。源码中存在 `allBounded`：它用有限容量的 dropping queue，队列满时以 `SubscriberOverflowError` 失败；但当前 `/event` HTTP 路径使用的是自己的无界队列，不是这个 bounded helper。

OpenCode 官方 issue #36441 记录了多 TUI 订阅同一全局事件流造成的 N 倍队列、序列化、SSE 写入、客户端解码和投影成本，并提出：按 location/workspace/session 范围过滤、限制事件负载、每个客户端保持一个活动流、避免重连重叠。issue 中的设计建议还写明进度应为临时事件、进行节流/合并、按增量传输，重复的累计进度快照不应变成持久化历史。#36443 进一步要求范围变化时避免重叠流或重复投递。

这些是官方仓库 issue 中的开放设计/事故结论，不是当前稳定 API 的“恰好一次”、有界背压或可靠回放保证。当前实现可得出的安全假设只有：事件按订阅连接实时送达，连接生命周期结束会取消 listener；消费端仍应自行防止重复订阅、限制渲染成本，并以 ended/full state 做最终校正。

来源：

- [OpenCode SSE handler](https://github.com/anomalyco/opencode/blob/19231fce4b70aa5f7894a0a0eb20ff29bd5/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts)
- [OpenCode EventV2 总线](https://github.com/anomalyco/opencode/blob/19231fce4b70aa5f7894a0a0eb29bd417db5/packages/core/src/event.ts)
- [官方 issue #36441：限制事件流范围和 payload](https://github.com/anomalyco/opencode/issues/36441)
- [官方 issue #36443：按客户端兴趣订阅](https://github.com/anomalyco/opencode/issues/36443)

### 聚合边界建议

以下是基于上述官方语义得出的实现建议，不冒充官方 API 保证：

1. Claude Agent SDK：按查询/assistant turn、内容块 `index` 和事件类型维护聚合器；`text_delta`、`thinking_delta`、`partial_json` 只追加，`signature_delta` 和结束快照按替换语义处理。
2. 不把 partial 与完整 assistant 混入同一条 append-only UI 消息。partial 更新临时投影，完整 `assistant` 或 OpenCode `ended` 事件提交最终投影。
3. 事件去重使用外层 `uuid`/事件 `id` 和订阅实例生命周期；不要仅按 Claude `message.id`，也不要仅按 OpenCode `type` 或文本内容。对于明确的 `supersedes`，先撤销被替换的 wire 消息再提交当前消息。
4. 传输消费可以连续读取，但 UI 更新应节流或合并；聚合器不能丢失终止、签名、tool input 完成和错误事件。应设置空档监控，但不能把任意时间间隔当作协议级 timeout。
5. 断线重连必须保证旧订阅已取消后再创建新订阅；OpenCode 当前 SSE 没有可依赖的历史 replay，恢复时应重新读取完整 session/message 状态以校正 live 投影。
