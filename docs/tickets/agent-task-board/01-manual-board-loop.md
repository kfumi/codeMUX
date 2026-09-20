# 01 — 手动待办看板（最小闭环）

**What to build:** 不接 agent 执行也能用的完整工作任务看板：用户从侧边栏「待办」入口进入四列看板（待办 / 进行中 / 等你处理 / 完成），可以创建任务（标题 + 任务指令 + 项目）、编辑待办与失败任务、在列间拖拽改状态、在待办列内拖拽排序、切换看板/列表视图、按项目筛选、控制已取消/已归档可见性、归档（含一键全部归档）与彻底删除已终结任务。数据全部由 Daemon 持有，桌面与 Mobile Companion 看到同一块板并实时收敛（fire-and-refetch + 低频变更 nudge）。侧边栏常驻「等你处理」徽章（awaiting_input + review + failed 计数）。

状态机按 spec 的 10 状态词汇建表（含 `archived_at`、`failure_reason`、`run_seq` 代际列），本票只动手动可及的状态（`todo` / `running` 对应的纯状态变更、`done` / `canceled` / `failed` 由编辑与归档路径触达）；列聚合纯函数带「每个状态必须归属且仅归属一列」的守卫断言。

**Blocked by:** None — can start immediately

**Status:** done

- [ ] SQLite 新表 `work_tasks`（spec 字段全集）与 `work_task_events` 时间线表（状态变更同事务写入），含补列式迁移
- [ ] Daemon service 提供 CRUD、CAS 状态流转守卫、归档/取消归档、每项目待办排序；REST 端点 `/work-tasks`（wire camelCase）覆盖 list / create / get / update / delete / archive / unarchive / reorder
- [ ] 任务变更广播低频 nudge，客户端 refetch 收敛；两个 Daemon Client 同时打开时状态一致
- [ ] 前端分层落地：领域类型、daemon facade workTasks 命名空间、control-plane fetch、zustand store
- [ ] 四列看板 UI：创建/编辑对话框（标题、指令、项目、Agent Kind 与 Model Provider / 模型）、任务卡片（状态徽章按语义分型）、详情侧滑（信息 + 动作 + 时间线投影）、列间拖拽改状态、待办列内拖拽排序
- [ ] 列表视图与看板/列表切换，偏好持久化并在首帧同步恢复；项目筛选、显示已取消/已归档开关同样持久化
- [ ] 归档 + 「归档全部已完成」 + 取消归档；彻底删除仅对已终结任务开放
- [ ] 导航 view 增加「待办」，侧边栏按钮与懒加载面板，照「自动化」接线；「等你处理」徽章数据源与看板共用常驻 provider
- [ ] 列聚合纯函数通过守卫测试（每个 WorkTask 状态归属且仅归属一列）；service 层内存 SQLite 测试覆盖 CRUD、CAS 守卫、reorder；store 对 stub facade 测 CRUD 与乐观更新；卡片组件薄测试
- [ ] Rust 改动以 build daemon 收尾；提交前全量 vitest（根 + sidecar）与 cargo fmt / clippy / check 通过
