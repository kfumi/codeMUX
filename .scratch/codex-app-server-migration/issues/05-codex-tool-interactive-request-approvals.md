# 05 — Codex 工具级 Interactive Request 审批

**What to build:** App-server server-initiated approval 请求（命令执行、文件变更、用户问答、MCP elicitation）桥接到 CodeMUX Interactive Request 模型；桌面用户可在 PermissionApprovalCard / AskUserQuestionCard 响应；`respond_to_permission` sidecar 命令对 Codex 生效，解挂后 agent 在同一 turn 内继续或中止。

**Blocked by:** 03 — 官方上游基础 Codex turn

**Status:** ready-for-agent

- [x] 注册并处理 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput`（及别名）
- [x] MCP elicitation：可选 form 可响应；url 或必填字段策略性 decline
- [x] emit `permission_requested`（及问答 timeline 等价物）；用户响应 resolve app-server request Promise
- [x] sidecar `respond_to_permission` 新增 Codex 分支（Claude/OpenCode 行为不变）
- [x] Interactive Request 挂起期间符合 ADR 0004 空闲守卫策略（不误判 Engine Stall 超时）
- [x] fake-app-server 单测覆盖 approve / deny / cancel 路径
