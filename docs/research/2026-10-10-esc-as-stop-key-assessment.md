# Esc 作为「停止」键的可行性评估（Ctrl+. 现状与 Esc 多义冲突）

**状态：仅评估，未实施（2026-10-10）。** 本文记录一次排查结论，供日后决策复用；仓库代码与
[ADR 0013](../adr/0013-user-configurable-keyboard-shortcuts.md) 均未改动。

## 背景

用户提出：停止对话的快捷键是否应该从 `Ctrl+.` 改为 `Esc`；并且「停止生成」不该在快捷键设置里
展示、不可修改 —— 系统默认就是「Esc = 停止电脑控制 + 停止对话」。

## 结论

**方向合理，但「只把 `Mod+Period` 换成 `Escape`」是错的。** 正解是把 `abort` 升级成**固定系统键**
（键位不可改、命令本身保留）。理由见下文的三个事实与一个风险。

## 现状：三个关键事实

### 1. Esc 今天已经能停生成，只是作用域只在输入框里

`src/components/agent/assistant-ui/CodeMuxLexicalComposerInput.tsx:126-141`：编辑器内按 Esc →
`composer.cancel()`（`canCancel` 为真时）并 `preventDefault()`。

所以「Esc = 停止对话」**不是新语义**，只是把作用域从 composer 扩到全应用。

### 2. Esc 在快捷键模型里根本不存在 —— `Ctrl+.` 不是随手选的

`src/lib/shortcuts/keyboardShortcuts.ts:139-142` 的 `NAMED_KEYS` 故意不含 `Escape`，注释写明理由：

> 注意 `Escape` 故意不在其中：它在 composer 里有既有语义（取消当前轮与弹层），不对外开放绑定。

ADR 0013 第 5 条把「可绑定键位必须带至少一个修饰键，或为 F1–F12」定为硬不变量。即：
**Esc 被保留给 composer，`Mod+Period` 是它的替代键。**

三条测试钉住了这个事实（改键位表会打破它们）：

- `src/lib/shortcuts/keyboardShortcuts.test.ts:81` — `normalizeKeybinding('Mod+Escape')` 为 `null`
- `src/lib/shortcuts/keyboardShortcuts.test.ts:106` — 非法覆盖回落默认
- `src/lib/shortcuts/keyboardShortcuts.test.ts:141` — `keybindingFromEvent(Escape)` 为 `null`
- `src/lib/shortcuts/keyboardShortcuts.test.ts:264` — 非法键位不改动现状

### 3. 电脑控制的急停已经是 Esc，且已经同时「停驱动 + 停对话」

`apps/desktop/src/emergency-stop.ts:33` → `EMERGENCY_STOP_ACCELERATOR = 'Escape'`；触发时
`notifyRenderer()` → `src/hooks/useEmergencyStop.ts:90-99` 对每个在跑会话 `interrupt()`，并
`estopDriver()`。

但它是 **Electron 全局快捷键**，只在「电脑控制开启 + 系统级执行开着 + 本回合出现过 `computer_*`
调用」时武装（`src/hooks/useEmergencyStop.ts:75-79`）。**武装期间 Esc 被壳吞掉，渲染层收不到。**

因此用户想要的「Esc 一律停下」= 电脑控制期间（**已实现**）+ 平时（**只在 composer 内** ← 唯一缺口）。

## 风险：Esc 是多义的，三处必须先补

分发器只跳过 `event.defaultPrevented` 的按键（`src/hooks/useKeyboardShortcuts.ts:40`），且监听在
冒泡期。今天各 Esc 消费者的「吃掉」情况：

| 场景 | 位置 | 今天是否吃掉 Esc |
|---|---|---|
| composer 触发器菜单（`/` `@`） | `CodeMuxComposer.tsx:517/544` | ✅ `preventDefault` + `stopPropagation`（capture 期） |
| composer 编辑器取消当前轮 | `CodeMuxLexicalComposerInput.tsx:127` | ✅ 取消时 `preventDefault` |
| 元素选择器取消（浏览器面板） | `src/lib/elementSelector.ts:108` | ✅ `preventDefault` |
| 旧 `AgentInput` 命令菜单 | `src/components/agent/AgentInput.tsx:102` | ✅ `preventDefault` |
| 搜索对话框关闭 | `src/components/layout/ChatSearchDialog.tsx:238` | ❌ 只 `onOpenChange(false)` |
| 会话重命名退出 | `src/components/session/SessionItem.tsx:211` | ❌ 没有 |
| 项目重命名退出 | `src/components/session/ProjectGroup.tsx:119` | ❌ 没有 |

**后三处不 `preventDefault()`。** 一旦 Esc 变成全局「停止」，用 Esc 关搜索框或退出重命名会顺手把
正在跑的回合打断 —— 这是必须同批修的回归点。

## 「不展示、不能修改」的两个坑

1. **旧覆盖会变鬼影。** `config.json` 里可能已存在 `keybindings.abort`。若只改默认值而不忽略覆盖，
   老用户的自定义仍会赢 → 出现「设置里看不到、实际还在生效」。固定命令必须短路覆盖
   （`resolveKeybinding` 对固定命令直接返回固定键位）。
2. **不能静默消失。** 设置页那一行应保留但改为**只读**（显示 Esc 键帽 + 一句「系统固定：停止当前回合
   与电脑控制」），去掉录制 / 禁用 / 恢复默认三个按钮。直接删行会像 bug。

## 实现要点（本次改动的真正风险）

Esc 要能被解析与展示，就得进 `NAMED_KEYS`；但那样 `Mod+Escape` 也会变成合法可绑定
（`isAllowedKeybinding` 只看「有没有修饰键」，不看具体键）。所以必须：

- `Escape` 进 `NAMED_KEYS`（解析 / 展示 / `keybindingFromEvent` 可用）；
- **同时**把 `Escape` 与 `Mod+Escape` 放进 `isReservedKeybinding`，挡住用户绑定；
- 固定命令绕开 `isAllowedKeybinding`（否则裸键仍被拒）；
- 设置页录制期「按 Esc 取消录制」的既有行为要保住（它在 `isAllowedKeybinding` 之前分支，天然优先）；
- 更新上文那 4 条钉住旧行为的测试。

## 建议方案

把 `abort` 升级为**固定系统键**，而非改默认值：

- 键位不可改、不可解绑；`Escape` 不对外开放绑定（保持现有排除）；
- 命令本身**保留** —— 搜索面板里仍能「停止生成」，按钮 tooltip 仍显示 Esc，`aria-keyshortcuts` 仍写
  `Escape`（`CodeMuxComposer.tsx:227/228/763/768` 的 `useShortcutHint('abort')` 链路不变）；
- 设置页该行改只读；
- 补上表后三处的 `preventDefault()`。

**反直觉但重要：`useEmergencyStop` 的武装条件不需要改。** 没有 `computer_*` 活动时本来就没有东西可
停，现有条件已覆盖「电脑控制正在进行中」这一唯一有意义的情形。两条路天然互斥：电脑控制在飞时壳吞
Esc（急停），平时渲染层分发器处理（取消当前轮）。

## 未决问题

- 是否保留 `Ctrl+.` 作为可选别名？（会引入「一条命令多个键」的模型复杂度，倾向不做。）
- 推翻 ADR 0013「Esc 不对外开放绑定」这一取舍，需要 ADR 修订或新增 ADR。
- 浏览器宿主里 Esc 也可能被浏览器自身消费（取消加载、退出全屏），属 ADR 0013 已接受的宿主差异。
