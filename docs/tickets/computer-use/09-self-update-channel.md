# 09 驱动零配置升级（自更新通道）

**What to build:** 「更新驱动」不再要求用户先填更新命令。cua-driver 自带 `update --apply`（查 GitHub 最新 release，经官方安装器原地升级），留空即走它；用户配置的命令仍是显式覆盖。

**Blocked by:** 08 驱动零配置与一键安装

**Status:** done

- [x] 实测驱动自带升级：`cua-driver update --apply` 是官方升级入口，`check-update --json` 是它的只读版本（20h 磁盘缓存）
- [x] `update_channel_with`：配置的更新命令优先；留空且驱动是 cua-driver 本体 → 自更新（直接执行二进制，不经 shell）；两者都没有 → 无通道
- [x] `POST /api/computer-use/driver/update` 无配置时走自更新；接口层强制 `confirm: true` 与「升级前先停驱动」不变
- [x] 诊断「升级通道就绪」：自更新也算就绪，并附版本检查结论（当前 0.30.1 → 可升级到 0.34.0 / 已是最新）；检查失败不当成「已是最新」
- [x] `GET /api/computer-use/driver` 返回 `updateChannel`（`command` / `self`）；设置页据此启用按钮与确认文案
- [x] 设置页「更新命令」占位符与说明改为「留空 = 驱动自带升级」，只有包管理器装的才需要覆盖
- [x] 单测：自更新常量、`is_cua_driver`、通道优先级、真实 `check-update` 载荷解析、诊断三种通道文案；组件测试覆盖「无用户命令也能一键更新」与「无通道时按钮禁用」

## Comments

- **实测证据**（本机 0.30.1，官方安装脚本装的）：

  | 命令 | 结果 |
  |---|---|
  | `cua-driver --help` | 子命令含 `update`、`check-update`、`channel`、`doctor` |
  | `cua-driver manifest` | `update`：「Check GitHub for a newer release; with --apply, download and install via the canonical installer.」 |
  | `cua-driver check-update --json` | `{"current_version":"0.30.1","latest_version":"0.34.0","update_available":true,"install_command":"irm https://cua.ai/driver/install.ps1 | iex","selected_channel":"stable","source":"github_releases"}` |
  | `cua-driver update`（不带 `--apply`） | 只读：打印「New version available: 0.34.0 → Run with --apply」，退出码 0 |

- **为什么不把它写成 `driver_update_command` 的默认值**：默认值写进配置会长得像用户自己填的，而且会随安装方式变化而过期。通道应当**推导**：探测谁是驱动 + 驱动自报能力；配置只在用户要覆盖时出现（显式配置永远赢）。
- **为什么自更新只认 cua-driver 本体**：`driver_command` 可以指向任何讲 stdio MCP 的程序，别的程序没有 `update` 子命令 —— 不替用户跑一条注定失败的命令。这种驱动想一键升级，自己在「更新命令」里填。
- **为什么版本检查放在诊断里**：设置页首屏的状态接口保持零网络、零子进程；「能不能升级」是点「一键诊断」时问的问题，顺带拿到「当前 → 最新」。
- **已知边界**：非 Windows 未实测 `update --apply`（本期系统级执行也只支持 Windows）；下载与安装由驱动自己做，失败原样冒泡到界面 toast。`channel set nightly` 这类换通道动作仍交给用户自己跑，daemon 不代管。
