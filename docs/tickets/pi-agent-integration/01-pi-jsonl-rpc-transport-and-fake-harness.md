# 01 — pi JSONL RPC 传输层与 fake-pi 测试基建

**What to build:** Sidecar 内可复用的 pi RPC 传输模块：spawn `pi --mode rpc` 子进程，严格 JSONL 双向通信（请求/响应按 id 关联、事件流订阅、进程退出传播、优雅关闭），以及讲同一协议的 fake-pi 桩子进程测试基建。不依赖真实 pi CLI 即可在单测中验证协议往返——这是 pi 接入唯一新增的测试 seam（对齐 Codex app-server 传输层与 fake-app-server 基建的先例）。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 严格按 `\n` 切帧并剥离尾部 `\r`；不使用 Node `readline`（其会在 U+2028/U+2029 处错误切分）
- [x] 请求/响应按可选 `id` 关联；控制面调用默认 30s 超时；支持按调用指定不限时（compact 用）
- [x] stderr 维持有界环形缓冲，可随诊断读取
- [x] 优雅关闭：close 宽限超时后强杀；进程异常退出时 reject 所有未完成请求并广播退出事件
- [x] fake-pi 桩子进程可模拟：正常响应、事件流、响应延迟、进程崩溃
- [x] 单测覆盖：成功响应、RPC error、控制面超时、stdout 断连、多行/大帧边界
