# 03 — 阶段 1：Connection Offer 生成与消费

**What to build:** 桌面 Companion 对话框与配对链接改为 `#offer=` 格式；移动端统一经 `companion-connection` 解析；配对成功后持久化 `CompanionConnectionProfile`（含 `desktopId` 与 lan 连接描述）。

**Blocked by:** 01 — 建立 Companion Connection 领域契约；02 — 阶段 0：配对体验对齐

**Status:** done

- [ ] 桌面 `buildPairingUrl` 改为构建 `CompanionOfferV1` 并 `encodeCompanionOffer`（含当前 lanIp、port、pairingCode、desktopId）。
- [ ] QR 与「复制链接」输出新格式 URL；保留对旧 query 链接的文档说明（过渡期）。
- [ ] 可选：`GET /api/pair/offer` 返回当前有效 Offer JSON（与 UI 生成逻辑单点）。
- [ ] Mobile：`saveConnection` 升级为存 `CompanionConnectionProfile`；`loadConnection` 迁移旧记录。
- [ ] Mobile `api.ts` / WS 客户端经 `buildRestUrl` / `buildWsUrl` 取 base，不再散落字符串拼接。
- [ ] IndexedDB schema 版本 bump + 迁移测试。
- [ ] 测试：Offer 往返、桌面 URL 生成快照、profile 持久化与迁移。
