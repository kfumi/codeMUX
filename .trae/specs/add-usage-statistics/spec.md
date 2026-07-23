# 使用统计与活跃热力图 Spec

## Why
用户目前无法直观了解自己的使用频率和习惯。添加使用统计功能（含活跃热力图、柱状图、模型分布）可以让用户可视化每日活跃程度、token 消耗趋势、缓存共享率，并按智能体和时间维度灵活切换。

## 设计决策
**不新建 `usage_events` 表**。直接利用现有数据源：
- **`sessions` 表**：已有 `created_at`、`agent_kind`、`model`、`is_archived` 字段，可直接统计每日会话数、智能体分布、模型分布、活跃天数
- **各智能体 JSONL 文件**：
  - Claude Code：每条 `assistant` 事件含 `timestamp` + 独立的 `message.usage`（input_tokens / cache_read_input_tokens / output_tokens），可直接按天聚合
  - Codex：每轮的 `token_count` 事件含 `last_token_usage`，通过相邻轮次差值可得每轮增量
  - OpenCode：每条 assistant 事件含独立的 per-event token usage
  - 复用现有 `find_claude_session_jsonl` / `find_codex_session_jsonl` / `opencode_history` 定位文件

## What Changes
- 新增 Rust 命令 `get_usage_stats`：从 `sessions` 表聚合热力图日数据、概览统计、智能体/模型分布（即时 SQL 查询）
- 新增 Rust 命令 `get_usage_token_breakdown`：批量解析 JSONL 文件，按天聚合 input/output/cached token（异步执行，前端显示加载状态）
- 新增设置面板「使用统计」标签页，含：智能体下拉筛选、时间范围切换、概览卡片、活跃热力图、每日 token 柱状图、模型统计列表

## Impact
- Affected code:
  - `src-tauri/src/db/operations.rs` — 新增 sessions 表聚合查询函数（heatmap / overview / agent distribution / model distribution）
  - `src-tauri/src/commands/` — 新增 `usage.rs` 命令模块
  - `src-tauri/src/agent/commands.rs` — 复用现有 JSONL 解析与文件定位函数，新增批量按天 token 聚合逻辑
  - `src-tauri/src/lib.rs` — 注册新命令
  - `src/lib/tauri.ts` — 新增 `usageApi`
  - `src/components/settings/SettingsDialog.tsx` — 新增「使用统计」标签页
  - `src/components/settings/UsageStatistics.tsx` — 新增统计面板组件
  - `src/components/settings/UsageHeatmap.tsx` — 热力图子组件
  - `src/components/settings/UsageBarChart.tsx` — 每日 token 柱状图子组件

## ADDED Requirements

### Requirement: 智能体筛选与时间范围切换
系统 SHALL 提供智能体下拉筛选（全部 / Claude Code / Codex / Gemini / OpenCode）和时间范围切换（最近 7 天 / 最近 30 天，默认 30 天），所有统计区域联动响应筛选条件。

#### Scenario: 切换智能体
- **WHEN** 用户从下拉选择「Codex」
- **THEN** 概览卡片、柱状图、模型列表均只展示 Codex 的数据
- **AND** 热力图保持全年度展示不受影响

#### Scenario: 切换时间范围
- **WHEN** 用户从「最近 30 天」切换到「最近 7 天」
- **THEN** 概览卡片、柱状图、模型列表均只展示最近 7 天的数据
- **AND** 热力图保持全年度展示不受影响

### Requirement: 基于 sessions 表的活跃热力图
系统 SHALL 从 `sessions` 表按 `DATE(created_at)` 聚合，返回过去 365 天每日新建会话数，用于渲染 GitHub 风格热力图。热力图始终展示全年度，不受时间范围筛选影响。

#### Scenario: 查看热力图
- **WHEN** 用户打开设置 → 使用统计标签页
- **THEN** 热力图基于 sessions 表即时渲染，每个格子代表一天，颜色深浅反映当日新建会话数
- **AND** 悬停格子时显示 tooltip 包含日期和会话数

#### Scenario: 热力图不受筛选影响
- **WHEN** 用户切换智能体或时间范围
- **THEN** 热力图保持全年度全智能体展示不变

### Requirement: 概览统计卡片
系统 SHALL 展示 4 个统计卡片：Token 总用量、会话数量、活跃天数、缓存共享率。卡片数据受智能体筛选和时间范围影响。

#### Scenario: 查看统计卡片
- **WHEN** 用户打开使用统计标签页（默认全部智能体、最近 30 天）
- **THEN** 显示 4 个卡片：
  - Token 总用量（所选范围内所有会话的 token 总和）
  - 会话数量（所选范围内的会话总数）
  - 活跃天数（所选范围内有会话的天数）
  - 缓存共享率（cached_tokens / (input_tokens + cached_tokens) × 100%）

#### Scenario: Token 数据异步加载
- **WHEN** 概览卡片首次加载
- **THEN** 会话数量和活跃天数即时显示（来自 SQL），Token 总量和缓存共享率显示加载状态
- **AND** JSONL 解析完成后更新 Token 数据

### Requirement: 每日 Token 柱状图
系统 SHALL 展示柱状图，按天汇总所选时间范围内的每日 token 使用量，每天一根柱子，分为输入、输出、缓存三段（堆叠或分组）。

#### Scenario: 查看柱状图
- **WHEN** 用户打开使用统计标签页（默认最近 30 天）
- **THEN** 显示柱状图，X 轴为日期，Y 轴为 token 数量
- **AND** 每根柱子展示该日的输入 token（蓝色）、输出 token（绿色）、缓存 token（紫色）三段
- **AND** 悬停柱子显示 tooltip 包含日期和三项 token 明细

#### Scenario: 某日无数据
- **WHEN** 所选时间范围内某天没有任何会话活动
- **THEN** 该日柱子高度为 0 或不显示

### Requirement: 模型统计列表
系统 SHALL 展示按模型分组的统计列表，包含模型名称、会话数、token 总量，按 token 总量降序排列。

#### Scenario: 查看模型列表
- **WHEN** 用户打开使用统计标签页
- **THEN** 显示表格，每行一个模型，列包含：模型名称、会话数、Token 总量
- **AND** 模型列表受智能体筛选和时间范围影响

#### Scenario: 无模型的会话
- **WHEN** 某会话的 model 字段为空
- **THEN** 该会话归入「未知模型」分组

### Requirement: Token 按天聚合（Rust 端）
系统 SHALL 批量解析所选范围内各会话的 JSONL 文件，按天聚合 input/output/cached token。异步执行，不阻塞 UI。

#### Scenario: Claude Code 按天聚合
- **WHEN** 解析 Claude Code 会话的 JSONL 文件
- **THEN** 遍历所有 `assistant` 事件，提取 `timestamp` 和 `message.usage`，按 `DATE(timestamp)` 分组求和

#### Scenario: Codex 按天聚合
- **WHEN** 解析 Codex 会话的 JSONL 文件
- **THEN** 遍历所有 `token_count` 事件，提取 `timestamp` 和 `last_token_usage`，通过相邻轮次差值计算每轮增量，按天聚合

#### Scenario: 会话无 JSONL 文件
- **WHEN** 某会话的 agent JSONL 文件不存在或无法解析
- **THEN** 跳过该会话，不影响其他会话的统计
