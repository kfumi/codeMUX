# 侧栏项目拖拽排序规格

## 背景

侧栏「项目」分区当前按 daemon 的 `updated_at` 倒序渲染（`get_all_projects` 的 `ORDER BY updated_at DESC`）。用户无法决定项目在列表里的位置：新建或最后编辑的项目总会跑到最前，项目一多就找不到固定的入口。

目标：让用户在桌面应用和 PC 浏览器中直接拖动项目行调整侧栏顺序，顺序由 daemon 持久化，桌面、PC 浏览器、手机浏览器与 CLI 看到同一份结果。移动端只读这份顺序，不提供拖拽手势。

## 需求

1. 桌面应用与 PC 浏览器的侧栏「项目」分区内，**整行**是拖拽激活区：鼠标放在项目行上按下并移动即可拖动，不需要按住某个按钮，也不显示额外的拖拽图标。仅在该分区内部重排，不跨「置顶 / 项目 / 对话」分区。
2. 拖动与点击靠位移区分：按下后移动未超过 6px 视为点击，仍负责展开 / 收起；超过 6px 才进入拖拽。
3. 拖动过程中被拖行跟手移动，其余项目行实时平滑让位（位移动画），落点行显示一条 2px 插入线；松手后行落在新位置。
4. 松手后**乐观更新**本地列表并调用 daemon；失败回滚并重新拉取列表。
5. 项目行可聚焦，聚焦后 `Alt+ArrowUp` / `Alt+ArrowDown` 上移 / 下移一位。
6. 移动端不启用项目拖拽：项目行只响应点击展开 / 收起，并保留正常的纵向滚动；不使用 `touch-none` 阻断触摸手势。桌面与 PC 浏览器使用 Pointer Events，而不是 HTML5 Drag and Drop。
7. 新建项目仍然排在最前；重排后顺序稳定，项目改名、编辑根目录、创建会话都不能改变它。

## 非目标

- 不提供「按名称 / 最近活动排序」的排序模式切换。
- 不支持跨分区拖动（项目不能拖进「置顶」或「对话」）。
- 移动端不提供项目排序手势；需要调整顺序时在桌面应用或 PC 浏览器操作。
- 不做拖到列表边缘的自动滚动（项目数量通常在一屏内；后续需要再补）。
- 不改会话（session）的排序规则。

## 数据与接口

### 数据库

`projects` 表新增 `position INTEGER NOT NULL DEFAULT 0`。

- 迁移：老库按现有展示顺序（`updated_at DESC, created_at DESC, id ASC`）回填 `0..n-1`，升级后列表视觉不变。
- 查询：`ORDER BY position ASC, updated_at DESC, created_at DESC, id ASC`。`position` 是主排序键，其余字段只做并发写入或历史数据的稳定兜底。
- 新建项目：`position = COALESCE(MIN(position), 0) - 1`，即插入到最前，保持现有「新项目在顶部」的直觉。
- 重排：事务内把**完整项目集合**重写成 `0..n-1`。请求里的 ids 按用户顺序排在前，未列出的项目（并发新建）按原顺序排在后面，避免出现重复 `position`。

`Project` 的对外形状不变（数组顺序即顺序契约），不暴露 `position` 字段，避免出现第二真相源。

### REST

`POST /api/projects/reorder`

```json
{ "ids": ["project-b", "project-a", "project-c"] }
```

- 成功返回 `204 No Content`。
- 事务内只写 `position`，**不更新 `updated_at`**；否则旧的「最后修改优先」兜底会把手工顺序冲乱。
- 未在 `ids` 中的项目保持相对顺序追加到末尾；不存在的 id 忽略。

### 前端分层

`daemon-client` → `daemonFacade.reorderProjects` → `capability-manifest`（`project.reorder`）→ `projectStore.reorderProjects` → 侧栏。

## 交互与视觉

- 整行作为拖拽激活区，排序由 `@dnd-kit/core` + `@dnd-kit/sortable` 承担，与参考实现同款：`PointerSensor` + `activationConstraint: { distance: 6 }`、`closestCenter`、`verticalListSortingStrategy`。
- 被拖行跟手移动（拖拽期间不加 transform 过渡），其余行按 sortable 位移让位，过渡使用动效令牌 `--motion-duration-normal` / `--motion-ease-standard`。
- 行内按钮（更多 / 文件树 / 新建对话）的 `pointerdown` 不透传到行，避免在按钮上按下时误启动整行拖拽。
- 不渲染额外的拖拽图标；行样式 `select-none` + `touch-none`，拖动时 `cursor-grabbing`。
- `touch-none` 只在允许排序的非移动宿主上启用；移动端项目行不加拖拽监听、不挂排序快捷键，也不显示落点线。
- 落点线颜色使用侧栏强调色 `--sidebar-glow`，与现有项目行悬停态一致。
- dnd-kit 在激活拖拽后会拦截随后的 `click`，不会误触展开 / 收起；`Escape` 取消拖拽。
- 项目行可聚焦，`aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"`。

## 验收

- [ ] 老库升级后项目顺序与升级前一致。
- [ ] 新建项目出现在最前；改名、编辑根目录、创建会话都不改变项目位置。
- [ ] 拖拽后刷新页面 / 重启 daemon / 换另一台客户端，顺序保持。
- [ ] 拖拽失败时列表回到原顺序，并触发一次重新拉取。
- [ ] 键盘 `Alt+ArrowUp/Down` 可移动项目，焦点保持在项目行上。
- [ ] 移动端不能拖动项目，点击仍可展开 / 收起，纵向滚动不受阻。
- [ ] 拖拽时被拖行跟手、其余行平滑让位，松手后落位无跳变。
