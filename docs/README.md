# docs — 项目文档索引与规范

本目录是项目唯一的文档存放处。需求、设计、计划、工单、调研、指南、架构决策统一归档于此,任何 agent(无论 pi / trae / zcode / claude / codex / opencode)产出文档时都必须写入下表对应的目录,**并同步更新本文件的索引**。

## 目录结构与命名

| 目录 | 职责 | 命名规范 |
|---|---|---|
| `adr/` | 架构决策记录(为什么这样设计) | `NNNN-slug.md`,顺序编号取现有最大值 +1 |
| `specs/` | 设计文档 / 需求规格(做什么、为什么、怎么设计) | `YYYY-MM-DD-<slug>.md` |
| `plans/` | 实施计划 / 执行方案(怎么做、分几步) | `YYYY-MM-DD-<slug>.md` |
| `tickets/` | 工单(可执行的实施单元,按 feature 分组) | `tickets/<feature-slug>/<NN>-<slug>.md`,NN 从 01 起 |
| `research/` | 调研笔记(外部方案调研、根因排查) | `YYYY-MM-DD-<slug>.md` |
| `guides/` | 使用 / 运维指南(长期有效的 how-to) | `<topic>-guide.md`,kebab-case |
| `agents/` | 给 agent 的仓库协作约定(issue 追踪方式等) | `<topic>.md`,kebab-case |

约定:

- `<slug>` 用英文 kebab-case;中文标题写在文档 H1。
- 同一 feature 的 spec / plan / tickets 使用相同 `<slug>`,便于互查。
- 日期取文档创建日(git 首次提交日),不是最后修改日。

## 写入路径(对 AI agent 生效,覆盖全局 skill 默认值)

| 场景 | 权威路径 |
|---|---|
| brainstorming / 设计文档 | `docs/specs/YYYY-MM-DD-<slug>.md`(覆盖全局 brainstorming skill 的 `docs/superpowers/specs/`) |
| writing-plans / 实施计划 | `docs/plans/YYYY-MM-DD-<slug>.md`(覆盖全局 writing-plans skill 的 `docs/superpowers/plans/`) |
| to-tickets / wayfinder 工单 | `docs/tickets/<feature-slug>/<NN>-<slug>.md`(repo 内 skill 副本已更新) |
| wayfinder 决策地图 | `docs/plans/YYYY-MM-DD-<effort>-map.md` |
| research / 调研 | `docs/research/YYYY-MM-DD-<slug>.md` |
| 架构决策 | `docs/adr/NNNN-<slug>.md` |
| 使用 / 运维指南 | `docs/guides/<topic>-guide.md` |

历史路径 `docs/superpowers/`、`.scratch/`、`.pi/plan/`、`.zcode/plans/`、`.trae/specs/`、`.trae/documents/` 已退役,不要再写入。

## 索引

### guides

| 文件 | 标题 |
|---|---|
| [agent-provider-profiles-guide.md](guides/agent-provider-profiles-guide.md) | 智能体供应商使用说明 |
| [ai-agent-permission-approval-guide.md](guides/ai-agent-permission-approval-guide.md) | AI Agent 权限审批功能实现总结与指导 |
| [codex-routing-proxy-guide.md](guides/codex-routing-proxy-guide.md) | Codex 路由代理实现指导说明 |
| [desktop-release-guide.md](guides/desktop-release-guide.md) | CodeMUX 桌面端发版指南 |
| [mcp-unified-management-guide.md](guides/mcp-unified-management-guide.md) | MCP 统一管理实现指导说明 |
| [skills-unified-management-guide.md](guides/skills-unified-management-guide.md) | Skills 统一管理实现指导说明 |

### research

| 文件 | 标题 |
|---|---|
| [2026-07-29-opencode-session-summary-display.md](research/2026-07-29-opencode-session-summary-display.md) | OpenCode 会话产物汇总展示 |
| [2026-08-01-claude-opencode-streaming-research.md](research/2026-08-01-claude-opencode-streaming-research.md) | Claude Code 与 OpenCode 流式链路排查记录 |
| [2026-08-02-window-size-persistence-research.md](research/2026-08-02-window-size-persistence-research.md) | 桌面应用窗口尺寸持久化方案调研 |
| [2026-08-05-opencode-session-deletion-research.md](research/2026-08-05-opencode-session-deletion-research.md) | OpenCode 会话删除方案研究 |
| [2026-08-06-runtime-pack-build-dependencies-research.md](research/2026-08-06-runtime-pack-build-dependencies-research.md) | 托管 SDK Runtime 安装方案 |
| [2026-08-09-cherry-studio-model-display-name-rules.md](research/2026-08-09-cherry-studio-model-display-name-rules.md) | Cherry Studio:模型服务获取列表后 UI「模型名字」展示规则（展示名已改由 models.dev 目录提供，见 ADR 0016；本文保留作为 prettify 规则的来源） |
| [2026-08-12-opencode-question-multiselect.md](research/2026-08-12-opencode-question-multiselect.md) | OpenCode 用户问题工具的多选语义调查 |
| [2026-09-06-agent-desktop-busy-send.md](research/2026-09-06-agent-desktop-busy-send.md) | 主流 Agent 桌面 / TUI:忙时发送(queue / steer / interrupt) |
| [2026-09-16-paseo-stream-smoothness-analysis.md](research/2026-09-16-paseo-stream-smoothness-analysis.md) | Paseo 流式对话流畅性归因分析 —— 及对 CodeMUX 的借鉴 |
| [2026-09-16-realtime-chat-jank-root-cause.md](research/2026-09-16-realtime-chat-jank-root-cause.md) | 实时对话掉帧卡顿根因排查报告 |
| [2026-09-16-stream-performance-round4-fixes.md](research/2026-09-16-stream-performance-round4-fixes.md) | 流式性能第四轮:按 Paseo 五道边界实施修复 |
| [2026-09-16-streaming-animation-freeze-fix.md](research/2026-09-16-streaming-animation-freeze-fix.md) | 加载动效大面积失效:真实根因与修复 |
| [2026-09-18-inter-opentype-features-best-practice.md](research/2026-09-18-inter-opentype-features-best-practice.md) | 调研:桌面应用 UI 内置 Inter 的 OpenType 特性(font-feature-settings)最佳实践 |
| [2026-09-21-pi-desktop-performance-cross-reference.md](research/2026-09-21-pi-desktop-performance-cross-reference.md) | 参照 PI-Desktop 的性能改造清单:流式掉帧与空闲卡顿 |
| [2026-09-28-pi-npm-package-migration.md](research/2026-09-28-pi-npm-package-migration.md) | pi npm 包迁移 @mariozechner→@earendil-works:版本停在 0.73.1 的根因、入口路径变化、--mcp-config 变致命、迁移决定 |
| [2026-09-28-codeg-pi-integration-reference.md](research/2026-09-28-codeg-pi-integration-reference.md) | codeg 的 Pi 接入参考:ACP 适配器路线、项目信任门、历史解析纪律与对 CodeMUX 的启发 |
| [2026-09-24-codeg-token-speed-reference.md](research/2026-09-24-codeg-token-speed-reference.md) | codeg 实时 TPS 方案参考与 CodeMUX 差异 |
| [2026-09-24-opencode-storage-performance-audit.md](research/2026-09-24-opencode-storage-performance-audit.md) | OpenCode 存储性能审计 |
| [2026-09-30-turn-artifact-summary-fact-check.md](research/2026-09-30-turn-artifact-summary-fact-check.md) | Turn 级产物汇总事实核查:各 Agent Kind 工具实测、Codex 与 CLI 同步兼容性、真实多卡片实例、两端行数分歧量化、回填否决 |
| [2026-10-07-computer-use-plugin-research.md](research/2026-10-07-computer-use-plugin-research.md) | Agent Computer Use 电脑控制调研与落地建议 |
| [2026-10-07-computer-use-capability-matrix.md](research/2026-10-07-computer-use-capability-matrix.md) | 电脑控制能力矩阵与铺开验收记录（工单 07） |
| [2026-10-09-reference-plugin-method-inventory.md](research/2026-10-09-reference-plugin-method-inventory.md) | 参考插件方法面清单与 CodeMUX 差异（工单 13 附件） |
| [2026-10-10-esc-as-stop-key-assessment.md](research/2026-10-10-esc-as-stop-key-assessment.md) | Esc 作为「停止」键的可行性评估（Ctrl+. 现状、Esc 多义冲突与固定系统键方案） |

### specs

| 文件 | 标题 |
|---|---|
| [2026-05-27-ai-codeMUX.md](specs/2026-05-27-ai-codeMUX.md) | CodeMUX 设计文档 |
| [2026-05-28-claude-agent-sdk-integration.md](specs/2026-05-28-claude-agent-sdk-integration.md) | Claude Agent SDK Integration Design |
| [2026-05-28-multi-provider-agent.md](specs/2026-05-28-multi-provider-agent.md) | Multi-Provider Agent Mode Design |
| [2026-05-28-streaming-markdown-preview.md](specs/2026-05-28-streaming-markdown-preview.md) | 流式输出 + Markdown 渲染 + 代码预览面板 设计文档 |
| [2026-05-30-file-preview.md](specs/2026-05-30-file-preview.md) | File Preview & Code Diff Design Spec |
| [2026-06-06-skills-management.md](specs/2026-06-06-skills-management.md) | Skills 管理与使用系统设计 |
| [2026-06-07-changed-files-panel.md](specs/2026-06-07-changed-files-panel.md) | Changed Files Panel Design |
| [2026-06-08-assistant-ui-runtime-adapter.md](specs/2026-06-08-assistant-ui-runtime-adapter.md) | assistant-ui Runtime Adapter Migration Design |
| [2026-06-10-multi-agent-codex-integration.md](specs/2026-06-10-multi-agent-codex-integration.md) | Multi-Agent Runtime and Codex Integration Design |
| [2026-06-12-codex-proxy-alignment.md](specs/2026-06-12-codex-proxy-alignment.md) | Codex 代理对齐 CC Switch 指导文档 — 设计方案 |
| [2026-06-13-mcp-management-refactor.md](specs/2026-06-13-mcp-management-refactor.md) | MCP 统一管理重构设计 |
| [2026-06-29-agent-permission-approval-alignment.md](specs/2026-06-29-agent-permission-approval-alignment.md) | Agent Permission Approval Alignment Design |
| [2026-07-01-codex-strict-local-plan-mode.md](specs/2026-07-01-codex-strict-local-plan-mode.md) | Codex Strict-Local Plan Mode Design |
| [2026-07-01-updater-mechanism.md](specs/2026-07-01-updater-mechanism.md) | CodeMUX 软件更新机制设计 |
| [2026-07-03-agent-system-notifications.md](specs/2026-07-03-agent-system-notifications.md) | AI 任务系统通知与提示音设计 |
| [2026-07-03-git-branch-management.md](specs/2026-07-03-git-branch-management.md) | Git 分支管理与审查提交流程设计 |
| [2026-07-11-codex-skill-path.md](specs/2026-07-11-codex-skill-path.md) | Codex 技能完整路径设计 |
| [2026-07-11-history-file-context-usage.md](specs/2026-07-11-history-file-context-usage.md) | 基于历史文件的上下文统计展示重构设计 |
| [2026-07-12-opencode-sdk-agent.md](specs/2026-07-12-opencode-sdk-agent.md) | OpenCode 官方 SDK Agent 接入设计 |
| [2026-07-14-agent-provider-profile-refactor.md](specs/2026-07-14-agent-provider-profile-refactor.md) | 智能体专属供应商档案重构设计 |
| [2026-07-15-claude-code-supplier-config.md](specs/2026-07-15-claude-code-supplier-config.md) | Claude Code 供应商配置重构设计 |
| [2026-07-15-model-selector-replacement.md](specs/2026-07-15-model-selector-replacement.md) | Model Selector Replacement Design |
| [2026-07-23-add-usage-statistics.md](specs/2026-07-23-add-usage-statistics.md) | 使用统计与活跃热力图 Spec |
| [2026-07-23-dev-performance-diagnostics.md](specs/2026-07-23-dev-performance-diagnostics.md) | 开发期全栈性能诊断集成设计 |
| [2026-07-25-enhance-agent-runtime-detection.md](specs/2026-07-25-enhance-agent-runtime-detection.md) | 智能体运行时检测与升级功能增强 Spec |
| [2026-08-05-codemux-managed-sdk-runtime.md](specs/2026-08-05-codemux-managed-sdk-runtime.md) | CodeMUX 托管 SDK Runtime 规格 |
| [2026-08-08-conversation-fork.md](specs/2026-08-08-conversation-fork.md) | CodeMUX 对话 Fork 分支功能需求与实现记录 |
| [2026-08-08-project-scoped-agent-skills.md](specs/2026-08-08-project-scoped-agent-skills.md) | 按 Agent 加载项目级 Skills 设计 |
| [2026-08-16-companion-pairing-evolution.md](specs/2026-08-16-companion-pairing-evolution.md) | Companion 配对与连接能力演进(全阶段) |
| [2026-08-19-terminal-session-persistence.md](specs/2026-08-19-terminal-session-persistence.md) | 会话终端保活与视图持久化 |
| [2026-08-22-codex-app-server-migration.md](specs/2026-08-22-codex-app-server-migration.md) | Codex 完全迁移至 App Server |
| [2026-08-23-rewind-to-any-user-message.md](specs/2026-08-23-rewind-to-any-user-message.md) | 对话回退至任意用户消息(Rewind to Any User Message) |
| [2026-08-25-session-timeline-refactor.md](specs/2026-08-25-session-timeline-refactor.md) | Session Timeline 重构设计(Paseo 式简化) |
| [2026-08-27-scheduled-tasks.md](specs/2026-08-27-scheduled-tasks.md) | 定时任务(Scheduled Task)规格(设计正本) |
| [2026-08-28-scheduled-tasks.md](specs/2026-08-28-scheduled-tasks.md) | 定时任务(Scheduled Task)(工单工作副本,含 Status/Comments) |
| [2026-08-28-subagent-streaming-preview.md](specs/2026-08-28-subagent-streaming-preview.md) | 子智能体独立时间线与实时预览 |
| [2026-09-01-shared-transcript-message-renderer.md](specs/2026-09-01-shared-transcript-message-renderer.md) | 主/子智能体共享消息行渲染 |
| [2026-09-01-turn-artifact-summary.md](specs/2026-09-01-turn-artifact-summary.md) | Turn 级产物汇总(Agent Artifact Summary)(已被 2026-09-30 v2 取代) |
| [2026-09-02-built-in-browser.md](specs/2026-09-02-built-in-browser.md) | 内置浏览器(Side Panel Browser) |
| [2026-09-03-pi-agent-integration.md](specs/2026-09-03-pi-agent-integration.md) | pi 接入为第四智能体 |
| [2026-09-07-daemon-boundary.md](specs/2026-09-07-daemon-boundary.md) | 抽出 Daemon 边界(桌面改走 Companion 协议) |
| [2026-09-11-electron-shell-swap.md](specs/2026-09-11-electron-shell-swap.md) | 拆出 Daemon 进程,桌面壳换 Electron |
| [2026-09-13-unified-frontend.md](specs/2026-09-13-unified-frontend.md) | 统一前端——桌面 / 网页 / 移动共用一套渲染层连 daemon |
| [2026-09-18-long-session-render-scale.md](specs/2026-09-18-long-session-render-scale.md) | 长会话渲染规模:让开销只与"正在看的那一段"成正比 |
| [2026-09-20-codex-collab-subagent-parity.md](specs/2026-09-20-codex-collab-subagent-parity.md) | Codex 协作子智能体:两种 spawn 变体的声明与轨道对等 |
| [2026-09-21-agent-task-board.md](specs/2026-09-21-agent-task-board.md) | 工作任务看板(Work Task):agent 驱动的委派与验收 |
| [2026-09-30-turn-artifact-summary-v2.md](specs/2026-09-30-turn-artifact-summary-v2.md) | Turn 级产物汇总 v2:跨 Agent Kind 的解析统一(取代 2026-09-01) |
| [2026-10-07-computer-use.md](specs/2026-10-07-computer-use.md) | 电脑控制（Computer Use） |
| [2026-10-10-computer-use-activity-authority-in-daemon.md](specs/2026-10-10-computer-use-activity-authority-in-daemon.md) | 电脑控制活动权威与急停上移到 Daemon（ADR 0018 的实现基线） |

### plans

| 文件 | 标题 |
|---|---|
| [2026-05-27-codeMUX-implementation.md](plans/2026-05-27-codeMUX-implementation.md) | CodeMUX 实现计划 |
| [2026-05-28-claude-agent-sdk-integration.md](plans/2026-05-28-claude-agent-sdk-integration.md) | Claude Agent SDK Integration Implementation Plan |
| [2026-05-28-multi-provider-agent.md](plans/2026-05-28-multi-provider-agent.md) | Multi-Provider Agent Mode Implementation Plan |
| [2026-05-28-streaming-markdown-preview.md](plans/2026-05-28-streaming-markdown-preview.md) | 流式输出 + Markdown 渲染 + 代码预览面板 实现计划 |
| [2026-05-30-file-preview.md](plans/2026-05-30-file-preview.md) | File Preview & Code Diff Implementation Plan |
| [2026-06-06-skills-management.md](plans/2026-06-06-skills-management.md) | Skills 管理与使用系统 Implementation Plan |
| [2026-06-08-assistant-ui-runtime-adapter.md](plans/2026-06-08-assistant-ui-runtime-adapter.md) | assistant-ui Runtime Adapter Implementation Plan |
| [2026-06-10-multi-agent-codex-implementation.md](plans/2026-06-10-multi-agent-codex-implementation.md) | Multi-Agent Codex Integration Implementation Plan |
| [2026-06-12-codex-proxy-alignment.md](plans/2026-06-12-codex-proxy-alignment.md) | Codex 代理对齐 CC Switch 指导文档 — 实现计划 |
| [2026-06-13-mcp-management-refactor.md](plans/2026-06-13-mcp-management-refactor.md) | MCP 统一管理重构 Implementation Plan |
| [2026-06-29-agent-permission-approval-alignment.md](plans/2026-06-29-agent-permission-approval-alignment.md) | Agent Permission Approval Alignment Implementation Plan |
| [2026-07-01-codex-strict-local-plan-mode.md](plans/2026-07-01-codex-strict-local-plan-mode.md) | Codex Strict-Local Plan Mode Implementation Plan |
| [2026-07-01-updater-mechanism.md](plans/2026-07-01-updater-mechanism.md) | Updater Mechanism Implementation Plan |
| [2026-07-03-agent-system-notifications.md](plans/2026-07-03-agent-system-notifications.md) | AI 任务系统通知与提示音 Implementation Plan |
| [2026-07-04-git-branch-management.md](plans/2026-07-04-git-branch-management.md) | Git Branch Management Implementation Plan |
| [2026-07-11-codex-skill-path.md](plans/2026-07-11-codex-skill-path.md) | Codex 技能完整路径实现计划 |
| [2026-07-11-history-file-context-usage.md](plans/2026-07-11-history-file-context-usage.md) | 基于历史文件的上下文统计展示 Implementation Plan |
| [2026-07-12-opencode-sdk-agent.md](plans/2026-07-12-opencode-sdk-agent.md) | OpenCode SDK Agent 接入实施计划 |
| [2026-07-14-agent-provider-profile-refactor.md](plans/2026-07-14-agent-provider-profile-refactor.md) | 智能体专属供应商档案重构实施计划 |
| [2026-07-15-agent-provider-profile-commands.md](plans/2026-07-15-agent-provider-profile-commands.md) | 智能体供应商档案命令实现计划 |
| [2026-07-15-agent-provider-profile-quality-remediation.md](plans/2026-07-15-agent-provider-profile-quality-remediation.md) | 智能体供应商档案质量修复实施计划 |
| [2026-07-15-claude-code-supplier-config.md](plans/2026-07-15-claude-code-supplier-config.md) | Claude Code 供应商配置实现计划 |
| [2026-07-15-model-selector-replacement.md](plans/2026-07-15-model-selector-replacement.md) | Model Selector Replacement Implementation Plan |
| [2026-07-23-dev-performance-diagnostics.md](plans/2026-07-23-dev-performance-diagnostics.md) | 开发期全栈性能诊断集成 Implementation Plan |
| [2026-08-07-codemux-owned-model-providers.md](plans/2026-08-07-codemux-owned-model-providers.md) | CodeMUX 自维护 Model Provider 实现计划 |
| [2026-08-07-turn-timeout-policy.md](plans/2026-08-07-turn-timeout-policy.md) | Turn Timeout & Interactive Request Policy Implementation Plan |
| [2026-08-16-companion-pairing-evolution-map.md](plans/2026-08-16-companion-pairing-evolution-map.md) | Companion 配对与连接能力演进 — Wayfinder Map |
| [2026-08-17-mobile-chat-parity.md](plans/2026-08-17-mobile-chat-parity.md) | Mobile Chat Desktop Parity Implementation Plan |
| [2026-08-18-review-panel-codex-layout.md](plans/2026-08-18-review-panel-codex-layout.md) | Codex 风格审查面板布局实施计划 |
| [2026-08-19-create-pull-request-forges.md](plans/2026-08-19-create-pull-request-forges.md) | 跨平台创建 Pull Request 实施计划 |
| [2026-08-30-openai-responses-protocol-endpoint.md](plans/2026-08-30-openai-responses-protocol-endpoint.md) | 新增 `openai_responses` 协议端点,Codex 直连 Responses 接口 |
| [2026-09-15-session-title-sync.md](plans/2026-09-15-session-title-sync.md) | 会话标题自动同步(底层标题 → CodeMUX) |
| [2026-09-18-rewind-stream-render-perf-batch2.md](plans/2026-09-18-rewind-stream-render-perf-batch2.md) | 长线程 rewind / 流式渲染性能优化(第二批) |
| [2026-09-19-pi-message-display-alignment.md](plans/2026-09-19-pi-message-display-alignment.md) | pi 桌面对话消息展示对齐(工具/思考分组/计时/状态/间距/Markdown) |
| [2026-09-28-pi-agent-integration-optimizations.md](plans/2026-09-28-pi-agent-integration-optimizations.md) | pi 接入优化(codeg 对照走查与本机实测):思考档位静默失效、视觉附件被丢弃、项目信任显式化 |

### tickets(按 feature 分组)

| Feature | 工单数 | 对应 spec |
|---|---|---|
| [add-usage-statistics](tickets/add-usage-statistics/) | 2 | [2026-07-23](specs/2026-07-23-add-usage-statistics.md) |
| [agent-task-board](tickets/agent-task-board/) | 4 | [2026-09-21](specs/2026-09-21-agent-task-board.md) |
| [codemux-managed-sdk-runtime](tickets/codemux-managed-sdk-runtime/) | 7 | [2026-08-05](specs/2026-08-05-codemux-managed-sdk-runtime.md) |
| [codex-app-server-migration](tickets/codex-app-server-migration/) | 13 | [2026-08-22](specs/2026-08-22-codex-app-server-migration.md) |
| [codex-collab-subagent-parity](tickets/codex-collab-subagent-parity/) | 3 | [2026-09-20](specs/2026-09-20-codex-collab-subagent-parity.md) |
| [companion-pairing-evolution](tickets/companion-pairing-evolution/) | 9 | [2026-08-16](specs/2026-08-16-companion-pairing-evolution.md) + [map](plans/2026-08-16-companion-pairing-evolution-map.md) |
| [computer-use](tickets/computer-use/) | 19 | [2026-10-07](specs/2026-10-07-computer-use.md) |
| [daemon-boundary](tickets/daemon-boundary/) | 12 | [2026-09-07](specs/2026-09-07-daemon-boundary.md) |
| [electron-shell-swap](tickets/electron-shell-swap/) | 9 | [2026-09-11](specs/2026-09-11-electron-shell-swap.md) |
| [enhance-agent-runtime-detection](tickets/enhance-agent-runtime-detection/) | 2 | [2026-07-25](specs/2026-07-25-enhance-agent-runtime-detection.md) |
| [long-session-render-scale](tickets/long-session-render-scale/) | 3 | [2026-09-18](specs/2026-09-18-long-session-render-scale.md) |
| [pi-agent-integration](tickets/pi-agent-integration/) | 12 | [2026-09-03](specs/2026-09-03-pi-agent-integration.md) |
| [project-scoped-agent-skills](tickets/project-scoped-agent-skills/) | 3 | [2026-08-08](specs/2026-08-08-project-scoped-agent-skills.md) |
| [rewind-any-message](tickets/rewind-any-message/) | 3 | [2026-08-23](specs/2026-08-23-rewind-to-any-user-message.md) |
| [turn-artifact-summary](tickets/turn-artifact-summary/) | 3 | [2026-09-30](specs/2026-09-30-turn-artifact-summary-v2.md)(取代 [2026-09-01](specs/2026-09-01-turn-artifact-summary.md)) |
| [unified-frontend](tickets/unified-frontend/) | 4 | [2026-09-13](specs/2026-09-13-unified-frontend.md) |

### adr

架构决策记录见 [adr/](adr/),当前 0002–0014,格式与编号规则见 [domain-modeling skill 的 ADR-FORMAT](../.agents/skills/domain-modeling/ADR-FORMAT.md)。

近期记录:

- [0011 — Daemon 权威与 Local Daemon Token](adr/0011-daemon-authority-local-token.md)
- [0012 — Daemon 独立进程与 Electron 桌面壳](adr/0012-daemon-process-electron-shell.md)
- [0013 — 用户可配置键盘快捷键](adr/0013-user-configurable-keyboard-shortcuts.md)
- [0014 — pi 项目资源默认不信任](adr/0014-pi-project-resources-untrusted-by-default.md)
- [0015 — 模型能力目录只是建议，provider.models 始终是权威](adr/0015-model-catalog-is-advisory.md)
- [0016 — 模型展示名来自目录，手写映射表退役](adr/0016-model-display-names-from-catalog.md)
- [0017 — OpenCode 免费模型以虚拟供应商进入选择器，发送走原生 opencode provider](adr/0017-opencode-free-models-virtual-provider.md)
- [0018 — 电脑控制「正在驱动」与急停的权威移入 daemon，壳退化为显示/输入适配器](adr/0018-computer-use-activity-authority-in-daemon.md)

### agents

| 文档 | 用途 |
|---|---|
| [issue-tracker](agents/issue-tracker.md) | 本仓库的 issue 追踪约定:spec 与 ticket 的落盘位置、状态与评论写法,以及 skill 提到 "publish to the issue tracker" 时的处理方式 |
