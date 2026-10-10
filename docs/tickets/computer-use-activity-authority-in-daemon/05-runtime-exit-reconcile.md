# 05 — 运行时在回合结束前退出：按终态对账

**What to build:** agent 运行时（sidecar 子进程）在回合结束前退出或事件流断掉时，daemon 要把这一回合**按终态收口**：

- 清回合真值：`finish_turn`（`turn_active` 移除 + 广播 `{"type":"state","running":false}` + 队列取出）
- 清电脑控制活动 + 发控制面 `computer-use-activity`（提示条收起、全局 Esc 解除）
- 队列里排着的用户消息按同一收尾路径派发（不丢消息）

触发点就是事件泵的流关闭处（`crates/daemon/src/agent/session_lifecycle.rs` 的 `Sidecar stream closed`）——那里今天只写一行 info 日志。判据必须**只在「这个回合还挂着」时**才收口：正常结束的回合（终态事件先到）流再关时必须什么都不做，不能让对账去重复收尾、重复广播、打扰队列。

不给客户端合成假的 agent 事件（不污染时间线）：界面收尾靠 daemon 的 `state` 帧 —— 渲染层已有 `settleIdleTurnFromState` 兜底路径，此前缺的正是 daemon 这边如实报出「回合已经不在了」（`isSessionTurnActive` 一直为真）。

**为什么算这一族的问题：** 工单 01 的活动真值 = 标记 ∧ 回合真值。运行时猝死时回合真值不收口，活动就跟着挂着 —— 提示条一直在屏幕上、全局 Esc 一直被占（工单 03 之后这条不再是「进程内的小账」，而是用户看得见、按不动的状态）。spec 的「风险与开放问题」把这件事写成「进程退出对账」，本票就是那一条。

**Blocked by:** None（与 01/03 相关但不依赖 04）

**Status:** done

- [x] 回合中事件流断掉 → `is_turn_active` 立刻为假（`a_runtime_that_dies_mid_turn_is_reconciled_as_terminal`）
- [x] 同一次对账把电脑控制活动清空并广播（控制面 `computer-use-activity` 报 `active=false`）
- [x] 会话订阅者收到 `{"type":"state","running":false}`（界面不再卡在「正在执行」）
- [x] 已正常结束的回合（终态事件先到）流再关：不重复收口、不重复广播
- [x] 「死掉的是不是当前这条 sidecar」这个身份判据在泵里成立（换了新 sidecar 的会话不该被旧泵的关闭收口）—— 判据本身有单测（`same_channel_distinguishes_spawns_but_survives_rebinding`），泵里的组合只有代码复核 + 反向推理，没有集成用例
- [x] 集成测试覆盖上面 1–4；门禁全绿（fmt / clippy / check / test / build:daemon / check:size）

## Decisions

- **触发点在事件泵的流关闭处，而不是另加一个「agent 进程监控」**：流关闭就是「这条 sidecar 不会再有事件了」的定义，而且它是四个运行时（Claude / Codex / OpenCode / pi）唯一都经过的地方 —— 在别处加守护会漏掉其中几种。
- **复用终态路径，而不是另写一套收尾**：把 `maybe_finish_turn_and_drain_queue` 里「真实终态」那几行抽成 `finish_turn_and_drain_queue`，两条路径共用；顺序契约不变（终态事件那条要先广播事件帧再翻转，对账这条没有事件帧要排）。两套收尾逻辑迟早会漂移。
- **不给客户端合成假的 agent 事件**：时间线里不该出现一条模型没说过的话。界面收尾靠 `state` 帧 + 渲染层已有的 `settleIdleTurnFromState` —— 那条兜底路径本来就要求 daemon 如实报空闲，缺的半边在这里补上。
- **两道守卫缺一不可**：`is_turn_active` 挡住「已经收过尾的回合再被碰一次」；`same_channel` 挡住「旧泵的关闭把新会合作废」。身份比较放在 `SidecarEventBinding` 内部（重绑只换 sink、信道对象不变），而不是另拷一份 Arc 出来比。
- **不回滚、不补文案**：对账只收口状态，不发明一条「运行失败」的消息卡；用户在界面上看到的最后一条内容就是运行时留下的最后一条（与今天一致）。本票不引入新文案。

## Comments

- **门禁**：`cargo fmt --check`、`clippy -D warnings`、`check --all-targets --all-features` 全 0；`cargo test` 768 单测（+1：`same_channel`）+ 集成套件全绿（`tests/computer_use_activity.rs` 5 条，新增 2 条）；`npm run build:daemon` 成功；`check:size` 27 处与 master 同数（`agent/session_lifecycle.rs` 已在冻结基线内：3164 → 3556）。
- **反向验证（实测）**：去掉 `is_turn_active` 守卫 → `a_normally_finished_turn_is_not_reconciled_twice` 变红（`left: 0, right: 1`，队列被二次清空、用户消息会重复派发），其余 4 条仍绿；恢复后全绿。队列是这道守卫唯一可观测的差别（`state` 帧本身幂等：`finish_turn` 只在回合真挂着时才广播）。
- **没有跑真机**：用例直接调对账入口，不起真 sidecar，也没有端到端杀一次 agent 进程；泵里那几行身份判据（`same_channel` 的组合）只有机制单测，没有覆盖组合。
- **覆盖不到的窄竞态**：进程启动瞬间就死时，「流关闭」与 `sidecars.insert` 会竞争，泵先结束 → 被当成「不是当前 sidecar」跳过对账 —— 与今天同行为，不制造新的假收口。
- **测试自己踩的坑**：会话 WS 的查询参数是 camelCase `sessionId`（`WsQuery` 上有 `#[serde(rename_all = "camelCase")]`），写成 `session_id` 会静默连成控制面连接 —— 不报错，只是永远收不到 `state` 帧（第一版就是这样超时的）。
- **范围**：只覆盖 companion 会话这条路径；其他入口不产 companion 回合，本票不动。工单 01 的未达成验收（agent 进程猝死）由本票补上，01 的勾已更新。
