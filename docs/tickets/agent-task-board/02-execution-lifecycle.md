# 02 — 执行生命周期：启动、事件回写与中断恢复（非 worktree）

**What to build:** 任务能驱动一次可见的 agent 执行并完整走完生命周期：用户把待办任务拖到「进行中」列（或点开始），Daemon 校验每项目并发配额（首版默认 1）——占坑成功则进入 `preparing`，在项目目录创建一条可见 Session（项目路径为项目目录），把任务指令作为 User Message 注入，进入 `running`；配额占满则任务进入 `queued`，前一个任务到达终态或被取消时自动领取下一个。执行状态由 Session 的 CodeMUX Event 流回写：Turn Outcome 正常结束 → `review`（回写结果摘要）；Interactive Request → `awaiting_input`；Session 错误 → `failed`（区分 `agent_error` / `setup_error` / `interrupted`，卡片显示「已中断」而非「失败」）；事件按 `run_seq` 匹配，过期代际一律丢弃。用户可取消（立即生效，任务进 `canceled`）与重试（续原 Session 发「继续」指令，会话不可续则新开代，`run_seq` +1）。卡片与详情侧滑提供「查看会话」，直接导航到该 Session，返回栈回到看板。

本票不涉及 worktree（那在 03）：创建表单的 worktree 开关与基线分支字段暂不生效或隐藏。

**Blocked by:** 01 — 手动待办看板（最小闭环）

**Status:** done

- [ ] start / cancel / retry 动作端点与 claim 语义（CAS：`todo → queued → preparing`，配额校验）；每项目并发计数与终态释放后自动领取下一个 `queued`
- [ ] Daemon 在项目目录创建可见 Session 并注入任务指令（复用既有 Session 创建与发消息路径），任务与 Session 通过 session_id 关联，`run_seq` 代际递增
- [ ] 事件回写映射：Turn Outcome → review + 结果摘要；Interactive Request → awaiting_input；错误 → failed（三类 failure_reason + interrupted）；过期代际事件被丢弃
- [ ] review 状态任务可「直接完成」（completion_kind = completed_without_merge，非 worktree 任务无合并环节）
- [ ] 取消立即生效进 `canceled`；重试续原 Session 发「继续」指令，不可续则新开代，worktree 语义不受影响（本票无 worktree）
- [ ] 卡片/详情侧滑「查看会话」导航到关联 Session，返回栈回到看板；`queued` 卡片显示排队徽章
- [ ] 进行中/排队中状态的任务锁定编辑（spec 决策）
- [ ] service 层测试：claim 配额与排队领取、事件序列 → 状态时间线（含 awaiting_input / failed 三类 / interrupted）、run_seq 代际隔离（取消后旧代事件不复活任务）、cancel/retry 的 CAS 守卫；看板纯函数补动作可用性矩阵
- [ ] Rust 改动以 build daemon 收尾；提交前全量 vitest 与 cargo fmt / clippy / check 通过
