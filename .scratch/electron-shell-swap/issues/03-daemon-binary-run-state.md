# 03 — daemon 独立二进制 + run-state 契约(含 stub daemon)

**What to build:** 新增 daemon bin target:不带壳完整启动权威——回环 Companion REST/WS、定时任务、sidecar、移动端静态服务;启动时写 run-state(端口、pid、daemon 版本、托管标记、startedAt),退出清理。交付 stub daemon 可执行脚本(可配置写 run-state、开健康检查、响应停止信号、可配置崩溃),作为后续两壳 supervisor 契约的测试替身。验收演示:不开桌面壳,裸跑二进制后手机可连并驱动会话。

**Blocked by:** 02 — Daemon 核心状态组装脱 AppHandle

**Status:** ready-for-agent

- [ ] daemon 二进制裸跑即服务回环 REST/WS 与定时任务,健康检查可探活。
- [ ] run-state 文件生命周期正确:启动写、退出清、stale 条目可按 pid 存活检测剔除。
- [ ] Local Daemon Token 文件契约与回环校验完全不变;既有 token/绑定 HTTP 测试直接打独立进程仍绿(非回环携带 Local Token 仍 401)。
- [ ] stub daemon 脚本交付,可驱动 spawn/attach/stop/崩溃各分支。
- [ ] 手动验收:裸 daemon 下移动伴侣可查看 Timeline 并发送消息。
