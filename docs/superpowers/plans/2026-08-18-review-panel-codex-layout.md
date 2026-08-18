# Codex 风格审查面板布局实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将右侧审查面板调整为紧凑的 Codex 风格工具栏，并支持一个按钮在普通宽度与占据中间区域的展开宽度之间切换。

**Architecture:** 在标题栏增加独立的环境信息入口，面板展示变更统计与当前分支，点击变更打开审查标签，点击分支打开分支选择窗口。保留现有 `ReviewPanel` 的 Git 数据与操作逻辑，只重排审查工具栏；在 `sidePanelStore` 增加面板展开状态，由 `SidePanel` 控制宽度与绝对定位。Tab 行只显示一个动态的展开/恢复按钮，展开时覆盖当前工作区中间区域。

**Tech Stack:** React 18, TypeScript, Zustand, Tailwind CSS, Vitest, Testing Library。

---

### Task 1: 先锁定面板展开状态与布局行为

**Files:**
- Modify: `src/stores/sidePanelStore.ts`
- Test: `src/stores/sidePanelStore.test.ts`

- [ ] 为 store 增加 `isExpanded` 与 `toggleExpanded`，默认关闭，切换时只改变展开状态。
- [ ] 为 store 测试增加“展开/恢复只通过同一个状态切换”的断言。
- [ ] 运行 `npx vitest run src/stores/sidePanelStore.test.ts`，确认新增断言先失败后通过。

### Task 2: 实现 SidePanel 的展开/恢复按钮与占位布局

**Files:**
- Modify: `src/components/workspace/SidePanel.tsx`

- [ ] 在 tab 行最右侧加入一个动态按钮：普通状态显示“展开预览”，展开状态显示“恢复面宽”，不同时显示两个按钮。
- [ ] 展开时将面板覆盖主工作区中间区域；恢复时使用现有可拖拽宽度与布局偏好。
- [ ] 为按钮保留 aria-label、tooltip、键盘焦点样式，并让 tab 行保持紧凑高度。

### Task 3: 合并审查工具栏并移除未暂存选择控件

**Files:**
- Modify: `src/components/workspace/review/ReviewPanel.tsx`
- Modify: `src/components/workspace/review/GitBranchBar.tsx`
- Test: `src/components/workspace/review/ReviewPanel.test.tsx`

- [ ] 将“未提交”及增删统计放在第二行左侧。
- [ ] 将批量暂存、批量还原、刷新和提交操作放在第二行右侧，按钮保持图标优先且保留 tooltip/aria-label。
- [ ] 移除“未暂存/已暂存”选择控件及第三行操作栏，但保留现有文件级暂存、还原和 Diff 展开行为。
- [ ] 更新审查面板测试，验证批量按钮和 Git 提交流程仍可用，并验证界面不再渲染“未暂存”选择器。

### Task 4: 将环境信息与分支操作移入标题栏

**Files:**
- Create: `src/components/workspace/review/GitEnvironmentPopover.tsx`
- Create: `src/components/workspace/review/GitEnvironmentPopover.test.tsx`
- Modify: `src/components/layout/TitleBar.tsx`
- Modify: `src/components/workspace/review/ReviewPanel.tsx`
- Modify: `src/components/workspace/review/GitBranchBar.tsx`

- [ ] 在标题栏加入环境信息按钮与弹层，显示变更增删统计和当前分支。
- [ ] 点击变更行打开审查标签；点击分支行打开可搜索的分支选择窗口，并保留新建分支入口。
- [ ] 从提交/推送操作下拉中移除分支切换与新建分支入口。

### Task 5: 验证

**Files:**
- Test: `src/stores/sidePanelStore.test.ts`
- Test: `src/components/workspace/review/ReviewPanel.test.tsx`
- Test: `src/components/workspace/review/GitEnvironmentPopover.test.tsx`

- [ ] 运行受影响 Vitest 测试。
- [ ] 运行 `ReadLints` 检查所有修改文件。
- [ ] 运行 `npm run build` 验证 TypeScript 与 Vite 构建。
