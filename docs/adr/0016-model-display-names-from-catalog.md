# 0016 — 模型展示名来自目录，手写映射表退役

- 日期：2026-09-29
- 状态：已接受
- 相关：[ADR 0015 模型能力目录只是建议](0015-model-catalog-is-advisory.md)、[docs/research/2026-08-09-cherry-studio-model-display-name-rules.md](../research/2026-08-09-cherry-studio-model-display-name-rules.md)

## 背景

模型展示名过去来自两张手写表（`src/lib/modelRegistry/catalog.ts`，共 829 行）：

- `MODEL_CATALOG`（410 条）—— 规范模型 id → 展示名
- `PROVIDER_MODEL_OVERRIDES`（419 条）—— 供应商 → 线路 id → 规范 id，其中 **404 条
  带 `apiModelId`**，即「中转站实际接受的线路 id」到「规范 id」的改写

两张表都靠人工跟随上游更新，长期漂移。

调查时的初始判断是「models.dev 没有 provider 维度的线路 id 概念，这 419 条一条都
替代不了」。**这个判断是错的**，用真实数据核对后纠正如下。

## 关键发现

models.dev 的结构是 `{ providerKey: { models: { <线路 id>: {...} } } }`——**模型的键
就是线路 id**。也就是说它原生带我们手工维护的那个两级键
（`overrideByApiKey` = `providerId::apiModelId`），不需要额外映射。

拿 2026-09-29 的快照逐条比对 404 条线路 id：

| 结果 | 数量 | 说明 |
|---|---|---|
| 目录按 `(provider, 线路 id)` 逐字命中 | **332** | 含 `~anthropic/claude-fable-latest` 这类 OpenRouter 回退路由前缀 |
| 目录没有该线路 id | 70 | 多为已下线的旧模型（`claude-3-haiku`、`claude-opus-4`、`gpt-4-turbo-preview`） |
| 目录没有该 provider | 2 | `zhipu`（目录无此 provider） |

覆盖面之外还有：`zhipu` / `moonshot` / `mimo` / `amd-gpu-cloud` 目录里没有；`anthropic`
用的是不带日期的 id（`claude-sonnet-4-5`），而我们内建清单里是
`claude-sonnet-4-20250514`。这些一律退回 id 美化。

名字层面，332 条命中里 165 条与我们现有展示名完全一致，167 条不同——但差异是双向的：

- 目录更好：`Codestral 2508`（我们是别名 `Codestral (latest)`）、`Command R`（去掉了
  噪声日期）
- 我们更好：`DeepSeek-R1`（目录给的是 `R1 0528`，缺厂商名）、
  `DeepSeek V3.2 Thinking`（目录不标变体）
- 目录自带日期装饰：`GPT-4o-mini (2024-07-18)`——正是我们
  `deriveResolvedModelName` 里 `trailingRemainder` 在做的事

## 决策

删除 `catalog.ts` 整张表，展示名按以下顺序解析：

1. **目录名**——daemon 经 `GET /api/providers/catalog/names` 一次性下发
   `"<builtinTemplateId>::<modelId>"` → 展示名的索引，**原样采用**，不再叠加我们自己的
   命名空间/日期装饰（目录已经做过，叠加会重复）。
2. **prettify**——目录没有的 id，用 `deriveResolvedModelName` 美化，保留厂商命名空间
   前缀与日期后缀。

`src/lib/modelRegistry/normalize.ts`（14 个函数、约 20 张规则表）**逐字节保留**：它服务
的是「目录里永远不会有的中转站自定义 id」。

## 名称索引的投递范围

只下发我们 10 个 builtin template 覆盖的部分：547 条 / 约 29 KB。全量目录是 225 个
provider、8276 条、约 437 KB，而用户能挑到的模型都属于这 10 个 provider。自定义/中转
provider 没有 template id，本来就退回 prettify。

目录侧沿用 ADR 0015 的投递方式：按需拉取、进程内 24h TTL、失败回落随包快照。

## 后果

- 删掉 829 行手写数据与随之而来的同步负担，名称跟随上游自动更新。
- 约 162 处展示名会与之前略有差异（多为补回厂商前缀后持平，少数丢掉变体后缀如
  `Thinking`）；已下线的旧模型退回 prettify。
- 首次渲染到索引到达之间，名字先是 prettify 形态，随后被目录名替换
  （`useModelDisplayNames` 负责触发重渲染）。目录不可用时全程保持 prettify，与接入前
  行为一致，不倒退。
- `resetModelRegistryIndexesForTests` 与 `deriveResolvedModelName` 的三参数形态随
  索引层一并退役。
