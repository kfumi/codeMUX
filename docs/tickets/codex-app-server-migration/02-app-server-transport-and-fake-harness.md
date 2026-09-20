# 02 — App-server 传输层与 fake 测试基建

**What to build:** Sidecar 内可复用的 app-server JSON-RPC 传输层（stdio newline-delimited、client request/notify、server notification、server-initiated request 双向响应、进程退出清理），以及 deterministic fake-app-server 测试基建。不依赖真实 Codex CLI 即可在单测中验证握手与 RPC 往返。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 传输层支持 initialize / initialized 握手模式
- [x] 传输层支持 pending request map 与 server-initiated request handler 注册
- [x] 进程异常退出时 reject 未完成 request 并触发可观测错误
- [x] fake-app-server 可在测试中模拟 notification 与 approval request/response 循环
- [x] 传输层单测覆盖：成功 response、RPC error、超时、stdout 断连
