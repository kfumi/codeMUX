# 05 — daemon 终端 shell 解析 / env / 退出码 / shell 字段

**What to build:** daemon 侧的终端启动参数对齐 ZCode：更可靠的 shell 选择、UTF-8/TERM 环境、真实退出码，并在创建响应里返回 shell 路径供界面显示。

**Blocked by:** —

**Status:** done（代码与自动化验证完成；Windows 手工验收未执行）

- [x] `crates/daemon/src/terminal.rs`：shell 候选列表抽成纯函数——Windows `pwsh.exe → powershell.exe → %ComSpec% → cmd.exe`，Unix `$SHELL → /bin/zsh → /bin/bash → /bin/sh`，逐个校验存在且可执行；全部不可用时返回可读错误。
- [x] 环境构造：`TERM=xterm-256color`、`COLORTERM=truecolor`（未设置时）；Unix 下 `LANG`/`LC_CTYPE` 缺失或为 `C`/`POSIX` 时补 `*.UTF-8`；不修改进程全局 env。
- [x] 退出码：独立线程轮询 `child.try_wait()` 取真实 code，`Exit { code }` 不再固定为 `None`。
- [x] `POST /terminals` 响应增加 `shell`；`daemon-client/terminal.ts` 的 `terminalStart` 返回类型同步。
- [x] `terminalDockStore` / `TerminalView` 用 shell 文件名（`pwsh` → PowerShell）显示在 dock 头部。
- [x] Rust 单测：候选回退顺序（注入假的 `is_executable`）、UTF-8 env 补齐、退出码透传；不启动真实 shell。
- [x] `npm run build:daemon` 通过（先确认没有残留 daemon 进程占用二进制）。

## Comments

- **`Exit` 不能靠 reader EOF 触发。** ConPTY 下 shell 退出后输出管道不一定 EOF（要等 master 释放），实测 `exit 7` 后 15s 收不到任何结束事件。
- **退出检测不能用 `wait()`。** `child` 锁在 session 里共享：`wait()` 会持锁到 shell 退出，而 `close_terminal` 要拿同一把锁去 `kill()` —— 两者互相等待；`close` 又在 async handler 里同步阻塞 std Mutex，会占死 tokio worker，连带控制面 WS 的 Ping/Pong 停摆（现场表现为 `45000ms 未回 Pong` 后重连）。改成 250ms 一次 `try_wait()`，锁只在单次调用期间持有。
- 端到端实测（临时 daemon）：关闭运行中的终端 `closeMs=7`，之后仍能创建新终端；`exit 7` 返回 `exitCode=7`。
