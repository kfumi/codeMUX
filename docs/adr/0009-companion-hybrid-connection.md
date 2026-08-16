# ADR 0009: Companion 混合连接模型（Pairing Token + E2EE + Relay + 多传输）

## Status

Accepted

## Context

ADR 0008 确立了 Mobile Companion 作为 thin client、Companion Server 在 Rust 侧、CodeMUX Event 协议不变的架构。首版仅支持局域网 Device Pairing（明文 HTTP + Pairing Token）。

随着跨网使用、Tailscale/VPN 直连、以及用户对传输隐私的要求提升，需要在不破坏既有 REST/WS 业务协议的前提下，引入：

- 版本化 **Connection Offer**（`#offer=` fragment）
- 稳定 **desktopId**
- 可选 **公网中继（Relay）** 与 **端到端加密（E2EE）**
- 同一桌面实例上的 **多传输通道**（`lan` / `relay` / `direct`）与可达性择优

参考 Paseo 的 Connection Offer + Relay/E2EE 实践，但保留 CodeMUX 的 Pairing Token 设备管理与撤销语义。

## Decision

采用 **混合信任模型**：

| 层 | 机制 | 作用 |
|----|------|------|
| 设备级 | Pairing Token | 设备注册、撤销、鉴权（`/api/*` Bearer） |
| 传输级 | E2EE（NaCl box） | 跨网时保护 Relay 上的密文；Relay 为不可信中介 |
| 寻址 | Connection Offer | 扫码/粘贴一次获得 desktopId、LAN、Relay、公钥 |
| 多路径 | `connections[]` | 同一 desktopId 可并存 lan、relay、direct；客户端按 `/health` 择优 |

### 实现要点

1. **共享领域模块** `src/lib/companion-connection/`（Vitest）：Offer 编解码、Profile 迁移、`resolveActiveConnection`、E2EE/Relay 客户端。
2. **Rust 侧**：`companion/e2ee`（sodiumoxide）、`companion/relay`（出站 WS 控制通道 + 每连接数据通道）；解密后 HTTP 隧道回环至本机 axum（`127.0.0.1:{port}`）。
3. **Relay 默认关闭**：桌面 Companion 对话框显式「启用中继」；Offer 仅在 `relay.enabled` 时包含 `relay` 与 `desktopPublicKeyB64`。
4. **直连**：Mobile 可为已配对 desktopId 添加 `direct` 连接（Tailscale/VPN/LAN IP），无需重新 Device Pairing。
5. **WS over Relay**：首版 Mobile 在 relay 模式下对会话事件使用 HTTP 轮询；LAN/direct 仍用原生 WebSocket。

### 开发用 Relay

仓内提供 `scripts/companion-relay.mjs` 用于本地/自托管验证，非生产官方服务。

## Consequences

### 正面

- 跨网可用且 Relay 无法读取业务明文
- Pairing Token 撤销与 E2EE 会话互补
- 旧版 `baseUrl + token` 存储可迁移至 Profile
- 桌面/移动端共享 Offer 与择优逻辑，行为一致

### 负面 / 限制

- Relay 模式下 WebSocket 尚未隧道化，事件流使用轮询
- 需运行或自托管 Relay 服务才能验证跨网场景
- E2EE 密钥对存于桌面 app data，需备份/迁移策略（未来）

## Related

- ADR 0008 — Mobile Companion 初版架构
- `.scratch/companion-pairing-evolution/spec.md` — 全阶段需求与工单
