# 04 — 并存期收尾：删掉渲染层的武装路径

**What to build:** 删掉第二条真来源。渲染层不再算「该不该武装」、不再发心跳，只服务这条路径的桥接方法与 IPC 通道（`codemux:emergencyStopArmed` / `codemux:emergencyStopHeartbeat`）与渲染层心跳定时器一并退役；提示条与全局 Esc 从此完全由 daemon 的活动事件驱动，并存期的「只能加不能减」优先级规则随之作废。

删之前先核对其他用途：判定工具名的那部分逻辑可能还被审批卡等地方使用，只删武装路径，别误删仍在用的东西。删除后 spec 的验收 A–D 必须在没有渲染层参与的情况下全部仍然成立 —— 这是并存期结束的硬门槛。

**同时退掉看门狗这一半（03 的直接推论）：** 03 把武装判定收成「链路在 ∧（daemon 活动 ∨ 渲染层举手）」，看门狗只喂渲染层那一半、只守渲染层猝死。渲染层来源一删，`armed-heartbeat.ts` 就永远没人喂 —— 它连同 `ARMED_HEARTBEAT_INTERVAL_MS` / `ARMED_HEARTBEAT_TIMEOUT_MS` 常量、`dropRendererSource`、`render-process-gone` 那条收尾钩子一起退役，活性判据只剩控制面链路（daemon 链路心跳：15s 探测 / 45s 判死）。渲染进程被杀不再需要单独处理：它已经证明不了任何东西，也没有第二份状态可清。

**Blocked by:** 03 — 壳按 daemon 事件显示与急停：无人值守也看得见、停得下

**Status:** done

- [x] 渲染层不再有任何武装/心跳路径：通道名与心跳定时器在代码与测试里都搜不到（清理后只剩历史票面与 CHANGELOG 里的记录）
- [x] 无人值守回合仍可见可停；渲染进程被杀不影响提示条与 Esc 语义；审批粒度、限时授权、步数上限口径不变（对应 spec 验收 A–D）—— 本票是删除动作，A–D 的实现基础在 01/02/03；真机复验仍未做（见 Comments）
- [x] 只服务旧路径的桥接方法、IPC 通道、失效测试一并删除；仍被其他用途使用的工具名判定保留且仍有测试 —— 核对结果：`computerUseActivity.ts` 只有武装窗口在用（无其他消费者），已删；`builtinMcp.ts` 的 server 名识别被工具名归类使用，保留
- [x] 壳侧测试与前端全量测试通过；`apps/desktop` 与根 typecheck 通过
- [x] CHANGELOG 记一条「渲染层武装路径退役」
- [x] 只守渲染层那一半的看门狗路径一并退役（`armed-heartbeat.ts`、`ARMED_HEARTBEAT_*`、`dropRendererSource`、`render-process-gone` 钩子、`computer-use-arming.ts` 里的 `rendererArmed` 半边），活性判据只剩 daemon 链路

## Decisions

- **删除范围以「有没有别的用途」定，而不是以「属于哪张票」定**：先核对工具名判定（`computerUseActivity.ts`）的消费者 —— 只有武装窗口用它；`builtinMcp.ts` 的 server 名识别另有消费者（工具名归类，`toolHeaderSummary.ts` / `McpToolCountBadge.tsx`），所以删前者、留后者。
- **`isQuitting` 守卫一起退役**：它当初存在的唯一理由是「渲染层拿到 false 后会重新声明武装」，渲染层没了就没有对象可挡。退出流程里链路先断（`automation.stop()` → `setDaemonLinkUp(false)` → 解除 + 收起），依然不会在关机过程里重建提示条。
- **`render-process-gone` 钩子整块删掉，而不是留着空转**：它只服务渲染层那一半；渲染进程崩掉不再需要任何收尾 —— daemon 的活动照旧、Esc 照旧。
- **桥面留「通道不存在」而不是加一层拒绝式兜底**：旧渲染层调用已删通道会拿到 invoke 失败并记一条日志，不影响正确性；加兜底只会让「这条路径已经没了」看起来含糊。
- **`computer-use-arming.ts` 保留 `state()`**：诊断与测试要用（现在只剩 `{ armed, daemon, linkUp }`），也给将来「再加一个来源」留下观察点。

## Comments

- **门禁**：`apps/desktop` typecheck 0；根 `npx tsc --noEmit` 0；根 vitest 284 文件 / 2388 测试全绿；sidecar 63 / 764 全绿；`check:size` 27 处与 master **逐条一致**（唯一差异：本就超预算的 `crates/daemon/src/builtin_mcp.rs` 1590 → 1591 行，改的是一句指向被删文件的注释）；`cargo fmt --check` 0；`npm run build:daemon` 成功。
- **反向验证（实测）**：把合成规则改成 `daemonActive`（去掉链路闸门）→「链路还没连上时 daemon 的活动不武装」变红（`expected true to be false`），恢复后 6 条全绿。注意：「链路断了 fail-hidden」那条在去掉闸门后**仍然绿** —— 它由「断链时清掉 `daemonActive`」兜住，只有「从未连上」这一个场景能单独暴露闸门。
- **删除清单**：`apps/desktop/src/armed-heartbeat.ts`（含 6 条契约测试）、`apps/desktop/src/computerUseActivity.ts`（含 18 条测试）、`apps/desktop/test/shell-bridge-arming.test.ts`（4 条）、preload 的两个通道、shell-bridge 的两个 handler 与 `computerUseArming` 依赖、`desktop-bridge.ts` 的两个方法、`main.ts` 的看门狗与渲染层收尾钩子与 `isQuitting`、`useEmergencyStop` 的武装窗口与心跳（22 条测试 → 3 条）。
- **没有跑真机**：本票是删除，验证靠「删掉后剩下的路径仍有测试」+ 上面那条反向验证；A–D 的真机复验（无人值守、杀渲染进程、断链）仍未做过。
- **未实测的组合**：旧渲染层 + 新壳 —— 只有构造性推理（invoke 报「通道不存在」并记日志，提示条与 Esc 仍由 daemon 活动驱动）。spec 的 F 里已如实标注。
