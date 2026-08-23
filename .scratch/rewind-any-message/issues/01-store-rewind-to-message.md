# 01 — Store 泛化:任意历史用户消息回退动作

**What to build:** 开发者可以通过 agent store 的新动作,对任意一条具备强定位标识(provider 原生消息 ID)的历史用户消息执行完整回退:调用既有 Tauri 回退命令通道并携带 RewindTarget,前端事件流截断到目标消息之前,派生状态整体清理,并返回可回填输入框的 payload。现有"回退最后一轮"签名保留为薄包装,行为不变。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 新的 store 动作接受会话 ID + 目标用户消息索引;对强 locator 消息,以 provider_message_id 构造 RewindTarget 调用既有回退命令,同时传递该消息之前用户消息的序号
- [ ] 成功后事件流与时间戳截断到目标之前,streaming、todos、token 用量、变更文件、输入草稿等派生状态的清理集合与现有最后一轮回退完全一致
- [ ] 返回被回退用户消息的文本 + 图片附件 payload
- [ ] 会话运行中或只读时拒绝,不发起命令
- [ ] 目标为乐观渲染消息(无 provider 确认的强定位标识)且不是最新一条时,拒绝回退(对应 paseo 的 provider ack 门槛);薄包装对最新一轮保留现有的按序号兜底行为
- [ ] 旧签名作为薄包装继续可用,现有回退用例全部保持绿色
- [ ] store 接缝单测覆盖:任意索引成功路径、三类拒绝路径、薄包装等价性(参照现有最后一轮回退用例模式)
