# 06 — Relay 出站传输与加密隧道

**What to build:** 桌面 Companion Server 主动连接可配置 Relay（控制通道 + 每连接数据通道）；移动端经 Relay 建 WS 并完成 E2EE 握手后，在加密隧道内承载现有 REST/WS 业务（in-process 转发至 axum 路由，非二次 HTTP）。Relay 服务端不在本仓库实现，通过配置端点对接。

**Blocked by:** 05 — Rust E2EE 握手与加解密层；03 — 阶段 1：Connection Offer 生成与消费

**Status:** ready-for-agent

- [ ] `CompanionConfig` 扩展：`relay.enabled`、`relay.endpoint`、`relay.use_tls`（默认关闭）。
- [ ] 桌面 Relay transport：出站 WS、sync/connected/disconnected/ping/pong 控制消息、重连退避。
- [ ] 数据 socket 经 E2EE 解包后注入 Companion 业务处理（与 LAN axum 共享鉴权：Pairing Token）。
- [ ] Mobile：TS E2EE 客户端（`tweetnacl`）+ Relay WS URL 构建；`connections` 中 `type: 'relay'` 路径。
- [ ] `resolveActiveConnection` 实现 relay 分支；claim 与 API 在 E2EE 建立后发送（Token 不经明文 Relay）。
- [ ] Offer 在 relay.enabled 时包含 `relay` + `desktopPublicKeyB64`。
- [ ] 集成测试：mock Relay 或 loopback 假 server 验证握手 + 一条加密 REST 健康检查或 bootstrap。
