# 04 — pi 模型目录、切换、思考等级与供应商全量映射

**What to build:** pi 会话的模型体验补全：模型下拉来自 pi `get_available_models` 并与 CodeMUX Model Provider 协议端点匹配；会话内切换模型经 `set_model` 即时生效；思考等级七档（off/minimal/low/medium/high/xhigh/max，默认 medium）可选并随会话记忆；openai_compatible 协议端点的环境变量注入补全，不可映射供应商的发送前拦截规则全量落地。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] 模型目录按当前供应商协议端点过滤/映射后展示
- [ ] 会话内切换模型即时生效（set_model），失败时透传 pi 可读错误
- [ ] 思考等级选择生效（set_thinking_level），默认 medium，随 Kind Model Selection 记忆
- [ ] openai_compatible 端点凭据注入生效；不可映射供应商发送前拦截
- [ ] 空 Key 不回落 `~/.pi` 自身认证（ADR 0005）
- [ ] fake-pi 测试覆盖模型/思考等级 RPC 往返；受影响测试通过
