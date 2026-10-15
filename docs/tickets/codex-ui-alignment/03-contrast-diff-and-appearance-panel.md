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

**diff 配色**与状态色**分开**：新增 `--diff-added` / `--diff-removed`（`--color-diff-added` / `--color-diff-removed`），作为固定语义种子落进派生表，不再跟着强调色或对比度漂移。原有的 `--success` / `--destructive` 保持为固定的状态语义色 —— 否则「MCP 连上了」会跟着「diff 增删色」一起变。

> **后续变更（2026-10-14）**：本票原本还给 diff 配色做了四个取色器放在外观页，实际用下来这个入口没有价值，已整体移除 —— `AppearancePrefs.diff`、`setDiffColor`、`semanticOverridesForPrefs`、`sanitizeDiffColors` 与 `deriveThemeTokens` 的第三个参数一并删掉，`--diff-added` / `--diff-removed` 现在只由语义种子决定。**注意**：Codex 自己的色板里 diff 增删色与 `success` / `destructive` 取的就是同一个色值（浅色删除色 = 危险色 `#ba2623`，深色同理），所以「分开」指的是**变量与语义**分开而不是颜色分开 —— 要「删除行」读 `--diff-removed`，要「失败」读 `--destructive`，两者此后可以各自演化。

迁移的是**确实在展示 diff** 的位置：DiffBlock、DiffView 统计、ReviewPanel 的文件条与 +N/-N、Git 三个 popover 的变更统计、CodeMuxMessageParts 的 diff 统计徽标、FileEditorPanel 的行号色。**没有**迁移的是状态指示器：Subagent 完成/失败图标、错误横幅、worktask 看板的状态 chip —— 那些不是 diff。

**顺带发现并修掉两处误伤**：GitEnvironmentPopover 的 subagent 状态图标、CodeMuxMessageParts 的错误横幅最初被批量替换成了 diff 色，已改回状态色。这类「同一个 `text-success` 有时是状态、有时是 diff」的混淆正是把它们分开的理由。

面板按 Codex 形态重画：强调色板改用预设 hex（不再维护第二份 swatch）、对比度按分组插入、圆角预览改为直接读 `RADIUS_SCALES`。外观页随后整体重排为 Codex 的「分组小标题 + 发丝描边卡片 + 左标题右控件」行版式（见 22cdec7）。

## 代码评审修复

代码评审又找出两处被批量替换误伤的状态色：`FileEditorPanel` 的编辑器标签「已保存」指示（`isDirty ? text-warning : …`）与 `GitPullRequestPopover` 的「已创建 PR #N」成功提示，都被换成了 `text-diff-added`。已改回 `text-success` —— 前者是保存状态、后者是操作结果，都不是 diff。至此误伤共 4 处（另两处见上）。

`--diff-added` / `--diff-removed` / `--border-light` / `--icon-*` / `--*-opaque` 此前派生出来了但 `:root` / `.dark` 没有静态兜底，JS 跑起来之前是无效值；已补齐。

## 视觉复核修复：模式行与对比度滑块

对照 Codex 桌面端截图复核外观页，模式行与对比度两处对不上;这次拿到 **Codex 自己的源码**逐笔核对（MSIX 包 `C:\Program Files\WindowsApps\OpenAI.Codex_*` 里的 `app/resources/app.asar` → `webview/assets/general-settings-*.js` 与 `range-slider-*.js`），三处都按它改：

**1. 「模式」两个字没有垂直居中。** 根因在 `SettingsRow`：控件格无条件带 `sm:row-span-2`，没有说明文字的行里控件（60px 缩略图）比文字高出来的那部分被 grid 平均分给两条轨道，标题因此停在行的上四分之一。现在只在**有说明文字**时才跨行——那种情况下跨行是对的（控件要相对「标题 + 说明」这个文字块居中）。

**2. 模式缩略图重画。** Codex 的实物是：一个 `grid-cols-3 gap-4 w-68` 的 radiogroup（三格正好 80px），每格 `aspect-4/3`，内容是 **80×60 的 SVG 插图**，`currentColor` 画强调线，外层 `absolute inset-0 border-2` 做选中环；顺序是**跟随系统 / 浅色 / 深色**，其中「跟随系统」= 浅色半幅 + 深色半幅并排（两张 40×60 的视口从各自的 80 宽画布上裁左半边）。旧实现是三个 div 拼的 72×48 小画，既不是这套几何、也把「跟随系统」画成了按当前解析结果上色的一扇窗。新实现见 `src/components/settings/ModeRow.tsx`，几何数值（窗口 8..72/8..52、标题行 y12、正文行 y18/22/26、强调行 y32/36、输入条 y41.75..48.25、侧栏 8..20、外框 rx8）全部照抄。

两处**有意偏离** Codex：① 标题位那枚角标原图是 OpenAI 自己的产品 mark，我们换成同尺寸的中性圆点，不在自己界面里画别家商标；② 强调线取 `currentColor` + `text-primary`，跟着用户的强调色走而不是写死 Codex 的 info 蓝。滤镜 id 逐实例 `useId` 唯一化。

**3. 对比度滑块既塌了、也不是 Codex 的样子。** 两个问题：

- **塌成 0 宽**：设置行的控件格是 `auto` 宽，其最大宽度又由内容反推，`flex-1` 的轨道于是被解成 0 —— 截图里整条滑块只剩一个点贴在数字左边。Codex 给同一行 `min-w-[12rem]`，我们给整行 `sm:w-56`。
- **画法不同**：Codex 的轨道是**静态**的强调色渐变（`color-mix(in srgb, accent 35%, surface)` → `accent` @32% → `accent`），不随当前值分段；把手是原生 `::-webkit-slider-thumb`，20px、`bg-current`（= 文字色，浅色下黑、深色下白）、`mt-[-9px]` 正好是 `(2 - 20) / 2`。旧实现反过来：自绘把手 + 透明 input，还画了「已填充 / 未填充」两段。现在两条引擎的 thumb 都走原生，焦点环画在把手上（轨道只有 2px，环套在轨道上等于看不见）。随之删掉 `globals.css` 里已无用的 `.contrast-slider`（那正是 `opacity-0` 压住原生把手的补丁）。

就地测试：`ModeRow.test.tsx`（顺序、回写、对半、`currentColor` 强调线、滤镜 id 唯一）、`ThemeToggle.test.tsx`（渐变 / `mt-[-9px]` / 容器宽度）、`SettingsRow.test.tsx`（无说明不跨行、`controlClassName` 放宽上限）。