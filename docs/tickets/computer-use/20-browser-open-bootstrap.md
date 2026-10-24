# 20 browser_open 自举对：内置浏览器没有页面时，工具面自己能开一个

**What to build:** 补掉浏览器控制的启动缺口 —— 此前工具面的隐含前提是「内置浏览器里已经有页面」：没有页面时 `browser_list` 返回裸 `[]`（成功但无路可走），其余工具全部 `browser not found: (none)`，模型既不知道原因也没有任何工具能新建页面。2026-10-24 实测（会话 `e6743022`，opencode 内核）：agent 第一反应 `Target.createTarget` 被拒后，降级到电脑控制去逆向桌面上另一个应用的 asar 找「浏览器面板开关」，两分钟后用户放弃。本票加一对自举工具：`browser_open(url)` 经壳请求渲染层在内置浏览器里开新页面并回 `browserId`；`browser_navigate(url)` 给已开页面改 URL。同时把「空列表」「找不到页面」两种状态改成带下一步指引的结果/报错。

**Blocked by:** 01 浏览器 MCP 控制（op 面与端点）、03 技能与审批（Input 分级与敏感判定）、07 渲染层 webview 托管（页面生命周期在渲染层）

**Status:** done

## Decisions

- **open 是「让页面出现」的唯一入口，走渲染层而不是壳直开。** 页面托管在渲染层（`<webview>` + browserStore，工单 07），壳的 main 进程没有开标签的能力。链路：daemon `open` op → 壳 automation 客户端 → `browser-agent-open` IPC 事件 → 渲染层 `browserHostBridge` 开页 → `browserAgentOpenResult` 通道回 `browserId` → 壳轮询 guest 登记表确认可操作 → 回 daemon。协调逻辑收在 `apps/desktop/src/browser-agent-open.ts`（纯依赖注入，不 import electron，可单测）。
- **回给模型的 browserId 必须立刻可用。** 渲染层回包只代表「store 里有了这个页面」，webview 的 `did-attach` + `browserRegisterGuest` 还没发生 —— 不等的话下一发 `browser_snapshot` 又是 `browser not found`，等于把缺口推迟一步。壳侧拿到 browserId 后轮询 `resolveTarget`（100ms 步进，上限 6s），guest 登记表认得它才回成功。
- **超时预算三级嵌套，外层包住内层。** 渲染层回包等待 5s（`AGENT_OPEN_REPLY_TIMEOUT_MS`）+ guest 轮询 6s（`AGENT_OPEN_GUEST_WAIT_MS`）< daemon 等待 15s（`AUTOMATION_REQUEST_TIMEOUT`）。渲染层正常在百毫秒级回包，超时基本意味着「不是 Electron 宿主 / 界面没加载」，等下去只会耗光 daemon 的整段窗口。
- **落点策略对齐既有弹窗路径的预期。** 侧面板正显示浏览器标签 → 在该标签里开新页（当前是没动过的空白页就复用，不叠空白）；否则 `openBrowserTab(url)` 新开浏览器标签（面板随之打开并激活）—— 与 `target=_blank` 弹窗兜底（`dispatchBrowserNewWindow`）同一套「用户看得见」的语义。
- **open/navigate 自动落 Input 分级，不另开审批口径。** 两个 op 不进 `READ_ONLY_OPS`，按既有规则：严格档逐次放行（审批卡显示 URL 摘要，`action_summary` 新增两条）、限时授权可覆盖、URL 命中敏感词（login/pay/密码…）自动强制人工确认 —— 与 click/type 同一套护栏，零特判。
- **URL 三层校验，层与层不互相信任。** daemon 端点（必填 + 绝对 http/https + ≤2048，400 带可读文案）→ 壳 op 执行（scheme 前缀再拦）→ 渲染层 guest 的 `will-navigate` 拦截兜底。navigate 的实现用 `location.assign` 经页面发起，恰好过最内层拦截，而不是绕过它。
- **空列表与找不到页面从「事实陈述」改成「下一步建议」。** `list` 空结果不再回裸 `[]`，回 `{pages: [], hint: 用 browser_open 打开,不要用 computer_* 绕路}`（daemon 端点统一改写，CLI 等直连调用方同样受益）；`browser not found` 报错保留既有前缀（兼容断言）并追加指引。失败在第一次出现时就变成可执行的建议，而不是让模型自己猜。
- **清单/计数同步涨到 12 + 15。** `tools/list`、开关过滤（只开浏览器控制 = 12 个 `browser_*`）、设置页工具数三者同源（`visible_tool_definitions` / `visible_tool_names`），计数断言（27 全开）与 op 覆盖断言（`ops_reachable`）一起更新；渲染层轨迹回放的工具名单（`browserToolShots`）与工具头显示名（`toolHeaderSummary`）补两个新名。

## Checklist

- [x] daemon：`AUTOMATION_OPS` 增 `open`/`navigate`（15 个）+ 端点 URL 校验（400 + 审计 `gate: invalid url`）+ 空列表改写 `empty_list_payload`（单测：`bootstrap_ops_are_accepted`、`open_url_validation_matrix`、`empty_list_payload_carries_next_step_hint`；集成：`open_and_navigate_reject_non_http_urls_with_400`、`empty_list_result_carries_bootstrap_hint`）
- [x] daemon：`browser_open` / `browser_navigate` 工具定义、分组登记、`call_tool` 分发、`browser_list` 描述补空列表指引（计数断言 10→12 / 25→27 同步）
- [x] daemon：`action_summary` 两个新 op 的动作摘要（URL 上卡，非秘密键）+ `open_and_navigate_summaries_show_the_url`
- [x] 壳：`browser-agent-open.ts` 协调器（requestId 关联 / 5s 超时 / 无窗口快速失败 / 迟到回包丢弃 / dispose 收口；7 条契约测试）；`browser-automation.ts` open 分支（scheme 校验 + guest 轮询）与 navigate 分支；`browser not found` 文案带指引
- [x] 壳接线：main.ts 协调器创建与 `openViaRenderer`、shell-bridge `browserAgentOpenResult` 通道、preload 方法、退出 dispose
- [x] 渲染层：`desktop-bridge.ts` 载荷与方法类型；`browserHostBridge.ts` `openAgentBrowserPage`（落点策略）+ `dispatchBrowserAgentOpen`（回包）+ `initBrowserHostBridge` 订阅 `browser-agent-open`（可选调用，容忍旧 preload）；`browserToolShots` / `toolHeaderSummary` / `builtinMcp` 注释
- [x] 渲染层测试：复用空白页 / 已有内容开新页 / 无浏览器标签新开并等页面出现 / 非 http 拒绝 / dispatch 成败回包（`browser-agent-open(自举对)渲染层执行面` 5 条）
- [x] 门禁：`cargo fmt`、`cargo clippy -D warnings`、`cargo test`（builtin_mcp / browser_automation / approval / 集成套件）、`apps/desktop npm run typecheck`、根 `npm run typecheck`、受影响 vitest 全绿、`npm run build:daemon`

## Comments

- **为什么不做 `browser_launch`/会话管理那套更大的面**：对齐 zcode browser-use 官方插件形态（start_session / 元素高亮 / 录制）是方向 C，要先落 spec；本票只补「无页面时无路可走」这一格，改动集中在既有链路上，可独立回滚。
- **steer 打断在途 computer 动作、第三方应用护栏**是实测事故里暴露的另外两个缺口（见 `docs/research/` 对应分析），不在本票范围。
