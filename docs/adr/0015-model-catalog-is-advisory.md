# 0015 — 模型能力目录只是建议，`provider.models` 始终是权威

- 日期：2026-09-29
- 状态：已接受
- 相关：[ADR 0005 CodeMUX 自有 Model Provider](0005-codemux-owned-model-providers.md)、[ADR 0014 pi 项目资源默认不信任](0014-pi-project-resources-untrusted-by-default.md)

## 背景

CodeMUX 支持直连厂商，也支持把任意中转/自建端点配成 Model Provider。中转站挂的模型
id 是用户自己定的（`space-bunny-free`、`deepseek-flash`…），其中相当一部分不在任何公开
目录里。

与此同时，各运行时对「这个模型支不支持思考」的处理各不相同，而且**失败一律静默**：

- pi 读托管 `models.json` 的 `reasoning`，缺省取 `false`（`definition.reasoning ?? false`），
  于是 `getSupportedThinkingLevels()` 只剩 `["off"]`，任何思考档位被钳回 off，且不向
  供应商发送 thinking 参数。UI 上档位照常显示，不报任何错。
- Codex / OpenCode / Claude Code 侧我们直接透传 `reasoningEffort`，但没有 per-model 的
  能力位可依据。
- 前端靠 substring 猜输入模态（`src/lib/inputModalities.ts`），中转站的视觉模型被记成
  纯文本，图片被静默丢弃。
- 上下文窗口无声明时一律兜底 200k，对 32k 的模型进度条会显示 6%。

结论是：能力位必须有人回答，但**只有用户知道自己端点后面挂的是什么**。

## 决策

接入 models.dev（`https://models.dev/api.json`）作为能力位的**建议来源**，并把
`ProviderModel.supports_reasoning: Option<bool>` 换成
`ProviderModel.thinking_levels: Option<Vec<ThinkingLevel>>`。

三条不变式：

1. **`provider.models` 是用户配置，是唯一权威。** 目录只提供建议，任何情况下不自动写盘、
   不覆盖用户已填的值。用户把模型配成 `thinking_levels: []`（「这个模型不思考」）时，
   目录不得翻案。
2. **查不到就退回现状，绝不猜。** lookup 未命中返回 `found: false`，UI 不显示建议卡片，
   一切沿用用户自己的配置。目录不可用（离线、上游故障）同样不是错误。
3. **三态语义。**
   - `None`（未声明）—— composer 显示全部六档以免打断既有会话，但会标注该模型未声明
     思考能力；pi 侧不写 `reasoning`。
   - `Some([])`（明确不支持）—— composer 只显示「关闭」。
   - `Some([..])`（精确白名单）—— composer 只显示这几档；pi 侧写 `reasoning` 加一份逐档
     的 `thinkingLevelMap`（未勾选的写 `null`，由 pi 从可用列表剔除）。

`supports_reasoning` 保留为只读遗留字段，加载时由 `normalize_legacy_thinking_levels`
折叠进 `thinking_levels` 后回写磁盘，迁移只发生一次。`Some(true)` 展开为完整六档——这与
布尔位在世时的行为一致（当时对任何声明支持的模型都无条件写
`thinkingLevelMap: {xhigh, max}`）。

## 明确不来自目录的东西

以下都是**我们的行为**而非模型属性，必须留在本地配置里：

| 东西 | 为什么目录给不了 |
|---|---|
| `base_url` 与端点路径形状 | 目录不提供 `https://open.bigmodel.cn/api/paas/v4` 这类 |
| `codex_needs_proxy` | 硅基/智谱/AMD 要走 chat-compat 代理，是我们网关的路由决策 |
| `Protocol` 三值枚举与端点选择优先级 | agent 侧适配逻辑 |
| `apply_patch_tool_type: "freeform"` | codex 0.146.x 的版本门，注释已明说换 `'function'` 会让 resume 报 unknown variant |
| `claudeModelAliasEnv` 的角色别名 | 自定义网关没有 `haiku`/`sonnet` 这些代号 |
| `modelRegistry/normalize.ts` 的规范化规则 | 中转站自定义 id 永远查不到目录 |
| `PROVIDER_MODEL_OVERRIDES` 的线路 id 改写 | 目录没有 provider 维度的线路 id 概念（`z-ai/glm-5.2`、`~anthropic/…`） |

## 投递方式

照 PI-Desktop 的 `ModelsDevCatalog`：按需拉取、进程内缓存（24h TTL）、失败回落到随包
发布的快照 `apps/desktop/resources/models.dev/api.json`。这样离线可用，且上游挂了我们
不崩——目录是可选增强，不该成为单点故障。

## 后果

- 用户不再需要逐个模型手填能力位；无名的中转 id 仍由用户自己填（那本来也只有他知道）。
- 目录给出的上下文窗口不再被假值遮挡：删掉了 `withDefaultOpenAiModelLimits` 对每个
  OpenAI 协议模型自动写入并持久化 200k / 65536 的行为——那些值一旦落盘就会盖住目录
  查到的真值。
- pi 会话不再对所有声明支持的模型强行开放 `xhigh` / `max`；只有用户勾了才写。
- 目录未收录的模型行为与今天一致（未声明），不倒退。
