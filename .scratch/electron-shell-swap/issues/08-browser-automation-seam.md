# 08 — 浏览器自动化接缝

**What to build:** daemon 第一次能驱动壳内页面:Browser Host 契约新增受控自动化方法面(eval、截图、可信输入、CDP 命令,CDP 会话队列化);调用经既有 Companion WS 应用控制通道从 daemon 到壳,仅回环 + Local Daemon Token 链路可发起;以契约测试表达请求-响应与队列化语义,不依赖真实网页。agent 浏览器工具的语义(aria snapshot、键盘隔离、OAuth popup 流程)不在本票,另立规格。

**Blocked by:** 07 — Browser Host Chromium 重写

**Status:** ready-for-agent

- [ ] 从 daemon 侧发起,可对壳内页面取 eval 结果与截图、注入可信输入、执行 CDP 命令。
- [ ] 自动化消息走既有 WS 控制通道,未新增平行协议。
- [ ] 并发自动化请求经队列序列化,互不踩踏。
- [ ] 非回环来源或无效 token 的自动化请求被拒。
- [ ] 契约测试覆盖请求-响应与队列化;真实网页行为仅手动验收。
