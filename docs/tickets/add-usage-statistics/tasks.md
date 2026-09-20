# Tasks

- [x] Task 1: 新增 sessions 表聚合查询函数
  - [x] SubTask 1.1: 在 `src-tauri/src/db/operations.rs` 新增 `UsageHeatmapDay { date, count }` 结构体和 `get_usage_heatmap` 函数，按 `DATE(created_at)` 聚合全年度每日会话数
  - [x] SubTask 1.2: 新增 `UsageOverview { total_sessions, active_days }` 结构体和 `get_usage_overview` 函数（支持 agent_kind 和 days 参数过滤）
  - [x] SubTask 1.3: 新增 `AgentDistribution { agent_kind, count }` 结构体和 `get_agent_distribution` 函数（支持 days 参数过滤）
  - [x] SubTask 1.4: 新增 `ModelDistribution { model, session_count }` 结构体和 `get_model_distribution` 函数（支持 agent_kind 和 days 参数过滤）
  - [x] SubTask 1.5: 添加 Rust 单元测试验证聚合查询与过滤

- [x] Task 2: 新增 Tauri 命令模块 `usage.rs`
  - [x] SubTask 2.1: 创建 `src-tauri/src/commands/usage.rs`，实现 `get_usage_stats` 命令（参数: agent_kind: Option<String>, days: u32）→ 返回 `{ heatmap, overview, agent_distribution, model_distribution }`，全部来自 sessions 表即时查询
  - [x] SubTask 2.2: 实现 `get_usage_token_breakdown` 命令（参数: agent_kind: Option<String>, days: u32）→ 异步批量解析 JSONL：
    - 查询符合条件（agent_kind + days）的 sessions 及其 agent_session_mappings
    - 对每个 session 复用 `find_claude_session_jsonl` / `find_codex_session_jsonl` / opencode_history 定位文件
    - Claude Code: 遍历 assistant 事件提取 timestamp + message.usage，按天求和
    - Codex: 遍历 token_count 事件提取 timestamp + last_token_usage，相邻轮次差值计算增量，按天求和
    - OpenCode: 遍历事件提取 timestamp + per-event usage，按天求和
    - 返回 `{ daily: Vec<{ date, input_tokens, output_tokens, cached_tokens }>, total: { input_tokens, output_tokens, cached_tokens, total_tokens, cache_rate } }`
  - [x] SubTask 2.3: 在 `src-tauri/src/commands/mod.rs` 中导出 `usage` 模块
  - [x] SubTask 2.4: 在 `src-tauri/src/lib.rs` 的 `generate_handler!` 中注册两个新命令

- [x] Task 3: 前端 Tauri API 封装与类型定义
  - [x] SubTask 3.1: 在 `src/lib/tauri.ts` 新增 `usageApi`，包含 `getStats(agentKind, days)` 和 `getTokenBreakdown(agentKind, days)` 方法
  - [x] SubTask 3.2: 新增 TypeScript 类型定义：`UsageStats`（heatmap + overview + agentDistribution + modelDistribution）、`TokenBreakdown`（daily + total）、`AgentKind` 枚举

- [x] Task 4: 新增热力图子组件 `UsageHeatmap.tsx`
  - [x] SubTask 4.1: 创建 `src/components/settings/UsageHeatmap.tsx`，接收 `data: UsageHeatmapDay[]` prop
  - [x] SubTask 4.2: 实现 GitHub 风格 53 列 × 7 行网格布局，颜色分 5 级（0 / 1-2 / 3-5 / 6-9 / 10+），使用 CSS variable 适配主题
  - [x] SubTask 4.3: 实现悬停 tooltip 显示日期 + 会话数
  - [x] SubTask 4.4: 添加月份标签和星期标签

- [x] Task 5: 新增每日 token 柱状图子组件 `UsageBarChart.tsx`
  - [x] SubTask 5.1: 创建 `src/components/settings/UsageBarChart.tsx`，接收 `data: DailyTokenBreakdown[]` prop
  - [x] SubTask 5.2: 实现堆叠柱状图，每根柱子分输入（蓝色）、输出（绿色）、缓存（紫色）三段
  - [x] SubTask 5.3: 实现 X 轴日期标签（自适应间隔避免重叠）、Y 轴 token 数量标签
  - [x] SubTask 5.4: 实现悬停 tooltip 显示日期 + 三项 token 明细
  - [x] SubTask 5.5: 纯 CSS/SVG 实现，不引入第三方图表库

- [x] Task 6: 新增「使用统计」设置面板主组件 `UsageStatistics.tsx`
  - [x] SubTask 6.1: 创建 `src/components/settings/UsageStatistics.tsx` 主组件
  - [x] SubTask 6.2: 实现智能体下拉筛选（Select 组件：全部 / Claude Code / Codex / Gemini / OpenCode）和时间范围 ToggleGroup（最近 7 天 / 最近 30 天，默认 30 天）
  - [x] SubTask 6.3: 实现概览卡片区域（4 个卡片：Token 总用量、会话数量、活跃天数、缓存共享率），会话数和活跃天数即时显示，token 数据显示加载状态
  - [x] SubTask 6.4: 嵌入 `UsageHeatmap` 组件（全年度，不受筛选影响）
  - [x] SubTask 6.5: 嵌入 `UsageBarChart` 组件（受筛选影响，异步加载）
  - [x] SubTask 6.6: 实现模型统计列表（表格：模型名称、会话数、Token 总量，按 token 降序），token 列异步加载
  - [x] SubTask 6.7: 使用 `FormSection` 组件风格保持与其他设置面板一致
  - [x] SubTask 6.8: 智能体或时间范围切换时重新加载数据，token 相关区域重新显示加载状态

- [x] Task 7: 注册使用统计标签页
  - [x] SubTask 7.1: 在 `src/components/settings/SettingsDialog.tsx` 的 `SettingsTab` 类型中添加 `'usage'`
  - [x] SubTask 7.2: 在 `primaryTabs` 数组中添加「使用统计」标签项（使用 `BarChart3` 图标）
  - [x] SubTask 7.3: 在渲染区域添加条件渲染 `activeTab === 'usage' && <UsageStatistics />`

- [x] Task 8: 构建验证与测试
  - [x] SubTask 8.1: 运行 `cd src-tauri && cargo fmt --all -- --check` 验证格式
  - [x] SubTask 8.2: 运行 `cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings` 验证 lint
  - [x] SubTask 8.3: 运行 `cd src-tauri && cargo check --all-targets --all-features` 验证编译
  - [x] SubTask 8.4: 运行 `npm run build` 验证前端编译

# Task Dependencies
- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 2]
- [Task 4] 和 [Task 5] 无相互依赖，可并行
- [Task 6] depends on [Task 3] 和 [Task 4] 和 [Task 5]
- [Task 7] depends on [Task 6]
- [Task 8] depends on [Task 1-7]
