# 12 — 收缩 invoke 与双写守卫

**What to build:** 桌面日常路径不再对本机发出任何 Daemon 能力的业务命令；清单上标为 daemon 的能力只能经 Daemon Client → Companion Server。Browser Host、对话框、窗口、托盘、updater 仍走 Shell 门面。CI 在门面/清单测试失败时变红。未安装 CLI 不挡住本票。落地后记下 ADR：Daemon 为权威、Companion Server 为唯一客户端协议、Local Daemon Token、壳与 Browser Host 分离，并修订「服务仅随移动同步开启」的旧表述。

**Blocked by:** 04 — 桌面对话写路径；05 — 会话维护走协议；06 — Model Provider、MCP 与 skills；07 — Scheduled Task 与 Runtime；08 — 工作区文件与 git/forge；09 — 终端 PTY 经 Companion WS；10 — 移动伴侣开关与托盘生命周期

**Status:** ready-for-agent

- [ ] 分类清单与门面测试：每一项 daemon 能力都有 Companion 路由且桌面只经 Daemon Client 调用；壳门面无 Session/agent 发送。
- [ ] 桌面业务门面不再转发到本机 Daemon 命令（contract：删掉 01 留下的 invoke 回退）。
- [ ] 抽查日常路径（列表、打开 Timeline、发送、改供应商、开终端、藏到托盘再打开）无双写。
- [ ] Mobile Companion 既有配对、列表、发送、审批不回退。
- [ ] 新增或修订 ADR，明确回环常开、`companion.enabled` 只控制对外暴露、Local Daemon Token ≠ Pairing Token。
- [ ] 11（CLI）不是blocker；无 CLI 时本票仍可完成。
