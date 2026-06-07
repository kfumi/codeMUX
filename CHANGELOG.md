# Changelog

本项目所有重要变更将记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- 初始开源版本准备中

## [0.1.0] - 2026-06-07

### Added
- Agent 对话面板，基于 Claude Agent SDK，支持流式响应
- 流式 Markdown 渲染，支持 GFM 语法高亮、表格、原始 HTML
- 工具调用可视化卡片，展示工具名称、参数和执行结果
- Thinking 思考块（可折叠）
- 终端输出块（终端风格渲染）
- Diff 代码对比块（统一 Diff 格式 + 语法高亮）
- Todo 列表组件，支持进度状态实时更新
- 交互式提问卡片（选项选择 + 自由文本）
- 多提供商配置：Anthropic、OpenAI 兼容端点、DeepSeek
- 每个提供商独立 API Key、Base URL、默认模型配置
- 提供商连通性测试与延迟显示
- 模型列表自动拉取
- Token 用量与费用统计（输入/缓存读取/输出 分别计价）
- MCP 服务器管理：增删改查界面
- MCP 三种传输协议支持：stdio、HTTP Streaming、SSE
- MCP 配置向导（图形化参数填写）
- MCP 启动自动探测连通性，状态指示灯
- MCP 配置双写（SQLite + `~/.claude.json`，兼容 Claude CLI）
- Skills 技能系统：从 GitHub 仓库浏览安装
- 内置技能：`find-skills`、`skill-creator`
- Skills 斜杠命令调用
- Skills 启用/禁用/卸载管理
- 文件预览面板：文件树浏览器、文件内容查看器、统一 Diff 视图
- 会话与项目管理：多会话按项目分组、重命名、删除
- 主题系统：亮色 / 暗色 / 跟随系统
- 上下文窗口进度条
- 斜杠命令系统：内置命令 + 自定义命令 + 技能命令，支持中文别名
- 自定义标题栏（frameless 窗口）
- SQLite 本地数据持久化（会话、消息、MCP、Skills）
- Windows / macOS / Linux 跨平台支持

---

## 版本说明

- **Added** — 新功能
- **Changed** — 已有功能的变更
- **Deprecated** — 即将移除的功能
- **Removed** — 已移除的功能
- **Fixed** — Bug 修复
- **Security** — 安全相关
