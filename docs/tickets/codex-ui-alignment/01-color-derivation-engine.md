# 01 颜色派生引擎与算法接入

**What to build:** CodeMUX 的配色从「手挑 HSL 色值」改成「4 个种子 + 算法派生」。用户换任一预设强调色时，悬停底、焦点环、选中态、强调背景**一起**跟着变，而不是只有主色变一处；明暗两套主题由同一份算法产出，观感一致。交付物是一份可逐值对拍的派生引擎。

**Blocked by:** None

**Status:** done

- [x] 主题对象只保留 4 个种子：表面色、文字色、强调色、对比度；预设值照抄 Codex（浅色 `surface #fcfcfc` / `ink #0d0d0d` / `accent #3a83f7` / `contrast 45`，深色 `#000000` / `#ededed` / 同强调色 / `60`）
- [x] 派生规则照抄 Codex 的浅色与深色两套函数：边框一律用**墨色低透明度**（`rgba(ink, .04 + c*.02)` / `.06 + c*.04` / `.09 + c*.06`）而不是灰色；文字分 primary / secondary / tertiary 三档，深色下 tertiary 放宽为 `.42 + c*.13`；强调背景为 `mix(surface, accent, .11 + c*.04)`；悬停一律往 ink 方向 `color-mix` 加 4~8%；主按钮浅色反色为 ink 底、深色为 `mix(surface, white, .38 + c*.12)` 底；焦点环取强调色
- [x] 对比度是 0–100 的旋钮，先归一化再喂进所有透明度公式；用户拧过之后全部派生值正确重算
- [x] **消费层变量一个都不改名**：全仓 338 处引用 CodeMUX 私有 token，零改动。派生层内部用 Codex 命名作局部变量，不泄漏到 CSS；对外仍是现有的表面三级阶梯、侧栏 token、shadcn 语义 token
- [x] 现有三档表面阶梯被算法产出整体替换；新增第三档文字 token
- [x] 换 7 个预设强调色逐个验证：悬停底、焦点环、选中态、强调背景全部重着色
- [x] 测试：把 Codex 派生函数转写为参考实现，与我们的实现**运行对拍**（浅色/深色 × 强调色 × 对比度若干组，覆盖任意种子组合）
- [x] 测试：固化一组期望值快照（约 40 变量 × N 组种子），证明参考实现本身没被转写错、且未来有人无声改动算法时会变红
- [x] 测试走最高缝：调用外观应用函数后从文档根节点读回完整变量表比对，不测内部函数调用

## Comments

实现完成。新增 `src/lib/colorDerivation.ts`：逐条转写 Codex 桌面包的 `jba`（浅色）/ `Nba`（深色）与辅助函数（`eY`/`QJ`/`$J`/`tY`/`zba`），输入是 4 个种子（surface / ink / accent / contrast），输出 53 个语义色的 CSS 变量表。

**为什么输出的是不透明 HSL 三元组而不是 rgba()**：CodeMUX 的消费约定是 `hsl(var(--token) / .6)`，全仓数百处依赖这个形状。派生期把 Codex 的 `rgba(ink, a)` 直接合成到 surface 上，渲染结果与浏览器现场合成一致，消费层一个字符都不用改。alpha 在合成前按 Codex 的 `zba` 截到三位小数 —— 否则在 8bit 取整的边界上会和浏览器差 1/255。

**测试三层**：`colorDerivation.test.ts` 内含一份逐行转写的 Codex 参考实现，对 7 组种子 × 明暗逐键对拍（`compositeCodexColor` 把参考实现的 rgba 合成到同一底色再比）；另有明暗各一张 53 键的冻结期望表，以及换色不牵动中性层 / 对比度重算全部 alpha 档 / 边框保持无彩色相三条行为断言。`appearance.test.ts` 走最高缝：调 `applyAppearance` 后从 `documentElement` 读回完整变量表比对。

**与原计划的两处偏差**（均已在本票里说明理由）：
1. 深色 `--primary-foreground` 没有照抄 Codex 的 `tY(r)` 浅灰，而是取 surface 的反相（白）。Codex 深色主按钮是「浅灰描边」样式，CodeMUX 的 `bg-primary` 是实心强调色按钮，照抄只有约 2.5:1，达不到正文所需的 4.5:1。
2. `--scrim` 是唯一自带 alpha 的变量（`rgba()`），因为它压在任意内容之上，预合成到 surface 会失真。使用时直接写 `background: var(--scrim)`，不要套 `hsl()`。

**默认强调色**从 graphite 改成 azure —— Codex 的默认就是 `#3a83f7`，而整套换色的意义就是开箱即与 Codex 一致。旧的 localStorage 里存了 graphite 的用户不受影响（值仍然有效），只有「没设过」的才落到新默认。

指令 chip 色原先是写死的蓝色，现在跟着强调色走（`--codemux-directive-*` 由 accent 派生）。
## 代码评审修复

- **浅色下侧栏选中态不可见**：`--sidebar-muted` 原本取 `elevatedSecondaryOpaque`，浅色下它与 surface 混到同一个 8bit 值（`#fcfcfc`），等于 `--sidebar-bg`，导航栏 / 会话列表的选中与悬停**完全没有对比**。改取 Codex 的 hover 公式 `hoverSurface`（ink 的 `.04 + c*.02`），浅色下是 94.12%，可见。
- **默认强调色**：原本默认 `azure`（`#0169cb`），与 spec / research / AGENTS.md 写的 Codex 默认 `#3a83f7` 不符。新增排在第一位且作为默认值的 `codex` 预设，明暗同值 `#3a83f7`。
- **`-opaque` 孪生档与若干派生键此前没有静态兜底**：JS 跑起来之前它们是无效值。补进 `:root` / `.dark`，并在 `deriveThemeTokens` 里显式落值（不再只靠映射表）。
- `--scrim` 之前在 `deriveThemeTokens` 里重算了一遍公式，与派生结果里的 `simpleScrim` 重复；现在直接复用同一份计算。