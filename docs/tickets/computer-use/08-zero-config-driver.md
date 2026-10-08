# 08 驱动零配置与一键安装

**What to build:** `driver_command` 留空不再挡路:daemon 自动探测官方安装位置与 PATH,参数留空取 `mcp` 子命令;没装驱动时设置页提供一键安装(运行 cua.ai 官方脚本,接口层强制确认)。

**Blocked by:** 06 驱动托管与护栏界面

**Status:** done

- [x] 留空驱动命令时自动探测 cua-driver(官方安装位置优先,PATH 兜底),命中即零配置可启动
- [x] 启动参数留空默认 `mcp` 子命令(与 `cua-driver manifest` 的 mcp_invocation 一致,0.34.0 实测)
- [x] `POST /api/computer-use/driver/install` 强制 `confirm: true`,PowerShell 执行 `irm https://cua.ai/driver/install.ps1 | iex`,完成后重新探测并返回状态,动作进审计
- [x] `GET /api/computer-use/driver` 返回 `driverResolution`(custom/auto/missing),设置页据此展示「自动检测」标记或「一键安装」按钮
- [x] 诊断「驱动已配置」失败项的修复指引指向一键安装;未检测到的启动报错同步改写
- [x] 探测纯函数与解析结论单测覆盖;组件测试覆盖 missing/auto/安装确认流

## Comments

- **探测**(`computer_use::probe`):候选路径 = `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin`(官方安装脚本落点,排第一)→ 同目录上级 → `~/.local/bin`、`~/.cua/bin` → 包管理器惯例位置 → PATH。只做存在性 stat(无子进程),真正的可用性由启动时的 MCP 握手验证。
- **为什么默认参数是 `mcp`**:cua-driver 0.34.0 的 `manifest` 自报 `mcp_invocation = {command: <exe>, args: ["mcp"]}`;参考实现(cn.star.computer-use 插件)同样默认 `["mcp"]`。配置了 `driver_args` 则原样使用(显式配置永远赢)。
- **安装与升级分开**:升级通道仍由用户配置(`driver_update_command`,工单 06「daemon 不猜包管理器」的原则不动);一键安装是独立动作,每次都要面板确认 —— 从远端拉脚本执行,确认必须是硬闸门而不是界面礼貌。
- **单一事实来源**:daemon 的 `driverResolution` 是前端展示与按钮显隐的唯一依据;前端常量 `INSTALL_SCRIPT_URL` 与 Rust 侧 `probe::INSTALL_SCRIPT_URL` 保持一致(注释标注同步要求)。
- **已知边界**:一键安装本期仅 Windows(与系统级执行的平台范围一致);非 Windows 留空驱动命令仍可探测(候选含 `~/.local/bin`、`/usr/local/bin`、Homebrew),只是装不了、需手动放置。
