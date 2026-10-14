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