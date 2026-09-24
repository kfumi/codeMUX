# codeg 实时 Token 速度参考与 CodeMUX 实施方案

- 日期：2026-09-24
- 参考项目：`D:\project\my-project\codeg`
- 参考对象：对话进行中的实时输出速度
- 结论性质：一手源码走查；未依赖二手文章

## 结论摘要

`codeg` 的实时 token 速度由前端本地估算，不是模型、ACP 连接或 Provider API 直接返回的字段。它从活动回合已经收到的正文和思考内容估算累计 token，再以相邻采样差分得到瞬时速度，最后做低通平滑。UI 明确把它标成“估算输出速度（正文 + 思考）”，只显示 `tok/s`，不把最终 usage 或账单数据冒充实时速度。

CodeMUX 采用相同的估算思路，但不能直接比较 `streamingText` / `streamingThinking` 当前字符串：这些字段会在 content block 切换时清空，并且只保留最后 16K 预览；一次性 assistant 消息还会被前端人为分帧。CodeMUX 因此在真实 `text_delta` / `reasoning_delta` 进入 store 时累计估算 token，模拟 reveal 和工具输入不计数，再由独立 2Hz hook 采样。

## codeg 一手源码

### 字符到 token 的估算

- `D:\project\my-project\codeg\src\lib\token-speed.ts:1-18`
  - CJK 等高密度字符约 `1.8 chars/token`；其他字符约 `4 chars/token`。
  - 空白不计；kana、Hangul、全角形式和 astral 字符按高密度桶处理。
- `...\src\lib\token-speed.ts:73-100`
  - `countChars` / `estimateTokens` 实现上述启发式。
  - 按 Unicode code point 处理，代理对不会被算成两个字符。
- `...\src\lib\token-speed.test.ts:5-83`
  - 覆盖中英混排、空白、标点、假名、韩文、emoji/代理对及 suffix 可加性。

这不是模型 tokenizer，也不能用于计费。它的用途是给实时 UI 一个稳定、相对可读的输出速度。

### 累计计数边界

- `D:\project\my-project\codeg\src\hooks\use-token-output-speed.ts:24-33`
  - 只统计主 agent 的 `text` + `thinking`。
  - 子 agent 输出属于自己的卡片，不计入父回合速度。
- `...\src\hooks\use-token-output-speed.ts:69-80`
  - 遍历活动消息的 eligible blocks；工具调用不参与。
- `D:\project\my-project\codeg\src\lib\token-speed.ts:103-186`
  - `TokenCountAccumulator` 为每个 block 保存已消费长度，只扫描新追加后缀，避免每个样本重扫整回合。

### 速度和平滑

- `D:\project\my-project\codeg\src\lib\token-speed.ts:188-248`
  - 相邻样本的瞬时速度为 `Δtokens / Δseconds`。
  - 使用时间常数 `TAU_MS = 1500` 的一阶 EWMA；alpha 按实际 dt 计算，因此采样频率变化不会改变读数含义。
  - 同时累计 `weight` 做 Adam 式 bias correction，避免开头读数被低流量样本拖到接近 0。
  - 观察窗口不足 `WARMUP_MS = 300` 时返回 `null`。
  - 长时间没有新 token 时，读数通过 EWMA 自然衰减，而不是冻结在旧值。
- `...\src\lib\token-speed.test.ts:132-209`
  - 覆盖恒速、warmup、突发后静默、16ms 批量提交、非正 dt、reset 与长暂停衰减。

### 采样和 UI

- `D:\project\my-project\codeg\src\hooks\use-token-output-speed.ts:8-21`
  - 固定 `SAMPLE_MS = 500`，即 2Hz。
  - 采样定时器独立于 wire event 和 React render；工具等待、权限等待或重试静默时也会继续让读数衰减。
  - 显示值上限为 `999.9 tok/s`，防止异常尖峰撑坏状态行。
- `...\src\hooks\use-token-output-speed.ts:83-120`
  - 首个 token 前的等待不计入速度。
  - 首 token 到来时从“最后一个空样本”建立基线，避免 TTFT 把首读压低。
  - 中途刷新或重连先对已有内容建立基线，后续只测新输出。
- `D:\project\my-project\codeg\src\components\message\live-turn-stats.tsx:310-320,378-397`
  - 活动回合状态行显示一位小数 `tok/s`。
  - 使用 `tabular-nums` 避免数字宽度抖动。
- `D:\project\my-project\codeg\src\components\message\message-list-view.tsx:1639-1645`
  - 组件只在连接状态为 `prompting` 时挂载；不是历史消息的持久化统计。
- `D:\project\my-project\codeg\src\i18n\messages\zh-CN.json:3381-3382`
  - 文案明确为“估算输出速度（正文 + 思考）”。

## CodeMUX 当前数据链

### 可用的精确 usage 不适合实时速度

- `src/types/agent.ts:98-123`
  - 最终 result 包含 `usage.output_tokens` 等精确字段。
- `src/stores/agentStore.ts:2772-2775`（`refreshLatestTokenUsage` 调用点）
  - 成功 result 到达后才刷新 history token usage。
- `src/stores/agentStore.ts:2035-2037`（legacy `token_usage_update` guard）
  - 旧 `token_usage_update` sidecar 事件不会进入时间线，也不作为实时仪表数据源。

因此精确 usage 适合回合结束后的总量/上下文统计；实时 TPS 仍需从可见输出增量估算。

### 为什么不能直接测当前 streaming 字符串

- `src/stores/agentStore.ts:281-291`（streaming flush 常量）
  - Claude 预览使用 100ms flush，其他 runtime 使用 50ms flush。
- `src/stores/agentStore.ts:489-508`（`appendStreamingPreview`）
  - `streamingText` / `streamingThinking` 只保留最后 `STREAMING_PREVIEW_MAX_CHARS = 16_384` 字符。
- `src/stores/agentStore.ts:586-601`（`clearStreamingTextField`）
  - content block 切换会清空对应 preview 字段。
- `src/stores/agentStore.ts:1118-1193`（`simulateStreamingContent`）
  - 一次性 assistant 内容会经过 `simulateStreamingContent` 按前端节拍人为揭示；这是 UI 动画，不是 Provider 真实产出速度。
- `src/stores/agentStore.ts:2123-2272`（streaming event handler）
  - 真实 Provider 流以 `thinking_delta` / `text_delta` 到达；工具参数走 `input_json_delta`。

直接比较当前字符串会受到清空、截断、分段和模拟 reveal 干扰，产生负增量或虚假高 TPS。

## CodeMUX 采用方案

### 真实 delta 入库时累计

- `src/lib/tokenSpeed.ts`
  - 忽略空白；CJK、假名、韩文、全角和 astral 字符约 `1.8 chars/token`，其他字符约 `4 chars/token`。
  - `TokenSpeedTracker` 使用 1500ms 时间常数 EWMA、bias correction、300ms warmup 和 999.9 上限。
- `src/stores/agentStore.ts`
  - 新增 `streamingEstimatedOutputTokens`，按 session 保存当前活动回合的累计估算值。
  - 内部 streaming buffer 携带本批 `estimatedTokens`，在既有 50/100ms flush 的同一 store commit 中更新，不为每个 delta 增加额外 React commit。
  - 真实 text/reasoning delta 计数；工具输入和 `simulateStreamingContent` 人工 reveal 不计数。
  - block 切换只清 preview，不清累计值。
  - 新 query 真正 dispatch、attach/reconnect、terminal、interrupt、daemon idle fallback、后台完成、clear 和 rewind 按各自生命周期重置或清理；排队但尚未 dispatch 不影响当前回合。

### 独立 2Hz 仪表

- `src/hooks/useTokenOutputSpeed.ts:6-76`（`useTokenOutputSpeed`）
  - 每 500ms 通过 `useAgentStore.getState()` 读取累计 token，不订阅每个 stream flush。
  - session 或 `turnStartedAt` 改变时重建 tracker；中途挂载已有累计值时，先等真实增长再发布速度。
  - 首 token 前不显示；首读排除 TTFT；后续静默期保持读数并衰减。
- `src/components/agent/assistant-ui/CodeMuxThread.tsx:2321-2361`（`StreamingTokenSpeedIndicator` / `StreamingStatusFooter`）
  - `StreamingTokenSpeedIndicator` 是独立 memo 子组件，只有该数字节点按 2Hz 更新，父 `StreamingStatusFooter` 不随速度重渲染。
  - 有效读数显示 Gauge、tabular `xx.x tok/s`，tooltip 和包含当前值的 aria-label 明确“估算输出速度（正文 + 思考）”。
  - 没有有效读数时不渲染 `0.0 tok/s` 占位。

## 方案比较

### 等待 Provider 精确 usage

优点是权威；缺点是不同 runtime 的 usage 时序和字段不统一，而且多数精确值在回合结束后才到，无法满足实时展示，因此不采用。

### 比较当前 streaming buffer

实现表面最少，但会被 block 清空、16K 截断、多段流和模拟 reveal 破坏，容易出现负增量、速度骤降或虚高，因此不采用。

### 真实 delta 累计 + 2Hz 平滑采样

与 `codeg` 的成熟策略一致，同时适配 CodeMUX 的 delta/flush/预览架构；不增加协议、不引入 tokenizer，也不会把前端 reveal 动画冒充模型速度，因此采用。

## 局限和未来校准

- 字符启发式无法替代模型 tokenizer；代码、Markdown、混合格式和模型差异都会造成偏差。
- TTFT、网络抖动、provider 批量提交会影响相邻样本；2Hz EWMA 展示的是平滑局部速度，不是精确计费速度。
- 工具密集回合的读数只反映正文与思考，不代表整回合 wall-clock 产出。
- 第一版不持久化每回合 TPS。若未来有足够样本，可用匿名 provider 最终 usage 对 CJK/非 CJK 系数做离线校准，并按模型族细分；UI 仍应保留“估算”语义。
