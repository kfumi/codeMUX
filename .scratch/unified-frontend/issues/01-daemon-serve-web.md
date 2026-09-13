# 01 — daemon 侧浏览器接入基座

**What to build:** daemon 具备托管网页端的能力。Companion server 对非 loopback 来源的 HTTP/WS 请求按白名单校验 Origin（loopback 行为不变），并直接提供统一前端构建产物的静态服务（SPA 回退、no-store）。浏览器打开 `http://127.0.0.1:<port>/` 能加载统一前端页面。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 非 loopback 请求 Origin 校验矩阵生效：白名单内放行、恶意来源拒绝，覆盖 HTTP 与 WS 握手；loopback 请求行为不回归
- [ ] 统一前端产物由 daemon 提供 SPA 服务，入口页可达、深链回退到入口、缓存策略正确
- [ ] router 级测试覆盖上述放行/拒绝矩阵与静态服务行为

## Comments

**2026-09-13 实现说明（code-review 后补记）**

- **Origin 校验语义比 spec 字面更严**：除 Origin 白名单外，还要求非 loopback 请求的 Host 为 IP 字面量或白名单来源的 authority——域名 Host 一律拒绝，堵住 DNS-rebinding 绕过同源检查的路径。纯函数 + router 级测试均已覆盖。
- **WS 握手覆盖方式**：非 loopback 拒绝用 router oneshot 测试；回环升级用真实 TCP 握手测试（oneshot 无法模拟连接升级，axum 返回 426 "no upgrade state"）。
- **统一前端产物默认不顶替移动端 PWA**：静态目录解析链 = 配置 `web_static_dir`（需存在）→ 打包资源 dist-web → 移动端产物兜底。当前演示网页端需在 config.json 的 `companion.webStaticDir` 指向 `dist/`。dist-web 的打包接线随工单 02/04 的发布链路落地。
- **SPA 回退由 `not_found_service` 改为 `fallback`**：tower-http 0.6 的 `not_found_service` 会把回退响应强制改写为 404 状态，深链刷新会拿到带 404 状态的入口页；改用 `fallback` 后深链返回 200。
- **放行列表启动时解析一次**（`AllowedOrigins`），请求路径只做匹配；static_dir 覆盖与列表同锁快照，修改随 server 重启生效。
- 遗留（既有债务，非本工单）：`cargo clippy -D warnings` 在干净基线上即有 18 个警告，本工单改动文件已确认零新增。
