# 07 多智能体铺开与验收

**What to build:** 把电脑控制从主力智能体铺到全部五个：截图回传逐家验证，原生权限门拦截可归因，模型能力矩阵达标，系统级回归有外部基准分数。

**Blocked by:** 06 驱动托管与护栏界面、02 轨迹回放界面

**Status:** 部分完成（代码侧铺开完成，真机验收待联调）

- [ ] MCP 图片回传五个智能体逐家验证并记录结论
- [x] 原生权限门拦截时界面明确归因到具体一家
- [ ] 模型能力矩阵验收：Claude 与 Codex 全闭环、Gemini 基本可用、OpenCode 与 Pi 按模型分级
- [ ] 系统级回归跑 OSWorld 任务子集并记录分数

## Comments

代码侧铺开完成，真机验收项未勾（见能力矩阵文档）。

**铺开时发现并修掉的两个缺口（这两个是真 bug，不是文档问题）：**

1. **认不出的会话 kind 静默丢工具**：内置 MCP 注入条件写的是 kind 字符串白名单，而 `gemini_cli`（及任何未知值）由 `runtime_for_agent_kind` 回退到 `ClaudeCodeRuntime`、sidecar 的 `getRuntimeFlavor` 也回退到 claude —— 这些会话按 Claude 驱动，却拿不到任何内置 MCP 工具。现改为按**解析后的运行时**判断，并加断言防止将来新增运行时漏配。
2. **权限门拦截不归因**：模式拦截事件只报 `reasonCode`，界面显示「协作模式已阻止」，用户不知道是哪一家的门。现在事件带 `gate_agent_kind`/`gate_label`，界面显示「**Codex 的权限门拦截: …**」。

**另修：** 02 票在 `CodeMuxTranscriptMessage` 里把 `useMemo` 放在早退之后（Rules of Hooks 违规，切换紧凑输出时会抛 "Rendered more hooks than during the previous render"）。已把 hook 提到所有 return 之前，`SubagentPreviewPanel` 全套用例通过。

**相机事实**：仓库里只有四个运行时（claude_code / codex / opencode / pi），没有独立的 Gemini 运行时 —— 规格里的「五个智能体」在当前代码里是四个运行时加一个回退路径。能力矩阵文档已按实际记录。

**未做（需真机/外部环境）**：五家截图回传逐家可见性、Claude 与 Codex 的截图→点击→验证闭环、Gemini 基本可用性、OSWorld 子集分数。理由与验收方法写在 `docs/research/2026-10-07-computer-use-capability-matrix.md`。
