# Companion 配对与连接能力演进 — Wayfinder Map

## Notes

- Spec: [spec.md](./spec.md)（**Status: ready-for-agent**）
- 参考调研：Paseo Connection Offer + Relay/E2EE；CodeMUX 现有 LAN + Pairing Token（ADR 0008）
- 实现顺序：01 → 02 → 03/04（可并行）→ 05 → 06 → 07 → 08 → 09

## Decisions-so-far

- **混合信任模型**：保留 Pairing Token 设备注册/撤销；跨网叠加 E2EE，不照搬 Paseo 无 Token 模型。
- **主测试接缝**：共享 TS `companion-connection` 纯模块（Vitest）；Rust E2EE 独立向量测试。
- **协议不变**：Companion REST/WS 业务层仍为 CodeMUX Event；Relay 只换寻址 + 传输加密。
- **Relay 默认关**：需用户显式同意后才生成跨网 Offer。

## Frontier（当前可开工）

| # | 工单 | 状态 |
|---|------|------|
| 01 | [companion-connection 领域契约](./issues/01-companion-connection-domain.md) | done |
| 04 | [稳定 desktopId](./issues/04-stable-desktop-id.md) | done |
| 02 | [阶段 0 UX](./issues/02-phase0-pairing-ux.md) | done |
| 03 | [阶段 1 Offer](./issues/03-phase1-offer-generation.md) | done |
| 05–09 | Relay/E2EE/直连 | pending |

## Ticket Graph

```
01 ─┬─► 02 ─► 03 ─┬─► 06 ─► 07 ─┐
    │              │             ├──► 09
    └─► 04 ─► 05 ──┘             │
                   08 ────────────┘
```
