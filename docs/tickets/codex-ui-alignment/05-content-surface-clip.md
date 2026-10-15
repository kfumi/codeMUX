# 05 内容面 clip-path + 页面浮层

**What to build:** 主内容区从窗口边缘浮起来，带圆角和很轻的投影，侧栏收起时左角自动变直角而不是留半截圆角。实现上用一组 token 驱动圆角，取代现在为了补偿分割线抗锯齿而手写的两段 SVG 弧线。

**Blocked by:** 02, 04

**Status:** done

- [x] 三个 token 驱动圆角：起始侧、终止侧、以及取两者较大值的派生值；用 `clip-path` 施加，不对称状态由 token 自动适配
- [x] 删除两个手写 inline SVG 弧线 workaround 及其分割线补偿逻辑
- [x] 侧栏停靠时「左圆右方」、侧栏收起时「两侧都圆」、窄屏抽屉态三种情形各自正确
- [x] 补上目前完全缺失的页面浮层 elevation（描边 + 近距小模糊 + 超大扩散极低透明度）
- [x] 页面浮层圆角取 15px（Codex 的 12px 基数 × 1.25 超椭圆）
- [x] 右侧边栏与内容区的层级关系不被破坏
- [x] 源码契约测试：断言 SVG 弧线 workaround 已删除、`clip-path` 三个 token 已就位
- [x] 布局 token 契约测试承载三个圆角 token

## Comments

实现完成。与 04 合并落地（同一次 MainLayout 结构改造），避免来回搬两次布局。

三个 token 驱动圆角：`--content-radius-start`（起始侧 = 靠近侧栏）、`--content-radius-end`（终止侧 = 靠近窗口边缘）、`--content-radius-max`（两者较大值）。用 `clip-path: inset(0 round …)` 施加 —— 圆角是**裁切**出来的，侧栏那条 1px 分隔线画在它下面就能严丝合缝，不需要旧实现里两段手写 SVG 弧线去补偿抗锯齿覆盖率损耗。分隔线因此改成侧栏自己的一条 `border-r`。

非对称状态（侧栏停靠时左圆右方 / 侧栏收起或最大化或浏览器形态时两侧都方）由 `data-floats` 属性驱动，组件里没有分支。

`layoutTokens.test.ts` 扩展成四组断言：三个 token 到位、用 clip-path 而非 border-radius、浮起态取 `--radius-content`（15px = Codex 12px 基数 × 1.25）、SVG workaround 确已删除（钉住 MainLayout 源码文本里不再有 `vectorEffect="non-scaling-stroke"` 与那段 path 数据）。

`shadow-elevation-content` 同时用上，是主内容面此前**完全缺失**的页面浮层。

## 代码评审修复

- **`clip-path` 会把 `box-shadow` 一起裁掉**：原先圆角、裁切、页面浮层三者都在同一个元素上，`shadow-elevation-content` 的描边与大半投影会被圆角切掉 —— 页面浮层等于白加。拆成两层：外层 `.content-surface-root` 只给圆角形状（`border-*-radius`）与 `shadow-elevation-content`，内层 `.content-surface` 才施加 `clip-path`。
- **内容面与窗口表面的明暗关系原本摆反了**：侧栏用 `--surface-2`、内容面用 `--background`，浅色下内容面比窗口暗，等于一个洞，浮起观感完全消失。改成 Codex 的分层：窗口表面（导航栏 / 侧栏 / 之间的空气）= `--background`（surface 种子），内容面 = `--surface-1`（elevatedPrimary）。

## 后续变更（2026-10-14）：窗口面独立成一层，切角条件反过来

上面那条「窗口表面 = `--background`」在视觉复核后被细分成三层（见 04 的「视觉复核修复」）：顶栏条与「导航栏 / 内容面之间的空气」现在读 `--chrome-bg`（新派生一档 = 窗口面），侧栏才是 `--background`，内容面仍是 `--surface-1`。`clip-path` 与三个圆角 token 的机制不变，只是缺口里露出来的那层从「表面」换成了「窗口面」。

**切角条件反过来**（`contentFloats`）：原来是「侧栏停靠 → 内容面切左角」，现在正好相反 ——

- **侧栏展开：内容面直角贴边。** Codex 实测就是直角（内容面白色从分隔线那一列直接开始，没有缺口）。这时内容面挨着的是一块**同样是面板**的侧栏，缺口里露出来的窗口面比两边都深，等于在分隔线旁咬掉一角，看着像磕坏的。
- **侧栏收起：内容面左边是图标轨/窗口面，这时才切角。** 缺口里的窗口面与顶栏连成一片，圆角自然；这也是 Codex 自己的规则（`--app-shell-main-surface-top-start-radius` 只在没有侧栏的布局里生效）。

规则一句话：**面板的圆角只在它挨着窗口面时切，贴着另一块面板时直角贴边。** 侧栏自己始终切左角（它左边永远是图标轨/窗口面），与 Codex 的 `border-start-start-radius` + `border-end-start-radius` 一致。最大化 / 浏览器 / 手机形态仍然直线到底。

## 后续变更（2026-10-14）：内容面回到「表面种子」这一档

上面那句「内容面仍是 `--surface-1`」在深色复核后被推翻。Codex 的内容面取的是 `--color-surface`（**表面种子本身**）：

```css
._MainContentSurface_[data-app-shell-main-surface=default]{background-color:var(--color-surface)}
```

`--surface-1`（= `elevatedPrimary`）在 Codex 里是 **composer 输入框**那一档，不是页面底。两者在浅色下只差 1 级（252 / 253），深色下差 30 级（17 / 47）—— 所以这个错误只在深色下暴露：

| 深色 | Codex 实测 | 改之前 | 改之后 |
|---|---|---|---|
| 侧栏 | 16 | 0 | 17 |
| 内容面 | 17 | **31** | **17** |
| composer | 47 | **31**（与内容面同色） | **45** |

用反的后果是两头都错：侧栏与内容面差出 30 级（读成「侧栏是个洞」），而 composer 与内容面同色（读成「没有输入框」）。
`MainLayout.tsx` 的三处 `bg-[hsl(var(--surface-1))]`（外层 section / main / 聊天列）全部改成 `bg-[hsl(var(--background))]`，
composer 保持 `--surface-1` 不动 —— 于是「谁浮在谁上面」一次到位：窗框 14 < 面板 17 ≈ 17 < 输入框 45。

浅色侧同步核对（harness 实渲）：窗框 242 / 侧栏 252 / 内容面 252 / 输入框 253 —— 与 Codex 浅色的 245 / 252 / 253 同构（差值是种子 `#fcfcfc` vs `#ffffff`，同一公式）。