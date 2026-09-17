# CodeMUX 项目长期备忘（精简版；详见 .workbuddy/memory/ 每日日志）

## 验证判读约定
- **既有失败项**（非新改动引入，按文件归属判断，勿看退出码）：`cargo clippy` 16 个错（model_provider.rs:159、lib.rs:12、agent/fork.rs、companion/*、config/types.rs:149、scheduled_tasks/*、services/git.rs、session.rs:169、pi_history.rs:1389）；`npx tsc --noEmit` 5 个错（ImportSessionsDialog.tsx:7、ProviderConfig.tsx:283/654、daemon-facade.ts:645、logger.ts:79）。
- **测试抖动**：`CodeMuxAssistantRuntime.test.tsx` 极重（单文件 100s+，:1701/:2049 各 20-30s 压超时边界）；全量并行时 :1701 基线也超时。失败先做基线对照（还原 HEAD 跑一遍），勿判新回归。并发跑 cargo 编译会让 sidecar 子进程类测试（piRuntime 等）超时：同批隔离 64/64 过且快 5 倍。

## 工具环境（Windows 本机）
- bash 工具不可用（缺 dirname/ls/grep），用 PowerShell 或专用工具。PowerShell 验证输出要 `Out-File -Encoding utf8` 重定向到文件再 Read。沙箱拦截 `"HEAD:$var"` 插值，写 `('HEAD:' + $var)`。`run_in_background` 的 Bash 不可用，后台走 PowerShell。
- 改 `src-tauri/` 后必须 `npm run build:daemon` 且重启 daemon；改 sidecar 源码必须重建。

## 性能硬约束
- **sidecar stderr 日志必须 env 门控**（stderr 同步写阻塞事件循环）。开关：`CODEMUX_MESSAGE_DEBUG`、`CODEMUX_STREAM_DEBUG`、`CODEMUX_OPENCODE_DEBUG`。
- **streamdown 块级 memo**：`markdown-text.tsx` 的 components/plugins/controls 必须模块级常量，否则流式退化为全量重解析。`CODEMUX_MARKDOWN_STREAMDOWN_PROPS` 流式/静态两路径共用。
- **流式 flush 语义勿"优化"**（agentStore.ts:254）：非 Claude leading-edge+trailing（首字立即上屏是有意设计）；Claude trailing 100ms。批次不均匀是正解方向（分帧揭示），减少批次数是错方向。
- **事件管线**：`SessionEventHandler` 入参 `string | object`，WS 传对象，禁止中间层 stringify→parse 往返；消费者仅在字符串入参时解析。
- **事件体积**：唯一出口 `sidecar/src/boundEventVolume.ts`（writeJsonLine 调用），新输出必须走 emit()/writeJsonLine。绝不截断：`file_snapshot.original_content`、assistant/user message content。`tool_finished.content` 是热体积（Read/Bash 输出）；Write 整文件在 `tool_started.input`。`ingest_sidecar_event` 是 sidecar 行唯一解析入口。
- **转换路径**：`createEventPart` 深拷贝已用 WeakMap 按事件身份缓存，勿新增按转换重复的深拷贝；`assistantMessageIdentity.ts` 引用优先协调勿破坏。

## 性能方法论（实测教训）
- **不要用"应该会很贵"下结论**（已三次误判）。实测 WS 帧率仅 4–12/s，否决了"daemon 帧合并协议改造"。
- `<Profiler id="AgentThread">`（AgentPanel.tsx:511）只包消息树；`convertAgentEventsToAssistantMessages` 在其上层，不在测量内。
- **长任务/秒区分节流 vs 真阻塞**：FPS 低且长任务 0 = 节流/遮挡；非 0 = 真阻塞。
- `webPreferences.backgroundThrottling` 必须为 false（desktop-electron/src/main.ts），否则失焦窗口 rAF/定时器被节流。
- **动效/样式异常先排除环境偏好**：系统"减少动效"命中过一次（globals.css 有通配规则，已分档处理：负载类动画保留降速 2.4s 且需写回 animation-name）。headless Chrome `--dump-dom` 探针页可确定性读回 matchMedia/CSS 计算值（Add-Type 被拦截）。
- **Radix Presence 坑**：强制 `animation-name: none` 会让卸载握手前停在自然尺寸，制造布局抖动；应保留动画恢复时长。`collapsible-down/up` 是全应用唯一动布局（height）的动画。
- **`scrollbar-gutter: stable` 对叠加式滚动条预留为 0**（Win11 Fluent 实测），保护不了叠加/经典模式切换。**但注意**：探针抓到的"`ow` 恒定而 `cw` 变 10px"**不是模式切换**，而是 `@assistant-ui/react` 的 `useScrollLock` 在 200ms 动画窗口内给视口写内联 `scrollbar-width: none`（gutter 一并塌陷）；且多折叠组件共享同一视口时，锁重叠会让 `padding-right` 补偿值永久累积（每轮 +10px，内容区渐进变窄）。已用自研 `src/hooks/useCollapsibleScrollLock.ts`（只钉 scrollTop、不碰滚动条/padding）替换三处引用，细节见 2026-09-17 日志。
- 布局闪动探针：`src/lib/dev/layoutFlickerProbe.ts`（浮层按钮，常驻按帧记录 ow/cw/ch/sh/st/pw + 滚动锁痕迹）。
- 平滑度度量 `lib/streamSmoothness.ts`：CV 与 p95 必须同看（停顿流 CV=0 完美，靠 updatesPerSecond 识别）；别把被节流帧当停帧。种子化突流：`lib/dev/burstyStreamSchedule.ts`。
- 分帧绘制：策略在纯函数 `streamTextReveal.ts`，时钟 `useStreamingTextReveal.ts`；提交必须节流且闸门模块级共享（minFrameMs=40），否则 Markdown+Shiki 提交吃满主线程冻住全应用动效（撞过）。调节开关 localStorage `codemux:textRevealHorizonMs`/`textRevealMinFrameMs`。

## Paseo 参考（D:\project\my-project\paseo，流畅性显著更好）
先读 `docs/agent-stream-performance.md` 与 `docs/timeline-sync.md`。五道边界：体积 64KiB 截断（进管线前）、60ms 语义拼接合并、rAF+48ms 兜底提交、分帧揭示（ceil(backlog×elapsed/150ms)）、tail/head 身份域三层 memo。它无数据库、序列化一次复用、selective delivery。度量照搬：chars-per-frame CV + 更新间隔 p95，累加所有 assistant-message 长度。

## 已否决方向
- daemon 逐事件广播合并帧（帧率实测仅 4-12/s，纯文本流式期间重测前勿动协议层）。

## 内置字体（外观设置）
- 真实现方式照抄 PI-Desktop：**每个字体一个完整单文件 woff2**，`font-family` 用人类可读名、不带 `Variable` 后缀（该后缀猜错一次会导致选择后不生效）。
- CodeMUX 落点：woff2 + OFL 许可证放 `public/fonts/`（**刻意不走 Vite 资产管线**），`@font-face` 写在 `src/styles/fonts.css`（`/fonts/*.woff2` 绝对路径），`main.tsx` import 该 CSS；`src/lib/appearance.ts` 的 `BUILT_IN_FONT_FAMILIES` 是选择器显示名→真实字体族的唯一映射，改名需与 fonts.css 同步。
- **禁止**：用 `@fontsource*` 包（数百 unicode-range 分片）或把 7MB 级 CJK woff2 放 `src/assets/` 走 Vite 资产管线。

