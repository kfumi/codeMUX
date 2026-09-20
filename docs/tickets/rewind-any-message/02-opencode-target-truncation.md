# 02 — OpenCode 后端:按目标消息截断

**What to build:** OpenCode 会话的回退从"只支持最新一轮"扩展为按 RewindTarget 在任意历史位置截断:以 provider 消息 ID 在 OpenCode 数据库定位目标行,删除该行及其后的 messages 与 parts,保留之前全部内容。回退命令把 target 透传给 OpenCode 分支;未提供 target 时维持现有最新一轮语义。Claude/Codex 的 JSONL 截断路径零改动。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] OpenCode 回退函数接受可选 RewindTarget;提供时按 provider 消息 ID 查询目标行的创建时间作为删除边界
- [ ] 删除边界语义:目标用户消息本身及其后的全部 messages/parts 被删除;目标之前的所有内容(含工具调用与结果关联)完整保留
- [ ] 目标消息不存在时报错返回,数据库不做任何修改
- [ ] 未提供 target 时行为与现状完全一致(最新一轮截断)
- [ ] 回退命令将 target 透传至 OpenCode 分支,Claude/Codex 分支不受影响
- [ ] Rust 层 SQLite fixture 测试覆盖:按目标截断的删除边界、目标缺失报错、无 target 兜底(参照 rewind 模块现有 JSONL fixture 测试风格)
- [ ] 现有 JSONL 定位/截断回归测试全部保持绿色
