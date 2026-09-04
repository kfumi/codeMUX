# 09 — pi 审批与 ask-user（二期）

**What to build:** pi 会话的交互能力：经运行时生成的临时扩展（`--extension` 注入，会话关闭清理）实现①工具审批——扩展内 `pi.on("tool_call")` 按档位拦截 bash/edit/write，`ctx.ui.select` 等待用户，RPC 模式下自动序列化为 `extension_ui_request`，sidecar 以 title marker（`__codemux_approve__:`）识别语义并映射为 CodeMUX `permission_requested`，用户回答经 `extension_ui_response` 回包（"始终允许"由扩展内存记会话级规则）；②ask-user——扩展 `pi.registerTool("ask_user_question")`（单选/自由文本，0.73.1 ui.select 无多选），顺序对话框被 sidecar 合并为一张 `user_input_requested` 提问卡（title marker `__codemux_ask__:` + tool_execution_start 跟踪的 questions），答案按到达顺序逐个续喂。权限档位映射 CodeMUX 现有 execution mode（confirm_before_edit→bash/edit/write、auto_edit→仅 bash、full_access→全放行；plan 对 pi 不适用），档位变更经 canReuse 比对重建 pi 进程（与模型/思考等级同机制）。挂起请求在 turn 结束/进程退出/会话关闭时统一 cancelled + `permission_resolved` 撤卡；非 CodeMUX 注入的对话框直接取消（宁严勿挂）。

**Blocked by:** 07

**Status:** done

- [x] 临时扩展模块（piExtension.ts：档位策略、源码模板、mkdtemp 生命周期、marker 解析纯函数）
- [x] PiRpcTransport 增加 notify（裸发帧回 extension_ui_response，pi 按 frame id 匹配）
- [x] PiRuntime 交互桥：extension_ui_request 拦截、pending 表、respondToPermission/respondToQuestion/isPendingQuestion、三路径清理
- [x] dispatcher 打通：tool_response / respond_to_permission 的 pi 路由（删除三处 pi 显式拒绝）；Rust 层零改动
- [x] 档位映射：SidecarPermissionConfig/AgentPermissionConfig 增 pi kind（旧 claude_code 快照迁移到确认档）；canReuse 含 approvalMode
- [x] 前端：注册表 pi 增 supports_ask_user_question；AgentPermissionSelector pi 分支（修复此前误显示 Claude 档位）；计划模式入口本就 codex 专属
- [x] fake-pi 支持 awaitResponse/holdUntilAbort；测试覆盖审批 once/reject、提问合并卡、未知对话框取消、shutdown 清理、canReuse；sidecar 全量 578 三轮全绿
- [x] 存量 flake 修复：`marks the turn interrupted` 的 pendingTurn 赋值早于 get_session_stats 往返的竞态（改为等 prompt 受理回执再中断）
- [x] 根全量套件无新增失败（5 个存量红文件经 stash 基线核对一致）；前端相关测试全绿
