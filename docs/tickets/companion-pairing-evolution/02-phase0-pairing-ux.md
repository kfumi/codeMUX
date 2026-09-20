# 02 — 阶段 0：配对体验对齐

**What to build:** Mobile Companion 扫码后自动完成 Device Pairing（自动 claim），支持粘贴配对链接，配对失败时回退手动表单；桌面复制链接行为不变。无需改动传输层或 Offer 格式（可继续用旧 query URL，或由 03 一并切换）。

**Blocked by:** 01 — 建立 Companion Connection 领域契约

**Status:** done

- [ ] `main.tsx`：检测到有效 `code`（query 或经 01 解析的 offer）时自动调用 claim，成功直接进入 Session 列表。
- [ ] 自动 claim 期间展示加载态；失败展示可读错误并保留/恢复手动表单。
- [ ] 配对页增加「粘贴配对链接」入口：解析完整 URL（含 `#offer=` 或 `?code=`）后走同一 claim 流程。
- [ ] 设备命名：自动 claim 前仍允许编辑设备名（默认 `suggestDeviceName()`）；或自动 claim 使用默认名且设置页可改（与 spec 故事 6 一致，择一并在 UI 标明）。
- [ ] 配对码过期/无效：映射桌面 `400` 为「配对码无效或已过期，请让桌面刷新二维码」。
- [ ] 不破坏：已存 Pairing Token 的冷启动、401 回配对页、断网进 Session 列表只读缓存。
- [ ] 测试：Vitest 覆盖自动 claim 触发条件、粘贴解析、错误回退（mock fetch）。
