# 03 — worktree 隔离、验收合并与重新开始

**What to build:** 任务默认在隔离环境干活并可一键验收合并：创建表单出现 worktree 隔离开关（默认开启）与基线分支选择（默认项目当前分支）；启动勾选的任务时，`preparing` 阶段从基线分支切出 worktree 与 work 分支（实际使用的分支记录在任务上），Session 跑在 worktree 路径里。跑完进 `review` 时显示改动统计（文件数 / +新增 / -删除，按 work 分支对基线分支计算）。验收三选一：**合并**（Daemon 直接执行 git merge，全程 `merging` 状态，提交信息可自定义、默认自动生成；成功 → `done` 记录 completion_kind = merged 与 merge 提交号）；**直接完成**（改动为空或放弃合并 → `done`，completion_kind = completed_without_merge）；**重新开始**（仅 `canceled` / 失败后明确重来：重置 worktree 回基线分支、丢弃改动、打回 `todo`）。合并冲突 → 回 `review` 并以 last_error 提示；同项目同时只允许一个任务 `merging`，其余任务合并按钮置灰（无自动合并队列）。取消的任务默认保留 worktree（卡片提示已保留）。

**Blocked by:** 02 — 执行生命周期：启动、事件回写与中断恢复（非 worktree）

**Status:** done

- [ ] 创建表单 worktree 开关（默认开）与基线分支字段；非 worktree 任务行为不变（回归 02 路径）
- [ ] preparing 阶段建 worktree / work 分支（复用既有 git 能力），失败进 `failed`（failure_reason = setup_error）；Session 以 worktree 路径创建
- [ ] review 回写 diff 统计（files_changed / additions / deletions），卡片与详情展示；失败原因与 worktree 缺失（目录被手动删）有提示
- [ ] merge 动作端点：串行 merging（同项目并发 1 覆盖）、可自定义提交信息、默认自动生成；成功 → done + merge 提交号 + completion_kind = merged；冲突 → 回 review + last_error 提示
- [ ] 直接完成：worktree 任务改动为空或放弃合并时结束为 done（completion_kind = completed_without_merge），worktree 可选清理
- [ ] 重新开始：重置 worktree 回基线分支、丢弃改动、打回 `todo`；取消默认保留 worktree 并在卡片提示
- [ ] `merging` 占坑期间其余任务合并按钮置灰；合并成功释放坑位并自动领取该项目的下一个 `queued` 任务
- [ ] service 层测试：worktree 建立/重置、merge 成功与冲突路径、同项目 merging 互斥、completion_kind 落库、释放后自动领取；看板纯函数补合并可用性判断
- [ ] Rust 改动以 build daemon 收尾；提交前全量 vitest 与 cargo fmt / clippy / check 通过
