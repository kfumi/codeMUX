# 08 — 阶段 3：直连与多传输择优

**What to build:** Mobile Companion 支持为已配对 desktopId 手动添加直连（host、port、useTls）；Profile 支持多条 `connections`（lan、relay、direct）；客户端按可达性择优（先探测 direct/lan `/health`，失败回退 relay）。桌面可选绑定 Tailscale/指定 listen 地址。

**Blocked by:** 06 — Relay 出站传输与加密隧道；03 — 阶段 1：Connection Offer 生成与消费

**Status:** ready-for-agent

- [ ] Mobile 设置：「添加直连」表单；写入 `connections` 不重复 Device Pairing。
- [ ] `resolveActiveConnection`：实现 direct 与择优逻辑（健康检查超时、缓存最近一次成功路径）。
- [ ] 删除单条 connection 不影响 Token 与其他 connection。
- [ ] 桌面 `CompanionConfig.listen_address`（或等价）文档化 Tailscale 绑定步骤。
- [ ] 直连模式仍用 Pairing Token + 明文 HTTP（LAN/可信 VPN）；不强制 E2EE。
- [ ] 测试：择优纯函数矩阵（direct 通、relay 通、皆不通）；profile 增删 connection。
