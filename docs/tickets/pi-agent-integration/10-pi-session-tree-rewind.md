# 10 — pi 会话树 rewind（二期）

**What to build:** pi 会话的用户消息级 rewind，复用现有 rewind UI 与 `rewind_agent_session` 命令管线。pi 原生历史是树形 JSONL 且 pi 进程持有 RPC 连接，不能像 Claude/Codex 直接截断文件：Rust 侧解析目标条目 id 后经 sidecar 新增 `rewind_conversation` 命令调 pi 原生 `fork {entryId}`（0.73.1 RPC 无 get_tree/navigateTree；fork 默认 position=before，回退到目标用户消息之前并返回其文本），pi 在原文件同目录新建 branched 会话文件（原文件与树历史不动、`parentSession` 头回指）并在进程内 rebind（无需重建子进程）。宿主随后 upsert Native mapping 指向新文件并重建时间线（branched 文件无消息条目时清空时间线；mapping 保留——空 branched 文件仍是可恢复的原生会话，不删不发 reset_session）。目标定位三级：providerMessageId（pi 转换器已把条目 id 写入 provider_message_id，时间线原样带回，精确命中即目标，不校验指纹——树条目不可变，展示层剥离造成的文本差异合法）→ turnOrdinal（第 N 条可回退用户消息，1-based，指纹校验，不一致报错）→ 无 locator 取活动链最新条目。可回退口径对齐前端 `isRewindableUserEvent`（文本非空或含图片；tool_result 条目不算用户消息），只扫活动链（select_pi_active_chain）。PiRuntime.forkToEntry 守卫：turn 进行中 / 有挂起审批或提问时拒绝；完成后更新 agentSessionFile 与 config（canReuse 以新文件比对，宿主更新 mapping 后不误触发重建）。仅支持 conversation 模式（pi 无文件快照）。

**Blocked by:** 07

**Status:** done

- [x] PiRuntime.forkToEntry（fork RPC + cancelled 映射 + readSessionIdentity 回读新文件 + config 同步）
- [x] dispatcher 新增 `rewind_conversation` 命令（仅 pi flavor；`session_rewind_conversation_result` 回包，模式照抄 rewind_files）
- [x] Rust：session_lifecycle 新 waiter 管道（SessionRewindConversationWaiters + parse + 事件循环接线）
- [x] Rust：rewind_agent_session pi 分支（文件校验 → resolve_pi_rewind_entry_id → sidecar fork → upsert mapping → reload timeline）；`is_rewind_user_value` 注释更新
- [x] pi_history：collect_pi_rewindable_users（活动链 + 前端口径）+ resolve_pi_rewind_entry_id 三级定位；4 个新测试（id/ordinal+指纹/最新/非 pi 文件拒绝）
- [x] 前端：AGENT_REWIND_CAPABILITIES.pi conversation=true（UI 全由能力表驱动，零组件改动）+ 能力断言测试
- [x] gate：sidecar 581/581 全绿；Rust lib 448/448 + fmt/clippy/check 干净（存量 clippy 告警在本 diff 之外）；根套件 5 文件/18 失败经 stash 基线核对与存量一致，零新增
