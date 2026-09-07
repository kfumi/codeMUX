# 05 — 会话维护走协议

**What to build:** 会话控制面补齐到 Companion：归档/取消归档、固定、只读、改标题、Fork、Rewind、Agent Kind Switch，以及导入 Native Session / 从 provider 刷新 Timeline / 删除原生文件。桌面操作后手机列表能看到同一结果。这些路径切走后同样禁止双写。

**Blocked by:** 04 — 桌面对话写路径走协议

**Status:** ready-for-agent

- [ ] 归档、取消归档、固定、只读、改标题经 Companion 路由生效，Event Sequence / 列表投影与桌面 store 一致。
- [ ] Fork、Rewind、Agent Kind Switch 经 Daemon 完成，领域规则（不在进行中一轮切换、只读/导入不可切换、Switch Briefing 等）与现有行为一致。
- [ ] 导入 Native Session、从 provider 刷新 Timeline、删除对应原生文件经 Daemon，不把原生维护留在仅窗口能用的命令上。
- [ ] 协议为 append-only：新路由不把 Mobile Companion 已依赖字段改成必填；手机未接的能力不作为本票的手机 UI 交付。
- [ ] 每条已切能力从 Daemon 门面走协议后不得再 invoke；未覆盖的入口明确失败，不得静默双写。
- [ ] 测试覆盖路由鉴权（回环 Local Daemon Token）与至少一条「桌面维护后列表状态可被另一客户端读到」的夹具（假第二 Client 即可）。
