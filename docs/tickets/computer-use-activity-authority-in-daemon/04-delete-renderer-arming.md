# 04 — 并存期收尾：删掉渲染层的武装路径

**What to build:** 删掉第二条真来源。渲染层不再算「该不该武装」、不再发心跳，只服务这条路径的桥接方法与 IPC 通道（`codemux:emergencyStopArmed` / `codemux:emergencyStopHeartbeat`）与渲染层心跳定时器一并退役；提示条与全局 Esc 从此完全由 daemon 的活动事件驱动，并存期的「只能加不能减」优先级规则随之作废。

删之前先核对其他用途：判定工具名的那部分逻辑可能还被审批卡等地方使用，只删武装路径，别误删仍在用的东西。删除后 spec 的验收 A–D 必须在没有渲染层参与的情况下全部仍然成立 —— 这是并存期结束的硬门槛。

**同时退掉看门狗这一半（03 的直接推论）：** 03 把武装判定收成「链路在 ∧（daemon 活动 ∨ 渲染层举手）」，看门狗只喂渲染层那一半、只守渲染层猝死。渲染层来源一删，`armed-heartbeat.ts` 就永远没人喂 —— 它连同 `ARMED_HEARTBEAT_INTERVAL_MS` / `ARMED_HEARTBEAT_TIMEOUT_MS` 常量、`dropRendererSource`、`render-process-gone` 那条收尾钩子一起退役，活性判据只剩控制面链路（daemon 链路心跳：15s 探测 / 45s 判死）。渲染进程被杀不再需要单独处理：它已经证明不了任何东西，也没有第二份状态可清。

**Blocked by:** 03 — 壳按 daemon 事件显示与急停：无人值守也看得见、停得下

**Status:** ready-for-agent

- [ ] 渲染层不再有任何武装/心跳路径：通道名与心跳定时器在代码与测试里都搜不到
- [ ] 无人值守回合仍可见可停；渲染进程被杀不影响提示条与 Esc 语义；审批粒度、限时授权、步数上限口径不变（对应 spec 验收 A–D）
- [ ] 只服务旧路径的桥接方法、IPC 通道、失效测试一并删除；仍被其他用途使用的工具名判定保留且仍有测试
- [ ] 壳侧测试与前端全量测试通过；`apps/desktop` 与根 typecheck 通过
- [ ] CHANGELOG 记一条「渲染层武装路径退役」
- [ ] 只守渲染层那一半的看门狗路径一并退役（`armed-heartbeat.ts`、`ARMED_HEARTBEAT_*`、`dropRendererSource`、`render-process-gone` 钩子、`computer-use-arming.ts` 里的 `rendererArmed` 半边），活性判据只剩 daemon 链路
