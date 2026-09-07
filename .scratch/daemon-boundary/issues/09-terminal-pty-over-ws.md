# 09 — 终端 PTY 经 Companion WS

**What to build:** 侧边面板终端的创建、输入、输出、改尺寸走 Daemon 上的 PTY，经 Companion WS 传输（优先应用控制帧或二进制帧；若首批用 JSON 文本帧也必须走 Companion WS）。不要再把管道留在仅窗口能用的 IPC 旁路，以便日后 CLI 或第二窗口能接同一终端。

**Blocked by:** 03 — 桌面只读走协议

**Status:** ready-for-agent

- [ ] 创建/销毁终端、写入、读取输出、调整尺寸经 Daemon Client；PTY 生命周期在 Daemon，不在壳私有状态里当权威。
- [ ] 终端流只经 Companion WS（或同一 WS 上的二进制帧），不为终端再开一条仅 Tauri event 能用的权威通道。
- [ ] 关闭移动伴侣后本机桌面终端仍可用；手机本规格不交付终端 UI。
- [ ] 切走后侧边面板终端不得再 invoke 对应本机终端命令作为权威路径。
- [ ] 测试：假 Daemon Client 覆盖创建、写输入、收到输出、resize；协议 append-only，不影响现有手机 hello/会话帧。
