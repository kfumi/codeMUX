# 03 — pi 会话最小往返（tracer bullet）

**What to build:** 端到端第一刀：新建会话可选择 pi，发送消息后看到流式文本与思考回复，可中断，turn 正常结束。包含 Rust 侧 pi 薄壳 runtime 与 kind 枚举/工厂的显式 `pi` 分支（未知 kind 的防线上移至 Rust ensure 组装处：`runtime::Provider::from_str` 解析失败即报错，不会静默发往 sidecar）、sidecar piRuntime 会话类与事件映射基础集（text/thinking delta、工具执行 start/end、turn 生命周期、进程退出）、前端 AgentKind/注册表条目与品牌图标、供应商注入最简子集（anthropic 协议端点经环境变量注入 + `--model` 选型；其余端点发送前拦截）。完成即可在真实环境用 pi 对话。

**Blocked by:** 01（传输层与 fake 基建）、02（pi CLI 托管安装）

**Status:** ready-for-agent

- [x] 新建会话智能体选择器出现 pi；带 pi 会话配置发送时不再回落到 Claude runtime
- [x] pi 会话发消息得到流式文本与思考回复，turn 正常完成并产出 Turn Outcome
- [x] 中断正在运行的 turn 生效（abort）
- [x] 工具调用 start/end 按 toolCallId 关联映射为 CodeMUX 工具事件（`tool_execution_update` 在 CodeMUX 协议中无投影目标，本期不投影）
- [x] anthropic 端点供应商凭据经子进程环境变量注入、`--model` 选型生效；不可映射端点发送前拦截且提示可读
- [x] pi 子进程异常退出产生可读错误事件，未完成请求被拒绝
- [x] fake-pi 端到端测试与受影响的存量测试全部通过
