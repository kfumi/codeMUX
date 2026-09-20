# 02 — 回环 Daemon 与 Local Daemon Token

**What to build:** 应用一启动，Companion Server 就在回环地址就绪，不必先打开「移动伴侣」。关掉移动伴侣后手机立刻连不上，本机回环探活仍成功。桌面用 Local Daemon Token 访问回环，不是一台伪造的已配对设备；局域网/中继只认 Pairing Token。Daemon 起不来时窗口说明是服务失败，而不是空白会话列表。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 进程启动后回环始终监听；`companion.enabled=false` 时局域网/中继不可达或拒绝业务，回环 `/health` 仍成功。
- [ ] 开启移动伴侣时配对二维码、已配对设备、Relay 开关与关闭语义与现在一致；关闭时撤销/停对外暴露，不删 Local Daemon Token、不停回环。
- [ ] Local Daemon Token 存在应用数据目录，供 Desktop Shell（及日后 CLI）使用；不是 `companion_paired_devices` 行。
- [ ] 回环请求接受 Local Daemon Token；非回环请求携带 Local Daemon Token 返回 401。
- [ ] 非回环请求仍只接受有效 Pairing Token；回环上有效 Pairing Token 仍可用（本机调试不禁手机式凭证）。
- [ ] 设置文案把「移动伴侣」说成局域网/中继暴露，不把「Daemon 已启动」说成已经对外分享。
- [ ] 回环端口被占用或 Daemon 启动失败时，窗口有可读错误（含端口冲突提示），会话列表不被误读成「没有对话」。
- [ ] 无 GUI 测试覆盖：回环+本机凭证、非回环+本机凭证 401、关移动伴侣后回环仍健康、撤销手机不影响本机凭证。
