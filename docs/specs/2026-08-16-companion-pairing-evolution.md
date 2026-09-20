# Companion 配对与连接能力演进（全阶段）

**Status:** ready-for-agent

## Problem Statement

CodeMUX Mobile Companion 当前仅支持局域网 Device Pairing：桌面 Companion Server 被动监听，二维码携带 LAN 地址与 6 位一次性配对码，手机 PWA 扫码后仍需手动确认才能完成配对并换取 Pairing Token。该方案在同子网内可用，但存在以下问题：

1. **配对体验割裂**：扫码后不能一键完成 Device Pairing，需二次填写/提交；不支持粘贴配对链接；旧式 query 参数与未来格式难以共存。
2. **连接范围受限**：手机与桌面必须处于同一局域网；ADR 0008 规划的公网中继（M4）尚未实现，用户离开家庭/办公室网络即无法使用移动伴侣。
3. **传输安全不足**：局域网内为明文 HTTP + Pairing Token 信任模型，跨网场景缺乏端到端加密（E2EE）能力。
4. **连接模型单一**：无法像成熟方案（如 Paseo）那样在同一桌面实例上叠加「中继连接」与「直连（Tailscale/VPN/LAN）」并自动择优。
5. **桌面身份不稳定**：缺少跨重启持久的 `desktopId`，不利于中继路由、多传输通道归并到同一桌面实例。

用户希望参考 Paseo 的 Connection Offer + Relay/E2EE 思路，在保留 CodeMUX 既有 Pairing Token 设备管理与 Companion Server 协议的前提下，分阶段完成全部连接能力演进。

## Solution

在 Mobile Companion 与 Companion Server 上实施四阶段演进，统一以 **Companion Connection Offer** 描述配对入口，保留 **Pairing Token** 作为设备级鉴权凭证，并在跨网场景增加 **Relay 出站传输 + E2EE 握手** 作为传输层包装——Companion Server 的 REST/WS 业务协议（CodeMUX Event envelope）保持不变，符合 ADR 0008「中继只换寻址路径，不换协议」。

**阶段 0 — 配对体验对齐**：扫码自动 claim、粘贴配对链接、兼容旧 URL。

**阶段 1 — Connection Offer 抽象**：引入版本化 Offer 编解码、稳定 `desktopId`、桌面/移动端统一解析；LAN 模式 QR 改为 `#offer=` fragment。

**阶段 2 — 公网中继与 E2EE**：桌面主动连接 Relay；Offer 含 relay 端点与桌面 E2EE 公钥；跨网流量在 Relay 上端到端加密；用户显式同意开启 Relay。

**阶段 3 — 直连增强**：支持手动添加 Tailscale/VPN/LAN 直连地址；同一 `desktopId` 可并存 relay 与 direct 连接，客户端按可达性择优。

## User Stories

### 阶段 0 — 配对体验

1. As a Mobile Companion 用户，我希望扫码后自动完成 Device Pairing，无需再点「完成配对」，以便一步连上桌面。
2. As a Mobile Companion 用户，我希望从桌面复制配对链接后可在 PWA 内粘贴完成配对，以便无法扫码时仍能连接。
3. As a Mobile Companion 用户，我希望旧版 `?code=` 链接仍能配对，以便升级过程中不被打断。
4. As a 桌面用户，我希望配对链接复制后可在 IM/邮件中发送给另一台设备，以便家人或同事协助配对。
5. As a Mobile Companion 用户，我希望自动配对失败时仍能看到明确错误并回退到手动表单，以便排查网络或配对码问题。
6. As a Mobile Companion 用户，我希望配对过程中仍可为设备命名，以便在桌面「已配对设备」列表中识别。
7. As a 桌面用户，我希望刷新配对码后旧码立即失效，以便控制谁能在窗口期内配对。
8. As a Mobile Companion 用户，我希望配对码过期时看到可读提示而非笼统网络错误，以便知道需要让桌面刷新二维码。

### 阶段 1 — Connection Offer 与桌面身份

9. As a 桌面用户，我希望二维码中的信息是自包含的 Connection Offer，以便手机无需猜测 LAN 地址结构。
10. As a Mobile Companion 用户，我希望打开含 `#offer=` 的链接时自动解析 host、port、配对码与 desktopId，以便减少手填。
11. As a 系统维护者，我希望 Offer 有明确版本号 `v`，以便未来扩展 relay/direct 字段而不破坏旧客户端。
12. As a 桌面用户，我希望本机拥有跨重启稳定的 desktopId，以便中继与多连接归并到同一桌面实例。
13. As a Mobile Companion 用户，我希望本地存储的连接档案包含 desktopId 与传输模式，以便重连时选对路径。
14. As a 桌面用户，我希望 Companion 对话框显示的 QR 与复制链接使用新 Offer 格式，以便与文档一致。
15. As a Mobile Companion 用户，我希望从 PWA 同源打开（桌面托管静态页）时 Offer 可省略显式 host，以便扫码即用。
16. As a 系统维护者，我希望 Offer 编解码逻辑在桌面与移动端共享纯函数模块，以便行为一致且可单点测试。
17. As a Mobile Companion 用户，我希望配对成功后 IndexedDB 中除 Pairing Token 外还记录传输描述符，以便阶段 2 平滑升级。
18. As a 桌面用户，我希望已配对设备列表仍显示设备名、配对时间与最近请求时间，以便安全管理。
19. As a 桌面用户，我希望撤销单台设备后仅该 Pairing Token 失效，以便不影响其他手机。
20. As a 桌面用户，我希望关闭移动伴侣时仍按现有语义清除全部已配对设备，以便一键收回访问权。

### 阶段 2 — Relay 与 E2EE

21. As a 桌面用户，我希望在设置中显式开启 Relay 后才生成跨网配对 QR，以便知情同意网络暴露方式。
22. As a 桌面用户，我希望开启 Relay 前看到简短安全说明（E2EE、Relay 不可读明文），以便理解信任模型。
23. As a 桌面用户，我希望桌面 Companion 通过出站 WebSocket 连接 Relay，以便无需端口转发或公网 IP。
24. As a Mobile Companion 用户，我希望跨网配对扫码后通过 Relay 连上桌面，以便在外网使用移动伴侣。
25. As a 系统维护者，我希望 Relay 仅转发加密密文与路由元数据，以便 Relay 被视作不可信中介。
26. As a Mobile Companion 用户，我希望与桌面建立连接时完成 E2EE 握手（互发公钥、派生会话密钥），以便中继无法窃听 CodeMUX Event 与消息内容。
27. As a 系统维护者，我希望 E2EE 握手失败时连接终止且不误入明文业务 API，以便防止降级攻击。
28. As a Mobile Companion 用户，我希望 Relay 连接断开后自动重连并重新握手，以便移动网络切换时恢复会话。
29. As a 桌面用户，我希望关闭 Relay 后不再接受新的跨网配对，已有 LAN 配对不受影响，以便分场景使用。
30. As a 系统维护者，我希望桌面持久保存 E2EE 密钥对，以便 QR 公钥在重启后仍有效且可验证。
31. As a 系统维护者，我希望 Offer 在 Relay 模式下包含 `relay.endpoint`、`relay.useTls` 与 `desktopPublicKeyB64`，以便手机一次扫码获得全部寻址与信任材料。
32. As a Mobile Companion 用户，我希望跨网场景下 REST 与 WS 均走加密通道，以便附件元数据与审批请求同样受保护。
33. As a 系统维护者，我希望可配置 Relay 端点（默认官方或自托管），以便企业用户自建基础设施。
34. As a 桌面用户，我希望 Relay 连接状态在 Companion 对话框中可见（已连接/重连中/失败），以便排障。
35. As a Mobile Companion 用户，我希望仅 Relay 不可达但 LAN 可达时仍能提示尝试直连，以便混合网络环境下降级可用。
36. As a 系统维护者，我希望 Pairing Token 鉴权在 E2EE 通道建立之后仍生效，以便设备级撤销与 E2EE 会话级加密互补。

### 阶段 3 — 直连增强

37. As a Mobile Companion 用户，我希望在设置中手动添加桌面直连地址（host、port、是否 TLS），以便通过 Tailscale 或固定 LAN IP 连接。
38. As a Mobile Companion 用户，我希望已对某 desktopId 完成 Relay 配对后，可再添加直连而不重复 Device Pairing，以便同机多路径。
39. As a Mobile Companion 用户，我希望客户端按「当前可达性」优先选择传输（例如直连成功则不走 Relay），以便降低延迟与 Relay 负载。
40. As a 桌面用户，我希望绑定 Companion 监听地址时可选择仅 Tailscale IP 而非 `0.0.0.0`，以便缩小暴露面。
41. As a Mobile Companion 用户，我希望直连模式下仍使用 Pairing Token 与既有 REST/WS 协议，以便与 LAN 首版行为一致。
42. As a Mobile Companion 用户，我希望删除某条直连配置不影响 Relay 配对与 Token，以便灵活管理连接方式。
43. As a 系统维护者，我希望连接档案模型支持 `connections[]` 多条目（type: lan | relay | direct），以便扩展而不破坏旧存储。
44. As a 桌面用户，我希望文档说明 Tailscale 场景下的推荐配置步骤，以便非专家用户可跟随操作。

### 横切 — 安全、可观测性与兼容

45. As a 系统维护者，我希望所有 Offer 解析失败返回可区分的校验错误，以便客户端展示「链接损坏」而非静默失败。
46. As a Mobile Companion 用户，我希望 Pairing Token 被撤销后自动回到配对页并提示重新配对，以便感知桌面侧收回权限。
47. As a 系统维护者，我希望 E2EE 重握手使用与 Paseo 类似的 `e2ee_hello` / `e2ee_ready` 语义（可改名但行为等价），以便复用成熟实践与测试向量。
48. As a 系统维护者，我希望 Companion Server 的 `/health` 在 Relay 模式下仍可用于进程探活，以便运维监控。
49. As a 桌面用户，我希望 CLI 或设置页可导出当前配对链接（JSON 模式可选），以便无 GUI 环境配对。
50. As a 系统维护者，我希望旧版仅含 `baseUrl + token` 的 IndexedDB 记录在升级后仍可连接 LAN，以便用户无感迁移。

## Implementation Decisions

### 架构原则

- **延续 ADR 0008**：Mobile Companion 仍是 thin client；Companion Server 仍在 Rust；CodeMUX Event 协议不变。
- **混合信任模型**：Connection Offer 提供寻址与（跨网时）E2EE 信任锚；`POST /pair/claim` 仍颁发 Pairing Token 用于设备注册与撤销。二者互补，不采用 Paseo 的「纯 E2EE、无设备 Token」模型。
- **传输与业务分离**：Relay/E2EE 是 WebSocket/HTTP 的传输包装；业务 JSON 结构与现有 companion API 一致。
- **分阶段交付**：每阶段可独立发布；阶段 1 起新 QR 默认新格式，但解析层向后兼容阶段 0 的 query 参数。

### 领域模型

#### CompanionOffer（版本化）

```typescript
// 概念形状 — 来自领域契约原型
interface CompanionOfferV1 {
  v: 1;
  desktopId: string;
  pairingCode: string;        // 6 位，一次性，5 分钟
  lan?: { host: string; port: number };
  relay?: { endpoint: string; useTls?: boolean };
  desktopPublicKeyB64?: string; // 阶段 2+ 跨网必填
  expiresAt?: string;           // ISO8601，可选；桌面生成时写入
}
```

- URL 编码：`{appBaseUrl}/#offer={base64url(JSON)}`
- `appBaseUrl` 阶段 1 可为桌面托管 PWA 的 origin（`http://{lanIp}:{port}`）或未来固定托管域。
- 解析入口统一：`parseCompanionOfferFromUrl(input: string): CompanionOffer | null`

#### CompanionConnectionProfile（移动端持久化，取代单纯 `baseUrl + token`）

```typescript
interface CompanionConnectionProfile {
  desktopId: string;
  deviceId: string;
  token: string;  // Pairing Token
  label?: string;
  connections: Array<
    | { type: 'lan'; baseUrl: string }
    | { type: 'relay'; endpoint: string; useTls: boolean; desktopPublicKeyB64: string }
    | { type: 'direct'; host: string; port: number; useTls: boolean }
  >;
  preferredConnectionId?: string;
}
```

- IndexedDB 迁移：读取旧 `CompanionConnection` 时 synthesize 为 `connections: [{ type: 'lan', baseUrl }]`。

#### 稳定 desktopId

- 首次启用 Companion 时生成 `cmx_desktop_{random}`，持久化至应用配置目录（与 companion 配置同级）。
- 用于 Relay 会话路由键（与 Paseo `serverId` 同职责）。
- 重置 desktopId 视为新桌面实例：旧 Pairing Token 全部失效（需用户确认）。

### 模块边界

| 模块 | 职责 |
|------|------|
| **共享 `companion-connection` 纯 TS 包** | Offer 编解码、URL 解析、Profile 迁移、传输 URL 构建、连接择优逻辑 |
| **桌面 Companion 配对 UI** | 生成 Offer、展示 QR/链接、Relay 开关与同意、连接状态 |
| **Companion Server（Rust）** | 现有 pair/claim、Token 校验、静态 PWA 托管；新增 Offer 生成 API（可选）、Relay 出站客户端、E2EE 握手与加解密层 |
| **Mobile Companion 配对页** | 自动 claim、粘贴链接、手动兜底表单、相机扫码（阶段 3 可选 Web Barcode API） |
| **Mobile API/WS 客户端** | 按 Profile 选择传输；LAN 直连 fetch/WS；Relay 模式经加密通道发 REST/WS 帧 |
| **Relay 服务（外部）** | 按 desktopId 路由控制面与数据面 WebSocket；不解析业务明文 |

### API 契约（增量）

- **保留**：`POST /api/pair/claim`、`DELETE /api/pair/device`、现有 REST/WS 路由与 Pairing Token 语义。
- **新增（可选）**：`GET /api/pair/offer` — 返回当前有效 Offer JSON（供桌面 UI 刷新，免重复实现生成逻辑）。
- **新增（阶段 2）**：Companion Server 出站连接 Relay 控制通道；协议兼容「sync / connected / disconnected / ping / pong」控制消息与 per-connection 数据 socket。
- **E2EE 握手**（传输层，明文 JSON 仅握手期）：
  - Client → Daemon：`{ type: "e2ee_hello", key: "<clientPublicKeyB64>", capabilities?: { binaryCiphertext?: boolean } }`
  - Daemon → Client：`{ type: "e2ee_ready", capabilities?: { binaryCiphertext?: boolean } }`
  - 之后帧为 NaCl box 加密（Curve25519 + XSalsa20-Poly1305）；Rust 侧使用 `sodiumoxide` 或等价 crate，与 TS `tweetnacl` 互操作。
- **配置扩展**（`CompanionConfig`）：
  - `desktop_id: Option<String>`（运行时填充）
  - `relay.enabled: bool`（默认 false）
  - `relay.endpoint: String`
  - `relay.use_tls: bool`
  - `listen_address: String`（默认 `0.0.0.0`，阶段 3 可绑 Tailscale IP）

### 阶段交互流程

**LAN Device Pairing（阶段 0–1）**

1. 桌面开启 Companion → 生成/复用 6 位 pairingCode + desktopId → 构建 Offer URL。
2. 手机打开 URL → 解析 Offer → 自动 `POST /pair/claim` → 存 Profile + Token → 进入 Session 列表。

**Relay Device Pairing（阶段 2）**

1. 用户同意开启 Relay → 桌面加载/创建 E2EE 密钥对 → Offer 含 relay + 公钥。
2. 手机扫码 → 存 relay 连接描述 → 经 Relay 建 WS → E2EE 握手 → 在加密通道内带 Token 调 `/pair/claim`（或 claim 仍在握手前 HTTPS；实现决策：**claim 可在 E2EE 建立后通过加密 REST 转发**，避免明文 Token 过 Relay）。
3. 桌面 Relay transport 将加密帧解包后交给现有 axum 路由处理（in-process 转发，非二次 HTTP）。

**Direct 叠加（阶段 3）**

1. 用户在手机设置添加 `{ host, port }` → 写入 Profile.connections。
2. 连接时先探测 direct `/health`，成功则 LAN/direct fetch；失败回退 relay。

### 安全决策

- Relay 默认关闭；开启需显式 UI 确认（参考 Paseo RelayConsent）。
- QR/链接含公钥与 pairingCode，视为敏感；配对码仍单次有效、5 分钟过期。
- E2EE 建立后若收到不同 client 公钥的重握手，关闭连接（防中继强行换钥）。
- 直连跨不可信网络建议配合 Tailscale；文档声明明文 HTTP 仅限可信 LAN。
- 不在 Relay 上降级为无 E2EE 的业务流量。

### Schema / 存储变更

- SQLite：无需改 `companion_paired_devices` 表结构；可选新增 `companion_desktop_identity` 键值或写入 config 文件。
- 桌面配置：新增 `companion.relay.*`、`companion.desktop_id`、可选 `companion.keypair` 路径。
- IndexedDB：`CompanionConnection` → `CompanionConnectionProfile`（版本化 store key，支持迁移回调）。

## Testing Decisions

### 什么是好测试

- 只断言**可观察行为**：给定 URL/Offer 输入 → 解析结果；给定 Profile + 网络探测结果 → 选中的传输；给定握手消息序列 → 通道是否 `open`；给定 claim 请求 → 返回 Token 且旧码失效。
- 不断言内部 mutex、具体函数调用次数等实现细节。
- 优先使用**纯函数与假 Transport** 而非端到端真实 Relay 部署。

### 测试接缝（Seams）

**主接缝（唯一，全阶段共用）——共享 `companion-connection` 纯 TypeScript 模块**

- Offer：`encodeCompanionOffer` / `parseCompanionOfferFromUrl` / 过期与字段校验
- 迁移：`migrateLegacyConnection(old) → profile`
- 传输：`resolveActiveConnection(profile, reachability)`、`buildRestUrl`、`buildWsUrl`
- 兼容：旧 `?code=` URL、新 `#offer=` URL、同源 PWA 无 host 场景

桌面 `buildPairingUrl`、Mobile `main.tsx` 配对入口、`api.ts` 基址解析均委托此模块，保证**单点行为真相**。

**次接缝（仅阶段 2）——Rust `companion_e2ee` 单元测试**

- 固定测试向量：密钥对、hello/ready 往返、加密往返、错误密钥拒绝、重握手同钥重发 ready、异钥关闭
- 与 TS `tweetnacl` 向量交叉验证一帧加密 payload

**集成接缝（抽样）——Companion Server axum 路由测试**

- `POST /pair/claim` 有效码/过期码/重复消费
- 授权头 Token 校验 401/200
- 不覆盖 Relay 全链路（由主接缝 + e2ee 接缝 + 手动/E2E 环境验证）

### 测试先例

- `src-mobile/src/lib/api.test.ts`：纯函数 + mock fetch
- `src-mobile/src/lib/eventToMessages.test.ts`：事件解析纯函数
- Paseo `connection-offer.test.ts`、`encrypted-channel.test.ts`：Offer 与 E2EE 向量（行为参考，不复制代码）

### 接缝确认

请确认以下测试策略是否符合预期：

1. **主接缝**为共享 TS `companion-connection` 模块（Vitest），覆盖阶段 0–3 的 URL/Profile/路由选择。
2. **Rust E2EE** 单独向量测试，不强行与 TS 合并为一个 seam。
3. **不做** 全仓库仅依赖 Playwright 真机扫码 E2E；真机验证留在 Manual test plan。

## Out of Scope

- Mobile Companion 新功能：图片/附件、Agent Kind Switch、Fork、归档浏览、系统推送通知（仍属 ADR 0008 首版边界）。
- 多桌面实例同时配对管理 UI（仅支持多台设备连同一桌面，不支持一个手机管理多个 desktopId 的复杂 UI）。
- 自研 Relay 服务端实现纳入本仓库（可引用/部署外部 Relay；配置端点即可）。
- 自签 TLS / 局域网 HTTPS 证书管理。
- 原生 App 壳与应用商店分发（保持 PWA；Web Barcode API 为最佳努力）。
- 配对过程中的账号体系、OAuth、多用户租户。
- 将 Pairing Token 完全替换为 E2EE 身份（本 spec 明确保留 Token）。

## Further Notes

- 本 spec 将 ADR 0008 与 CONTEXT.md 中「公网中继首版不做」的表述**显式扩 scope**；实现完成后应追加 ADR 修订或新 ADR 记录混合 Token + E2EE + Relay 模型。
- Paseo 实现位于外部参考仓库，协议设计可对齐其 Connection Offer 与 E2EE 握手语义，但设备 Token 与 Companion API 形状保持 CodeMUX 自有。
- 建议实现顺序：阶段 0 → 1 → 2 → 3；阶段 2 依赖 Relay 基础设施可用（默认端点或自托管）。
- 实现工单建议拆分为：01 领域契约、02 阶段 0 UX、03 阶段 1 Offer、04 desktopId、05 E2EE Rust、06 Relay 传输、07 Relay UX、08 直连多传输、09 集成验证。
