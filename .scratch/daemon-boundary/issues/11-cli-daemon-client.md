# 11 — CLI 作为第三种 Daemon Client

**What to build:** 本机 CLI 用 Local Daemon Token 连回环 Companion Server，不必 Device Pairing。可列 Session、看 status（回环是否在听、移动伴侣是否对外暴露、活跃 Session 数量）、发一条 User Message、中断、应答 Interactive Request。与桌面同时操作同一 Session 时遵守同一队列与审批。不安装 CLI 时桌面与手机功能完整。

**Blocked by:** 02 — 回环 Daemon 与 Local Daemon Token；04 — 桌面对话写路径走协议

**Status:** ready-for-agent

- [ ] CLI 只连回环，使用 Local Daemon Token（或同等本机凭证），不做扫码配对。
- [ ] 至少支持：列 Session、status、向已有 Session 发送、中断、应答 Interactive Request。
- [ ] CLI 与桌面（或假第二 Client）抢同一 Session 时不产生两次 Turn Outcome，排队规则与 04 一致。
- [ ] status 能区分「Daemon 回环就绪」与「移动伴侣已对外暴露」。
- [ ] 未安装/未调用 CLI 不影响桌面与 Mobile Companion。
- [ ] 本票不要求 Fork、Agent Kind Switch、终端、MCP 设置等进 CLI；那些等对应桌面协议票稳定后再加。
