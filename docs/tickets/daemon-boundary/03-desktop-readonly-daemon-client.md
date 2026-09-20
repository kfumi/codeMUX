# 03 — 桌面只读走协议（列表、bootstrap、Timeline、WS）

**What to build:** 桌面成为第一种真正的 Daemon Client：会话列表、项目、新建 Session 所需只读 bootstrap、打开一条 Session 的 Timeline，以及实时 CodeMUX Event，都走 Companion Server（Local Daemon Token + 回环）。关掉移动伴侣后桌面仍能看历史。UI 测试注入假 Daemon Client，不再 mock 每一条本机命令。手机只读行为不回退。

**Blocked by:** 01 — 能力分类与 Daemon / Shell 双门面；02 — 回环 Daemon 与 Local Daemon Token

**Status:** ready-for-agent

- [ ] 启动顺序：壳起来 → 回环就绪 → Local Daemon Token 探活成功 → 再灌会话列表。
- [ ] 未归档/已归档会话列表、项目列表、bootstrap（Agent Kind、Model Provider、Permission Snapshot 可选项）经 Daemon Client，不再走对应本机业务命令。
- [ ] 打开 Session 用 Timeline 分页（tail/after/before）与 Event Sequence 追赶缺口；只读或导入 Session 能看历史且不会被当成可发送。
- [ ] 运行中的 CodeMUX Event 经 Companion WS 进入同一套会话 store；sidecar 事件由 Daemon 写入 Timeline 再扇出，桌面不以仅 IPC 的事件总线为 Timeline 权威。
- [ ] WS 断开后按 Event Sequence 续上，不整表刷新、不重复应用 Turn Outcome。
- [ ] 关闭移动伴侣后上述只读路径仍可用；已配对 Mobile Companion 的列表、尾部 Timeline、WS 订阅不回退。
- [ ] 假 Daemon Client 覆盖：列表、Timeline 分页与缺口追赶、重连续 sequence；组件测试不再以本机命令为业务接缝。
- [ ] 内置浏览仍走 Browser Host；切 Session 或关移动伴侣不得销毁本该停放的浏览器页。
