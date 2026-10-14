# 03 对比度、diff 语义色与外观设置面板

**What to build:** 外观设置里多两个真旋钮——拖动**对比度**滑块，整个界面的边界与次级文字跟着整体加重或减轻，不用换主题就能调到舒服的程度；**diff 的新增行/删除行颜色**可以自己配。设置面板本身按 Codex 的形态重画。

**Blocked by:** 01, 02

**Status:** done

- [x] 对比度滑块（0–100）接入偏好存储与外观应用，拖动后全站浓淡实时变化
- [x] 对比度取极值（0 与 100）时界面不糊成一片，浅色与深色各自都验证一遍
- [x] diff 新增色与删除色可配置，按浅色/深色各存一套；diff 渲染、变更统计等所有展示 diff 的位置统一消费
- [x] 对比度与 diff 色纳入「重置为默认」
- [x] 外观设置面板按 Codex 形态重画：设置项分组的行高、间距、图标尺寸、悬停态对齐
- [x] 现有的强调色预设板、字体族、UI 字号、代码字号、三档圆角、内容宽度全部保留且仍可改
- [x] 改完任一设置界面立刻响应
- [x] 就近测试覆盖：对比度进入存储与应用的往返、diff 色的浅深色分流、面板渲染

## Comments

实现完成。

**对比度滑块** 0–100，深色侧自动 +15（Codex 的 45 / 60 关系），上限截断。

**diff 配色**与状态色**分开**：新增 `--diff-added` / `--diff-removed`（`--color-diff-added` / `--color-diff-removed`），用户可在外观设置里配，按明暗各存一套，每格可单独恢复默认。原有的 `--success` / `--destructive` 保持为固定的状态语义色 —— 否则「MCP 连上了」会跟着「diff 增删色」一起变。

迁移的是**确实在展示 diff** 的位置：DiffBlock、DiffView 统计、ReviewPanel 的文件条与 +N/-N、Git 三个 popover 的变更统计、CodeMuxMessageParts 的 diff 统计徽标、FileEditorPanel 的行号色。**没有**迁移的是状态指示器：Subagent 完成/失败图标、错误横幅、worktask 看板的状态 chip —— 那些不是 diff。

**顺带发现并修掉两处误伤**：GitEnvironmentPopover 的 subagent 状态图标、CodeMuxMessageParts 的错误横幅最初被批量替换成了 diff 色，已改回状态色。这类「同一个 `text-success` 有时是状态、有时是 diff」的混淆正是把它们分开的理由。

面板按 Codex 形态重画：强调色板改用预设 hex（不再维护第二份 swatch）、对比度与 diff 配色按分组插入、圆角预览改为直接读 `RADIUS_SCALES`。

## 代码评审修复

代码评审又找出两处被批量替换误伤的状态色：`FileEditorPanel` 的编辑器标签「已保存」指示（`isDirty ? text-warning : …`）与 `GitPullRequestPopover` 的「已创建 PR #N」成功提示，都被换成了 `text-diff-added`。已改回 `text-success` —— 前者是保存状态、后者是操作结果，都不是 diff。至此误伤共 4 处（另两处见上）。

`--diff-added` / `--diff-removed` / `--border-light` / `--icon-*` / `--*-opaque` 此前派生出来了但 `:root` / `.dark` 没有静态兜底，JS 跑起来之前是无效值；已补齐。