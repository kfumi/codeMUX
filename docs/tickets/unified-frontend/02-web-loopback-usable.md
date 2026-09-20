# 02 — 网页端同机可用（bootstrap 统一 + loopback 配对引导）

**What to build:** 同机浏览器首次访问时，统一前端的 daemon 配置解析单入口按宿主形态选择引导策略（桌面壳桥注入 / loopback 简化配对 / Pairing 引导），能力清单按宿主形态输出三级能力集（shell-only 能力隐藏而非报错）。loopback 首次配对经壳或 CLI 呈现的一次确认完成，拿到 Pairing Token 后进入完整会话界面，收发消息、看时间线。桌面壳体验不回归。这是阶段一验收点：网页端从此可用。

**Blocked by:** 01 — daemon 侧浏览器接入基座

**Status:** implemented（人工验收见「待验证」）

- [x] 桥注入 / loopback 配对 / Pairing 引导三条路径各自解析出正确连接配置，桌面行为与现状一致，桥缺失显示引导界面而非报错崩溃
- [x] 三级能力集满足"桌面 ⊇ 浏览器 ⊇ 移动"，shell-only 能力（Browser Host、窗口控制、更新器、对话框等）在浏览器形态隐藏
- [x] loopback 一次确认配对后，浏览器可完整进行会话收发与时间线回放（代码路径 + router/单元测试；端到端人工验收见下）
- [x] bootstrap 解析与能力清单有纯 TS 测试
- [ ] 配对引导全流程人工验收（需要一次 `npm run dev:desktop` + 浏览器实测）

## Comments

**2026-09-13 实现说明**

- **引导单入口** `src/lib/bootstrap/index.ts`：`classifyBootstrapTarget` 选路（壳桥 > 已配对档案 > 携带配对输入 > 同机简化配对 > 跨机配对码），`bootstrapDaemonConnection` 只负责「连上/连接中/要配对」三态；`src/lib/daemon-bootstrap.ts` 退化为兼容导出，既有调用点（SessionList 重试入口等）不动。
- **loopback 简化配对全链**：daemon 新增 `POST /api/pair/local/request`、`GET /api/pair/local/request/{id}`（仅 loopback 来源）与 `GET /api/pair/local/pending`、`POST /api/pair/local/decision`（走既有 `authorize`）。批准时复用 `complete_pairing` 颁发普通 Pairing Token；token 只在浏览器轮询响应里出现，决策响应不回传。daemon 侧同时 emit `web-pairing-request` UI 事件 → 壳转发渲染层 → `WebPairingConfirmHost` 弹一次确认。**Local Daemon Token 没有任何浏览器下发途径**（ADR 0011 不破）。
- **能力清单运行时分流** `src/lib/host/host-capabilities.ts`：由 `CAPABILITY_MANIFEST` 的 owner 派生，协议能力三形态一致、shell-only 在浏览器/移动收敛；组件侧已接入的落点：内置浏览器入口（SidePanel 下拉 + 空状态）、窗口控件与窗口菜单（TitleBar）、自动更新入口（UpdateEntry）、目录选择入口（SessionList「添加项目」、草稿工作区「打开文件夹」）。
- **外链不设「隐藏」而是降级**：`openExternal` 在壳内仍走 main 的 `shell.openExternal`，浏览器形态退化为新标签页 —— 外链是消息内容，隐藏它等于制造死链（`src/lib/facades/shell-facade.ts`，测试同步更新）。
- **发布链路**：`npm run build:web`（`vite build --outDir dist-web`）+ `build:electron-installer` 前置构建 + `electron-builder.yml` extraResources 注入 `dist-web`；daemon 静态目录解析链 = 配置覆盖 → 打包 dist-web → 源码树 dist-web（仅开发）→ 移动端产物兜底。
- **浏览器宿主与移动形态共存**：`dist-web` 存在时所有浏览器形态（PC/手机）都吃统一产物；移动端独立构建仍在，退役见工单 04。
- 已知基线问题（非本工单引入）：`npx tsc --noEmit` 有 7 条既有错误（`context-display.tsx`、`ImportSessionsDialog.tsx`、`ProviderConfig.tsx`×2、`daemon-facade.ts:643`、`logger.ts:79`）；全量 vitest 有 3 条既有失败（`McpSettings`×1、`SkillsSettings`×2，均与 gemini 图标位相关，改动文件未触及）。

**2026-09-13 人工验收回归修复（浏览器形态设置页）**

- **现象**：同机浏览器进设置页，内容区整块显示「渲染错误 codemuxDesktop 桥不可用(Electron preload 未注入)」。
- **根因**：`shellFacade` 在桥缺失时**同步抛出**，而 `GeneralSettings` 读的是 `.then().catch()`——异常越过 `.catch` 冒到 `App` 的错误边界，把整块设置内容打成错误页。这不是单点疏忽而是门面契约问题：任何 `void facade.x().catch(降级)` 的调用点都接不住。
- **修复**：`shellFacade` 所有壳方法改经 `bridgeCall`，桥缺失/同步异常一律折叠为 rejected Promise（`desktopDialogs` 早已是 async，注释补约定；`desktop-bridge` 导出统一错误文案，`systemFonts`/`bootstrap` 复用）。`facade-boundary.test.ts` 的同步抛出守卫改为「每个壳方法都不同步抛错且以 rejection 报错」的行为断言。
- **壳独占控件按用户故事 10 隐藏而非报错**：`CAPABILITY_MANIFEST` 新增 `host.app-paths` / `host.logs` / `host.env-check` / `host.agent-cli`（本机应用数据目录、Electron 日志、本机 PATH 环境探测、外部 CLI 安装升级）；设置页据此隐藏「配置文件」区块（常规）、「日志」「系统工具」入口（导航）、「浏览器数据」清理（浏览器控制，`browser.host`）、「检查更新」（关于，`updater`）与「外部 CLI 诊断」（智能体运行时），并在「关于」标注当前宿主形态。
- **验证**：`npx vitest run` 1439 passed / 3 failed（仍是既有 McpSettings×1、SkillsSettings×2 基线失败）；`npx tsc --noEmit` 仍是既有 7 条错误；`npm run build:web` 后 daemon（127.0.0.1:9240）托管的新产物可正常加载。
