# 10 — 移动伴侣开关与托盘生命周期

**What to build:** 「移动伴侣」只控制局域网/中继暴露，不杀回环 Daemon。点窗口关闭则藏到托盘，正在跑的 Session 与 Scheduled Task 不中断；托盘「打开」接上已有 Daemon；托盘「退出」才停 Daemon、Sidecar 与回环。二次启动只激活已有窗口。Daemon 崩溃时窗口可重试，Composer 草稿不丢。本票仍允许 Daemon 与壳同进程。

**Blocked by:** 02 — 回环 Daemon 与 Local Daemon Token；04 — 桌面对话写路径走协议

**Status:** implemented（开关语义与托盘生命周期已落地；人工验收待补）

- [x] `companion.enabled=false` 停配对码、局域网与中继，不停回环、不停 Sidecar、不停 Scheduled Task；文案不暗示本机权威已关闭。
- [x] 关闭主窗口隐藏到托盘后，进行中的一轮与托盘外的发送/审批（若 UI 不可用则至少 Daemon 侧 turn 不因隐藏而中断）仍成立。
- [x] 托盘「打开」恢复窗口并复用已有 Daemon Client 连接，不必重放「启动全部会话」。
- [x] 托盘「退出」停止 sidecar、Companion Server（含回环）再退出壳。
- [x] 已在托盘运行时再次启动只激活已有窗口，不拉起第二份回环监听、不抢 SQLite。
- [ ] Daemon 崩溃或回环断开：窗口提示并可重试；Composer 未发送草稿仍在。
- [ ] 内置浏览在关移动伴侣、藏窗口再打开后仍按 Browser Host 停放/恢复，不被本票误毁。
- [x] 不把 Daemon 拆成独立系统服务。

## Comments

**2026-09-13 实现说明**

- **本轮补齐的是「移动伴侣」开关本身**：壳退役时删掉了 `commands/companion.rs`，daemon 侧却一直没有对应 HTTP 路由，渲染层打 `/api/companion/*` 只能被静态服务兜底接住——`POST` 拿到 `405`（`Allow: GET, HEAD`），`GET /api/companion/status` 拿到一份 `text/html` 的 `index.html`，于是点开侧栏「移动伴侣」直接报 `Daemon request failed: 405`。新增 `src-tauri/src/companion/routes_companion.rs`，把原 Tauri 命令面按同一 JSON 形状搬到 daemon：`GET /api/companion/status`、`POST /api/companion/enabled`、`POST /api/companion/pairing-code/refresh`、`POST /api/companion/relay/enabled`、`POST /api/companion/relay/config`。
- **管理面鉴权**：这 5 条路由要求「回环来源 + 有效令牌」(`authorize_companion_admin`)。配对手机即便持有有效 Pairing Token 也不能远程开关桌面暴露策略（非回环来源一律 `403 Companion settings are available on loopback only`）。
- **开关语义**：`companion.enabled` 只控制局域网/中继暴露与配对 UI。开启 = 按 `listen_address` 重绑监听器并同步中继；关闭 = 停中继、清配对码、退回回环监听；两种情况都不停回环 Daemon、不停 Sidecar、不撤 Local Daemon Token。
- **重绑改为后台任务**：重绑会优雅关闭「正在服务这条请求」的监听器，同步重绑等于等自己这条连接排空——实测卡满 5s 超时并打告警，在不能同端口二次绑定的平台上更会因为端口没释放而绑定失败。现改为先落配置与意图状态、立刻返回，重绑在后台做；失败时收回开关、恢复回环监听并把原因写进 `daemon_error`（`SessionList` 已有的告警位会显示）。开启失败不会把 daemon 留在「没人在听」的状态。
- **端口与令牌的两个副作用**：① 状态与重绑都用监听器**真实**在听的端口（带 `--port` 覆盖启动时它不等于 `config.companion.port`，否则二维码会指向没人听的端口）；② Local Daemon Token 只在冷启动轮换，开关触发的重绑不再轮换，避免把已经连着的桌面端/CLI 一脚踢下线。监听器加了一代次守卫，正在退出的旧监听器不会把新监听器的运行标志抹掉。
- **daemon 启动跟随持久开关**：`run_daemon_standalone` 启动时读 `companion.enabled`，为真就按局域网暴露启动；绑定失败只告警并退回归环，不让 daemon 起不来。
- **测试**：`routes_companion` 新增 6 个用例（无令牌 401 而不是 405、`status` 返回 `application/json`、非回环来源 403、配对码只在暴露时存在、E2EE 公钥透出、开关重绑后端口真的在听）；`state` 新增代次守卫用例。`cargo test --lib` 484 passed；冒烟（独立 app-data 目录 + 独立端口）逐条验证 5 条路由：开关即时返回、`port` 与真实监听一致、配对码 6 位、`refresh` 换新码、无端点开中继返回 400 `请先填写中继端点`、局域网地址访问管理面 403、开关前后 Local Daemon Token 不变。
- **托盘与窗口生命周期**（本票其余部分）在此前的 Electron 壳工单里已落地：关窗 `preventDefault + hide` 到托盘、托盘「打开」只 `show()` 复用同一个渲染层与 Daemon Client、「退出」先 `automation.stop` 再 `supervisor.stopManaged()`（只停自有 child）、`requestSingleInstanceLock + second-instance` 二次启动只激活已有窗口，Daemon 仍由壳 spawn、不做独立系统服务。
- **待人工验收**：① Daemon 崩溃/回环断开时的 overlay 重试与 Composer 草稿保留（overlay 与 `daemon-lifecycle → store` 标记均有实现与单测，端到端未验）；② 关移动伴侣、藏窗口再打开后内置浏览的停放/恢复；③ 手机扫码三形态实测。
