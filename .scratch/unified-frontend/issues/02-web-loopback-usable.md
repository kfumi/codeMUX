# 02 — 网页端同机可用（bootstrap 统一 + loopback 配对引导）

**What to build:** 同机浏览器首次访问时，统一前端的 daemon 配置解析单入口按宿主形态选择引导策略（桌面壳桥注入 / loopback 简化配对 / Pairing 引导），能力清单按宿主形态输出三级能力集（shell-only 能力隐藏而非报错）。loopback 首次配对经壳或 CLI 呈现的一次确认完成，拿到 Pairing Token 后进入完整会话界面，收发消息、看时间线。桌面壳体验不回归。这是阶段一验收点：网页端从此可用。

**Blocked by:** 01 — daemon 侧浏览器接入基座

**Status:** ready-for-agent

- [ ] 桥注入 / loopback 配对 / Pairing 引导三条路径各自解析出正确连接配置，桌面行为与现状一致，桥缺失显示引导界面而非报错崩溃
- [ ] 三级能力集满足"桌面 ⊇ 浏览器 ⊇ 移动"，shell-only 能力（Browser Host、窗口控制、更新器、对话框等）在浏览器形态隐藏
- [ ] loopback 一次确认配对后，浏览器可完整进行会话收发与时间线回放
- [ ] bootstrap 解析与能力清单有纯 TS 测试；配对引导全流程人工验收通过
