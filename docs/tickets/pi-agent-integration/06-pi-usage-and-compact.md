# 06 — pi 用量统计与手动压缩

**What to build:** pi 会话的用量与上下文管理：turn 边界读取 `get_session_stats`（turn 前基线 + 结束快照做差值），token 用量随 `turn_finished.usage` 进入 CodeMUX 用量统计（DB 聚合链路自动生效）；`/compact`（可带自定义指令）映射 pi 原生 compact RPC（阻塞任务，不设墙钟超时），压缩完成投影为 `compact_boundary` 时间线条目（manual/auto 归类）。上下文占用由前端按时间线计算（与其它智能体一致），pi 的 contextUsage 无独立消费方，故不接 `get_state` 回退。

**Blocked by:** 03

**Status:** ready-for-agent

- [x] turn 边界 get_session_stats 差值随 turn_finished.usage 进入用量统计（DB 聚合链路复用）
- [x] 上下文占用由前端按时间线计算（与其它智能体一致，无需 pi 侧回退）
- [x] 旧版无 `get_session_stats` 时读取失败即跳过 usage（不阻塞 turn）
- [x] `/compact` 触发 pi 原生压缩；compact 为长阻塞调用，不受控制面 30s 超时影响
- [x] 压缩完成投影为 `compact_boundary` 系统事件，manual/auto 归类呈现
- [x] fake-pi 测试覆盖 usage 差值、compact 路径与 compact_boundary 投影；受影响测试通过
