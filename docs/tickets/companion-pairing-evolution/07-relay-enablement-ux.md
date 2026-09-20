# 07 — Relay 开启同意与连接状态 UI

**What to build:** 桌面 Companion 对话框增加 Relay 开启流程（显式同意、安全说明链接、启用后生成跨网 QR）；展示 Relay 连接状态（已连接/重连中/失败）。关闭 Relay 停止新跨网配对，不影响已有 LAN 配对。

**Blocked by:** 06 — Relay 出站传输与加密隧道

**Status:** ready-for-agent

- [ ] 未开启 Relay 时：展示说明 +「启用中继」按钮（非默认开启）；参考 Paseo RelayConsent 文案结构。
- [ ] 开启后：刷新 Offer/QR（含 relay 字段）；设置持久化 `relay.enabled`。
- [ ] 状态指示：Relay 控制通道连接状态；错误可重试。
- [ ] 关闭 Relay：确认提示；停止出站连接；UI 回到仅 LAN Offer。
- [ ] 复制链接/CLI 导出（JSON 可选）在 relay 模式下输出完整 offer URL。
- [ ] 手动测试清单：同意前无 relay offer、同意后扫码跨网（需可用 Relay 环境）。
