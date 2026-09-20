# 04 — 稳定 desktopId 持久化

**What to build:** 为每台 CodeMUX 桌面实例分配跨重启稳定的 `desktopId`（`cmx_desktop_*`），写入应用配置；Companion Offer 与 Relay 路由键均使用此 ID。提供重置身份路径（需确认，并使全部 Pairing Token 失效）。

**Blocked by:** 01 — 建立 Companion Connection 领域契约

**Status:** done

- [ ] 首次需要时生成 `desktopId`，持久化至 companion/应用配置（与现有 config 保存路径一致）。
- [ ] `get_companion_status` / Offer 生成读取稳定 `desktopId`，非每次随机。
- [ ] 重置 desktopId 命令或设置项：确认对话框 + 清除 `companion_paired_devices` + 刷新 pairing code。
- [ ] 测试：重启后 ID 不变；重置后 ID 变、旧 token 401。
