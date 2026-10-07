# 05 驱动概念验证

**What to build:** 用外部开源驱动跑通一条最小闭环，回答能不能用、坑在哪：daemon 拉起驱动子进程并连通，在主力智能体上完成截图到点击到验证，结论回写 spec。

**Blocked by:** 01 浏览器快照与元素操作 MCP 化

**Status:** done（第三方驱动实测与主力智能体闭环待联调）

- [x] daemon 拉起驱动子进程并经标准输入输出 MCP 连通
- [ ] Claude 与 Codex 跑通截图到点击到验证闭环
- [x] 选型结论回写 spec 底部 Comments：行或不行、坑位清单
- [ ] MCP 图片回传可见性逐项记录，为铺开验收铺路

## Comments

- **宿主**：`computer_use::driver` 实现完整生命周期 —— 拉起子进程（`kill_on_drop`）、按行 JSON-RPC 握手（initialize → initialized → tools/list）、工具调用转发、急停（置停标志 + 唤醒在途调用 + 取走并丢弃句柄即杀进程）。协议解析是纯函数，进程行为由真实子进程覆盖。
- **实测**（`crates/daemon/tests/computer_use_driver.rs`，4 条用例，跑真实二进制）：握手拿到 serverInfo 与工具清单；急停在 1 秒内杀掉子进程；急停后可重新拉起；不存在的命令留下可展示的失败原因。
- **替身驱动**：概念验证用 daemon 自己的 `mcp-browser` 子命令当 stdio MCP 驱动，跨平台、零外部下载，验的是宿主本身。为让替身能在「daemon 未运行」时也握手成功，内置 server 的端口/令牌解析改成**调用时现取**（顺带修好：daemon 重启换端口后自动跟上）。
- **第三方驱动**：`computer_use.driver_command` + `driver_args` 接受任意 stdio MCP 驱动（cua-driver 等）。本环境未下载第三方二进制 —— 分发前要先确认其开源协议允许二进制再分发（spec 已写明），这条留待选型评审。
- **未做**：Claude/Codex 真实闭环与逐家图片回传可见性需要真实模型，记在 07 票的能力矩阵里，不在此票勾选。
