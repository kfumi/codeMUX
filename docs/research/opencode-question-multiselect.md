# OpenCode 用户问题工具的多选语义调查

研究日期：2026-08-11

## 范围说明：仓库已迁移

用户指定的 `opencode-ai/opencode` 已归档，官方 README 说明项目已迁移到 Crush：

- [`README.md`（固定提交 `73ee493`，第 8-14 行）](https://github.com/opencode-ai/opencode/blob/73ee493265acf15fcd8caab2bc8cd3bd375b63cb/README.md#L8-L14)

严格查看这个旧仓库时，没有发现当前 `question` 工具的多选协议；它实现的是自定义命令 `$NAME` 参数的多输入框，提交结果为 `map[string]string`：

- [`internal/tui/components/dialog/arguments.go`](https://github.com/opencode-ai/opencode/blob/73ee493265acf15fcd8caab2bc8cd3bd375b63cb/internal/tui/components/dialog/arguments.go)
- [`internal/tui/components/dialog/custom_commands.go`](https://github.com/opencode-ai/opencode/blob/73ee493265acf15fcd8caab2bc8cd3bd375b63cb/internal/tui/components/dialog/custom_commands.go)
- [`internal/tui/tui.go`（约第 424-442 行）](https://github.com/opencode-ai/opencode/blob/73ee493265acf15fcd8caab2bc8cd3bd375b63cb/internal/tui/tui.go#L424-L442)

因此，本文后续关于 `question`、`multiple` 和 `string[][]` 的结论，引用的是当前官方维护的 [`anomalyco/opencode`](https://github.com/anomalyco/opencode)；这是 OpenCode 项目迁移后的源码，而不是旧归档仓库 `opencode-ai/opencode`。若问题严格限定为旧仓库，结论应是：该仓库没有这套用户问答多选协议。

## 结论先行

1. OpenCode 的官方字段不是 `multiSelect`，而是问题对象上的可选布尔字段 `multiple?: boolean`。它与 `options` 是同级字段，不在某个 option 内。
2. `multiple === true` 才表示该问题允许多选；字段缺省或为 `false` 时按单选处理。OpenCode 的选项对象只有 `label` 和 `description`，没有 `multiple` 字段。
3. 结果不是“单选返回字符串、多选返回数组”。OpenCode 对每个问题都返回一个字符串数组，因此整体形状始终是 `string[][]`：外层按问题顺序，内层是该问题选中的 label 列表。单选通常也是 `[["某选项"]]`。
4. OpenCode 通过“请求描述中的 `multiple`”识别多选，而不是通过答案数组推断。只看答案，`["A"]` 无法区分“单选选了 A”和“多选只选了 A”。
5. CodeMUX 当前 OpenCode 适配层把问题重新构造成只含 `question`、`header`、`options` 的对象，丢弃了官方的 `multiple`；随后前端使用自己的 `multiSelect` 字段。因此，当前看到没有显式多选标识的 JSON，很可能是适配层丢字段造成的，而不是 OpenCode 原始协议没有该标识。

## 1. 官方问题对象如何表达多选

官方 schema 的权威定义位于：

- [`packages/schema/src/v1/question.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/v1/question.ts)

其 `base` 结构包含：

```ts
{
  question: string
  header: string
  options: Array<{
    label: string
    description: string
  }>
  multiple?: boolean
}
```

`Info` 在这个基础上另有可选的 `custom?: boolean`；`Prompt` 使用基础结构。这里没有 `multiSelect` 字段。`multiple` 的 schema 注释就是“Allow selecting multiple choices”。

因此：

- 问题级别：`multiple: true`
- 选项级别：`label`、`description`
- 不是：`options[].multiple`
- 不是：根据选项数量、答案数组长度推断

官方 SDK 生成类型也保留这一语义：

- [`packages/sdk/js/src/v2/gen/types.gen.ts`（固定提交 `7daea69e`，`QuestionInfo` 约第 706 行）](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/gen/types.gen.ts#L706-L729)

其中 `QuestionInfo` 的 `multiple?: boolean` 与 `QuestionAnswer = string[]` 都是显式类型定义。

官方工具说明同样直接规定：答案以 label 数组返回；设置 `multiple: true` 才允许选择多个：

- [`packages/opencode/src/tool/question.txt`](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/question.txt)

## 2. 工具如何解析、执行和等待回答

### 2.1 LLM 工具参数

内置 `question` 工具的参数是一个 `questions` 数组，每项使用 `Question.Prompt` schema：

- [`packages/opencode/src/tool/question.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/question.ts)

工具执行时调用 `question.ask({ sessionID, questions, tool })`。它不会自己立即生成答案，而是把问题交给 Question service，并等待用户回答。

### 2.2 Question service 的阻塞链路

Question service 的实现位于：

- [`packages/opencode/src/question/index.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/question/index.ts)

核心流程是：

1. 为本次请求生成 `que_...` ID。
2. 保存 `QuestionRequest`（包含 `id`、`sessionID`、`questions` 和可选 tool 关联）到 pending 状态。
3. 发布 `question.asked` 事件。
4. 用 deferred/promise 等待 `reply` 或 `reject`。
5. 收到 `reply` 后删除 pending 项，发布 `question.replied`，再让原来的 `ask` 返回答案。
6. 收到 `reject` 或服务结束时发布拒绝事件并使等待中的工具失败。

这说明 `question.asked` 携带的是完整问题描述；多选能力在这一阶段已经由 `questions[i].multiple` 表达，而不是在事件接收端重新猜测。

### 2.3 工具结果

工具拿到答案后会：

- 将每个问题的答案用 `answers[i].join(", ")` 拼到可读的 tool output；
- 同时把原始数组放入 metadata 的 `answers` 字段。

源码：

- [`packages/opencode/src/tool/question.ts`](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/question.ts)

所以“展示给模型的字符串”和“结构化 metadata”并不是同一层：前者可能看起来像逗号分隔的文本，后者仍然保留嵌套数组。

## 3. 客户端如何识别和渲染多选

OpenCode TUI 的 `QuestionPrompt` 源码（固定提交 `ec3ae17e`）直接检查 `multiple`：

- [`packages/opencode/src/cli/cmd/tui/routes/session/question.tsx`](https://github.com/anomalyco/opencode/blob/ec3ae17e/packages/opencode/src/cli/cmd/tui/routes/session/question.tsx)

关键逻辑如下：

- `single`：只有一个问题且 `questions[0].multiple !== true` 时，走单选快速提交路径；
- `multi`：当前问题 `question()?.multiple === true` 时进入多选模式；
- 多选选项使用 toggle，将 label 加入或从当前问题的答案数组移除；
- UI 用方括号/勾选状态渲染多选，用圆形/普通选项渲染单选；
- 多问题或多选场景提供确认页，按问题顺序收集答案；
- 单选选项可以立即提交；多选先累积，确认后统一提交。

这也回答了“客户端如何识别”：客户端读取问题描述的 `multiple`，而不是检查 `options` 的形状，也不是检查当前已选数量。

## 4. 提交值与协议/API 形状

### 4.1 官方 schema 的提交形状

官方 schema 定义：

```ts
type QuestionAnswer = string[]

type QuestionReply = {
  answers: QuestionAnswer[]
}
```

来源：

- [`packages/schema/src/v1/question.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/v1/question.ts)
- [`packages/sdk/js/src/v2/gen/types.gen.ts`（固定提交 `7daea69e`）](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/gen/types.gen.ts#L706-L729)

典型提交：

```json
{
  "answers": [
    ["TypeScript"],
    ["SQLite", "PostgreSQL"]
  ]
}
```

第一题可以是单选，第二题是多选；两者都使用内层数组。

### 4.2 HTTP reply

在 OpenCode 的 HTTP 路由实现（固定提交 `ec3ae17e`）中，回复接口校验 `Question.Reply`，读取 `json.answers`，然后调用 Question service：

- [`packages/opencode/src/server/routes/question.ts`](https://github.com/anomalyco/opencode/blob/ec3ae17e/packages/opencode/src/server/routes/question.ts)

该版本的路由是：

```text
GET  /question/
POST /question/:requestID/reply
POST /question/:requestID/reject
```

`POST /question/:requestID/reply` 的 body 是 `{ "answers": string[][] }`，成功返回布尔值。

需要区分版本：官方 `dev` 分支的 v2 API 设计文档把同一类操作规划为 `/api/question`、`questionID` 和 `QuestionResponse`：

- [`specs/v2/api.html`](https://github.com/anomalyco/opencode/blob/dev/specs/v2/api.html)

这属于 v2 API map 的命名/挂载设计；集成旧版或当前兼容路由时，应以实际 SDK 生成类型和服务端路由为准，不要把 v2 规划文档中的 `response` 字段与旧路由的 `{answers}` 混用。

## 5. 为什么某些 JSON 看起来没有显式多选标识

### 5.1 原始 OpenCode JSON 的解释

如果原始 OpenCode `QuestionRequest` 中某题没有 `multiple`，按官方客户端逻辑就是单选默认值；如果是多选，应该出现同级字段：

```json
{
  "question": "选择数据库",
  "header": "数据库",
  "multiple": true,
  "options": [
    { "label": "SQLite", "description": "本地嵌入式数据库" },
    { "label": "PostgreSQL", "description": "服务端数据库" }
  ]
}
```

不能从下面这个答案判断模式：

```json
["SQLite"]
```

因为官方无论单选还是多选，都把每题答案表示成 label 数组。

### 5.2 CodeMUX 当前适配层的实际丢字段

CodeMUX 的 canonical 类型使用的是 `multiSelect`：

- [`src/lib/codeMuxProtocol.ts:70-78`](../../src/lib/codeMuxProtocol.ts)

但 OpenCode 事件转换目前只复制了 `question`、`header` 和 `options`：

- [`src-tauri/sidecar/src/opencodeRuntime.ts:862-870`](../../src-tauri/sidecar/src/opencodeRuntime.ts)
- [`src-tauri/sidecar/src/opencodeEvents.ts:529-544`](../../src-tauri/sidecar/src/opencodeEvents.ts)

这两个转换点没有读取 `qr.multiple`，也没有输出 `multiSelect`。因此，OpenCode 原始事件如果包含：

```json
{
  "question": "选择组件",
  "multiple": true,
  "options": [{ "label": "A" }, { "label": "B" }]
}
```

经过当前转换后可能变成：

```json
{
  "question": "选择组件",
  "header": "...",
  "options": [{ "label": "A" }, { "label": "B" }]
}
```

前端随后在 [`src/components/agent/AskUserQuestionCard.tsx:13-21`](../../src/components/agent/AskUserQuestionCard.tsx) 中只看 `multiSelect`，于是会把该题按单选渲染。这是“JSON 没有显式标识”在当前仓库中最具体、可验证的原因。

另外，CodeMUX 的 OpenCode reply 适配器会把答案正规化为每题一个数组，并向 OpenCode 发送 `{ answers: normalized }`：

- [`src-tauri/sidecar/src/opencodeSdk.ts:630-644`](../../src-tauri/sidecar/src/opencodeSdk.ts)
- [`src-tauri/sidecar/src/opencodeRuntime.ts:335-350`](../../src-tauri/sidecar/src/opencodeRuntime.ts)

这部分的嵌套数组形状是正确的；问题在于请求进入前端时丢失了 `multiple`，而不是 reply 的 `string[][]` 外形本身。

## 6. 对当前 JSON 设计的建议

1. **在 OpenCode ingress 显式做字段映射。** 读取 `multiple` 并输出 CodeMUX 约定的 `multiSelect`，例如：

   ```ts
   multiSelect: qr?.multiple === true
   ```

   更好的是只在源字段存在时保留语义，或者统一用 `selectionMode: "single" | "multiple"`，避免两个命名同时漂移。

2. **不要让 UI 根据答案形状推断模式。** `string[][]` 是 OpenCode 的协议形状，不是多选标志；必须保留请求描述中的 `multiple`/`multiSelect`。

3. **保留原始字段或来源信息。** 若要兼容多个 agent provider，建议 canonical question 同时记录 `source`，并在边界完成：

   ```ts
   // OpenCode -> CodeMUX
   multiSelect = multiple === true

   // CodeMUX -> OpenCode
   answers = answers.map((answer) => Array.isArray(answer) ? answer : [answer])
   ```

   不建议把 OpenCode 的 `multiple` 静默删除后再让渲染层猜测。

4. **把默认值写清楚。** `multiple` 缺省按单选处理；`multiple: false` 与缺省在现有客户端行为上等价，但如果需要可审计、可回放的 JSON，建议 canonical 层总是输出 `multiSelect: false` 或 `selectionMode: "single"`。

5. **区分 label 与 value。** OpenCode 官方答案按 selected label 返回；CodeMUX 当前 option 还允许 `value`。如果跨 provider 使用 `value`，要在适配层明确转换规则，不能假设 OpenCode 会回传任意 option value。

## 最终判断

OpenCode 原生确实有明确的多选标识，但名称是同级的 `multiple`，不是 `multiSelect`，也不是 option 内字段。原生 TUI、Question service、schema、tool 文档和 reply 协议共同证明了这一点。当前 CodeMUX 看到的无标识 JSON 主要是本地 OpenCode 事件归一化时没有透传 `multiple`；建议在 ingress 映射并保留该语义，而不是从 `answers` 的数组形状或 `options` 内容推断。
