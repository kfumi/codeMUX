# 01 — 建立 Companion Connection 领域契约

**What to build:** 建立共享纯 TypeScript 的 `companion-connection` 模块，统一 CompanionOffer 编解码、URL 解析（`#offer=` 与旧 `?code=`）、CompanionConnectionProfile 模型、旧存储迁移，以及传输 URL 构建与连接择优的纯函数边界。桌面配对 URL 生成与 Mobile Companion 配对/API 客户端均委托此模块。

**Blocked by:** None — can start immediately

**Status:** done

- [ ] 定义 `CompanionOfferV1` 形状（`v`、`desktopId`、`pairingCode`、`lan`、`relay`、`desktopPublicKeyB64`、`expiresAt`）。
- [ ] 实现 `encodeCompanionOffer` / `parseCompanionOfferFromUrl` / `decodeOfferFragmentPayload`，含 base64url 与 schema 校验错误。
- [ ] 定义 `CompanionConnectionProfile`（`desktopId`、`deviceId`、`token`、`connections[]`、`preferredConnectionId`）。
- [ ] 实现 `migrateLegacyConnection`：旧 `{ baseUrl, token, deviceId }` → profile with `type: 'lan'`。
- [ ] 实现 `resolveActiveConnection(profile, reachability?)` 与 `buildRestUrl` / `buildWsUrl` 桩（阶段 0–1 仅 lan；relay/direct 返回明确「未实现」或占位）。
- [ ] 兼容解析：旧 `?code=` + `host`/`port` query、新 `#offer=` fragment、同源 PWA 无显式 host。
- [ ] Vitest 覆盖：往返编码、损坏 payload、过期 offer、迁移、URL 变体矩阵。
- [ ] 模块可被 `src/` 与 `src-mobile/` 共同引用（共享路径或包导出策略与仓库惯例一致）。
