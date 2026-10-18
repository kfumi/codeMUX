# 01 环境信息快照 store 与摘要面板复用

**What to build:** 摘要面板的「环境信息」（变更增删统计 + 当前分支）改为从按项目键控的应用级缓存读取：新建环境信息 store，提供「无缓存才取」的 `ensure` 与「总是重取且保留旧数据可见」的 `refresh`，并带每路径在途去重与过期响应守卫；非 git 仓库的「取不到仓库」兜底也被缓存。共享的摘要面板正文改读 store，于是浮动浮层与钉住的内联面共用同一份缓存——重开摘要、钉住/取消钉住、切换项目都复用缓存，只有首次或未缓存的项目显示加载占位；切换项目首次取一次、其他项目的缓存保留、切回即时。分支检出/新建成功后调用 store `refresh`，分支名与统计立即更新（保持现有行为不回归）。不改 daemon、不加 TTL、不加手动刷新控件。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 新增按项目路径键控的环境信息 store：`ensure(projectPath)` 仅在无缓存条目时取数；`refresh(projectPath)` 总是重取并在在途期间保留上一份数据可见
- [x] 条目状态覆盖 `loading` / `ready` / `unavailable`（含不可用文案），并记录取数时间戳
- [x] 同一项目已有缓存时，重开摘要不再产生 `daemonFacade.git.getRepositoryState` / `getStatusChanges` 调用
- [x] 首次或未缓存项目仍显示加载骨架；命中缓存时立即渲染、不闪骨架
- [x] 切换项目时新项目只取一次，先前项目缓存保留，切回即时显示
- [x] 同一项目的并发 `ensure`/`refresh` 被去重为一次在途请求
- [x] 过期响应不覆盖较新项目的快照（快速切项目时显示始终对应当前项目）
- [x] 非 git 仓库的兜底文案被缓存，重复打开不重查
- [x] 分支检出/新建成功后调用 store `refresh`，浮层与内联面的分支名与统计都立即更新
- [x] `SummaryPanelBody` 改读 store；浮层与内联面两处共用，档位切换不触发重取
- [x] 就近测试：新增 store 单元测试（ensure 取一次并复用 / 新路径取数 / refresh 重取 / 在途去重 / 过期守卫 / unavailable 缓存）；更新 `GitEnvironmentPopover.test.tsx` 与 `SummaryPanelSurface.test.tsx` 断言「第二次打开不再取数」与「分支操作触发一次刷新」
