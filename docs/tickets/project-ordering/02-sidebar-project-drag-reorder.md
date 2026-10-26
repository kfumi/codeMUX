# 侧栏项目拖拽排序

**What to build:** 侧栏「项目」分区的**整行**可拖拽：鼠标放在项目行上按下并移动即可上下调整顺序，行跟随指针移动、其余行实时让位，松手后立即生效并持久化。移动未超过 6px 时仍按点击处理（展开 / 收起）。不显示额外拖拽图标；行聚焦后支持键盘 `Alt+↑/↓`，触屏可拖。

**Why:** 项目顺序目前不可控，用户无法把常用项目固定在固定位置；参考实现的交互是整行拖动 + sortable 位移动画，按住把手的实现不够顺滑。

## 实现要点

- [ ] 新增依赖 `@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`（与参考实现同款）。
- [ ] `src/lib/daemon-client/client.ts`：`reorderProjects(ids: string[])` → `POST /api/projects/reorder`。
- [ ] `src/lib/facades/daemon-facade.ts`：`reorderProjectsViaDaemon` 并挂到 `daemonFacade`。
- [ ] `src/lib/facades/capability-manifest.ts`：新增 `project.reorder`，并把 `reorderProjects` 加入 `PROTOCOL_BACKED_DAEMON_METHODS`。
- [ ] `src/stores/projectStore.ts`：`reorderProjects(ids)` 乐观重排，失败回滚快照并 `fetchProjects()` 兜底，最后抛出便于调用方感知。
- [ ] `src/components/session/projectReorder.ts`：纯逻辑 `moveProjectToIndex` / `reorderFromDragEnd` / `resolveProjectDropPosition`。
- [ ] `src/components/session/SessionList.tsx`：`DndContext`（`PointerSensor` + `distance: 6`、`closestCenter`）+ `SortableContext`（`verticalListSortingStrategy`）；`onDragEnd` 提交一次完整顺序。
- [ ] `src/components/session/ProjectGroup.tsx`：`useSortable` 绑定整组（行 + 会话列表）；外层应用 `transform` / `transition` / `zIndex`，行应用 listeners 与键盘处理；操作簇 `pointerdown` 阻断冒泡。

## 交互约束

- 行内按钮（更多 / 文件树 / 新建对话）不参与整行拖拽。
- 按下后移动 ≤6px 视为点击；>6px 才进入拖拽。
- 被拖项拖拽期间不加 transform 过渡（跟手）；其余行用 `--motion-duration-normal` / `--motion-ease-standard` 平滑让位。
- 落点无变化时不发请求、不画插入线；dnd-kit 已负责拦截拖拽后的 click。
- 不渲染拖拽图标；行 `select-none touch-none`。

## 测试

- [ ] `projectReorder` 纯逻辑：`moveProjectToIndex` 上下移动 / 越界 / 不变引用；`reorderFromDragEnd` 目标缺失与相同项；`resolveProjectDropPosition` 上下方向与自身跳过。
- [ ] `projectStore`：成功时列表顺序立即变化；失败时回滚并重新拉取。
- [ ] `ProjectGroup`：启用排序时整行可聚焦、挂载快捷键并调用 `onMoveProject`；未启用时没有 tabIndex / 快捷键 / `touch-none`；页面上不存在拖拽图标。
- [ ] `SessionList`：整行 `Alt+ArrowDown` 调用 `reorderProjects`；普通点击仍展开 / 收起。
- [ ] `npx vitest run src/components/session src/stores src/lib/facades src/lib/daemon-client`。
