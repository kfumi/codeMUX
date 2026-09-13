# 01 — daemon 侧浏览器接入基座

**What to build:** daemon 具备托管网页端的能力。Companion server 对非 loopback 来源的 HTTP/WS 请求按白名单校验 Origin（loopback 行为不变），并直接提供统一前端构建产物的静态服务（SPA 回退、no-store）。浏览器打开 `http://127.0.0.1:<port>/` 能加载统一前端页面。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 非 loopback 请求 Origin 校验矩阵生效：白名单内放行、恶意来源拒绝，覆盖 HTTP 与 WS 握手；loopback 请求行为不回归
- [ ] 统一前端产物由 daemon 提供 SPA 服务，入口页可达、深链回退到入口、缓存策略正确
- [ ] router 级测试覆盖上述放行/拒绝矩阵与静态服务行为
