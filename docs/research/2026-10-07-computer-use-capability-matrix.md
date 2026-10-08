# 电脑控制能力矩阵与铺开验收记录

**日期:** 2026-10-07
**范围:** computer-use 工单 07（多智能体铺开与验收）
**配套文档:** [spec](../specs/2026-10-07-computer-use.md) · [调研](./2026-10-07-computer-use-plugin-research.md) · [工单](../tickets/computer-use/)

## 一、能力矩阵

| 智能体 | 运行时 | 内置 MCP 注入 | 图片回传（协议层） | 权限门归因 | 端到端演示 |
|---|---|---|---|---|---|
| Claude Code | `ClaudeCodeRuntime` | 已覆盖（`mcpServers` → SDK） | 已覆盖（MCP `image` content） | 已覆盖（`gate_label`） | **待真机** |
| Codex | `CodexRuntime` | 已覆盖（app-server 配置） | 已覆盖（待真机确认渲染） | 走原生审批请求（不静默失败） | **待真机** |
| OpenCode | `OpenCodeRuntime` | 已覆盖（SDK mcp 配置） | 已覆盖（待真机确认渲染） | 走原生审批请求 | **待真机** |
| pi | `PiRuntime` | 已覆盖（合并用户 DB 配置） | 已覆盖（待真机确认渲染） | 走原生审批请求 | **待真机** |
| Gemini CLI | **无独立运行时：回退 `ClaudeCodeRuntime`** | 已覆盖（本次修复，见下） | 同 Claude 路径 | 已覆盖 | **待真机（且运行时待补）** |

「图片回传（协议层）」= 内置 MCP server 返回的是标准 MCP `image` content（base64 PNG + `mimeType`），四个运行时都消费同一份 `mcpServers` 注入面。**模型侧能不能真的"看见"图片，属于真机验收项，本表不代它背书。**

## 二、铺开时发现并修掉的两个缺口

1. **认不出的会话 kind 静默丢工具**：注入条件原为 `matches!(agent_kind, "pi" | "claude_code" | "codex" | "opencode")`，而 `gemini_cli`（以及任何未知值）由 `runtime_for_agent_kind` 回退到 `ClaudeCodeRuntime`、sidecar 的 `getRuntimeFlavor` 也回退到 claude —— 结果是这些会话按 Claude 驱动，却拿不到任何内置 MCP 工具。现改为按**解析后的运行时**判断（`mcp_tooling_applies_to`），并有断言防止将来新增运行时漏配。

2. **权限门拦截不归因**：模式拦截事件（`mode_blocked`）原先只报 `reasonCode`，界面显示"协作模式已阻止"，用户不知道是哪一家的门。现在事件带 `gate_agent_kind` / `gate_label`（`permissionGateFor`，未知值按 Claude 记），界面显示"**Codex 的权限门拦截: …**"。

## 三、尚未验收的项（不许勾）

以下是需要真机 / 外部基准的验收项，本环境无法完成，留给 `npm run dev:desktop` 联调：

| 项 | 为什么没做 | 怎么验 |
|---|---|---|
| 浏览器填表端到端演示（工单 01/02 遗留） | 需要真实模型 + 真实页面 | 打开内置浏览器 → 让智能体填一张表单 → 看轨迹回放 |
| 智能体看报错截图复述现场（04） | 同上 | 复现一个报错窗口 → 让智能体 `computer_screenshot` 并复述 |
| Claude / Codex 截图→点击→验证闭环（05） | 需要真实驱动 + 真实模型 | 配置驱动命令 → 启动 → 让 Claude/Codex 各跑一遍 |
| MCP 图片回传逐家可见性（07） | 需要五个真实智能体 | 每家发一次 `browser_screenshot`，确认模型复述画面内容 |
| 系统级回归 OSWorld 任务子集（07） | 需要 Windows VM + OSWorld 跑分环境 | 见下方「OSWorld 说明」 |

**OSWorld 说明**：本期没有引入基准跑分设施。要做的话最小路径是：单独一台 Windows VM、按 OSWorld 官方说明装好评测端、把驱动配置成 `computer_use.driver_command`、跑官方子集并把分数回填本表。CodeMUX 侧不需要为它改代码（驱动协议面就是 stdio MCP）。

## 四、写这一页时确认过的事实

- 内置 MCP server 的工具面覆盖 13 个 op（10 个浏览器级 + 3 个桌面只读），`tools_list_covers_all_execute_ops` 断言工具清单与 op 集合对得上。
- 驱动宿主可用真实子进程完成 stdio MCP 握手并列出工具、急停能在 1 秒内杀掉进程（`crates/daemon/tests/computer_use_driver.rs`）。
- 电脑控制设置页在 daemon 不可达时仍显示不可删除的内置拒绝范围（组件测试覆盖）。
