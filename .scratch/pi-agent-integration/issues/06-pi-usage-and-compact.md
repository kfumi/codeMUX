# 06 — pi 用量统计与手动压缩

**What to build:** pi 会话的用量与上下文管理：`get_session_stats` 轮询接入 token 用量（input/cacheRead/output）、成本与 contextWindow 占用，进入 CodeMUX 用量统计；`/compact`（可带自定义指令）映射 pi 原生 compact RPC，压缩过程与完成以时间线条目呈现；旧版 pi 缺 `get_session_stats` 时回退 `get_state.contextUsage`。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] turn 边界触发的用量轮询生效，token/cost 进入用量统计页
- [ ] 上下文占用（tokens / context window）可用于展示
- [ ] 旧版无 `get_session_stats` 时回退路径生效（COMPAT）
- [ ] `/compact` 触发 pi 原生压缩；compact 为长阻塞调用，不受控制面 30s 超时影响
- [ ] 压缩开始/完成在时间线以 manual/auto 归类呈现
- [ ] fake-pi 测试覆盖轮询节奏、回退与 compact 路径；受影响测试通过
