# 05 — Rust E2EE 握手与加解密层

**What to build:** 在 Companion Server 侧实现与 Paseo 语义等价的 E2EE 通道：持久桌面密钥对、`e2ee_hello` / `e2ee_ready` 握手、NaCl box 加解密、重握手同钥重发 ready / 异钥关闭连接。提供可与 TS `tweetnacl` 交叉验证的测试向量。

**Blocked by:** 04 — 稳定 desktopId 持久化

**Status:** ready-for-agent

- [ ] 加载或创建桌面 E2EE 密钥对，私有文件权限与原子写入。
- [ ] 实现 `create_daemon_channel` / 加密帧封包解包（对齐 XSalsa20-Poly1305 + Curve25519）。
- [ ] 握手状态机：handshaking → open；open 后拒绝明文业务帧。
- [ ] 重握手：相同 client 公钥 → 重发 ready；不同公钥 → close 1008。
- [ ] Rust 单元测试：固定密钥向量、往返加解密、与 TS 参考向量一致（至少一帧）。
- [ ] 不接入 Relay 前可在内存 Transport 上独立验证。
