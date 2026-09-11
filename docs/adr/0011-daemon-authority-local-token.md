# ADR 0011: Daemon Authority and Local Daemon Token

## Status

Accepted(过渡条款已被 ADR 0012 取代)

## Context

CodeMUX previously conflated「移动伴侣」开关与 Companion Server 是否存在：关闭移动伴侣会停止整条对外协议，桌面窗口只能通过 Tauri invoke 访问 Session 与智能体。手机 PWA 与桌面因此走两条互不相通的路径。

## Decision

1. **Daemon 为权威**：SQLite Timeline、Session、Agent、Sidecar、MCP、skills、Scheduled Task 仍由 Rust 进程拥有；Companion Server 是唯一的客户端业务协议。
2. **回环常开**：应用启动后 `127.0.0.1:<port>` 上的 Companion Server 始终监听；`/health` 可探活。
3. **`companion.enabled` 只控制对外暴露**：局域网/中继与配对 UI；关闭时不停止回环、不停止 Scheduled Task、不撤销 Local Daemon Token。
4. **Local Daemon Token**：存放在应用数据目录，供桌面 Shell 与本机 CLI 使用；仅回环请求接受；不是 `companion_paired_devices` 行。
5. **Pairing Token** 仍只服务非本机客户端；非回环请求携带 Local Daemon Token 返回 401。
6. **Desktop Shell 很薄**：窗口、托盘、更新、原生对话框、Browser Host 留在壳；业务 store 经 Daemon Client 访问 Companion Server。
7. **禁止双写**：某一能力切到 Daemon Client 后，桌面 UI 不得再 invoke 对应业务命令。

## Consequences

- 修订 ADR 0008 中「Companion Server 仅随移动同步开启」的表述。
- 桌面、手机、CLI 共享 CodeMUX Event 与 Companion REST/WS；换桌面壳只需替换 Browser Host 适配器。
- ~~迁移期允许 Daemon 与 Tauri 壳同进程；物理拆进程留到换壳时。~~
  该过渡条款已由 [ADR 0012](0012-daemon-process-electron-shell.md) 兑现并取代:
  Daemon 为独立进程(`codemux-daemon`),桌面壳为 Electron Supervisor,Tauri 壳退役。
