# 02 圆角刻度、描边式 elevation 与动效曲线

**What to build:** 界面的形状与浮起感对齐 Codex。圆角阶梯补齐成 2/4/6/8/12/16/24/32，支持超椭圆的引擎上整体放大 1.25 倍；浮层靠「一圈细描边 + 极近距离小模糊 + 超大扩散极低透明度」浮起来，而不是常规投影；面板切换与展开收起的节奏和 Codex 一致。用户选三档圆角强度时，整套阶梯的**相对关系**保持不变，只是整体缩放。

**Blocked by:** 01

**Status:** done

- [x] 圆角阶梯补齐为 2 / 4 / 6 / 8 / 12 / 16 / 24 / 32（现有 4/6/8/12 四档本来就与 Codex 逐档重合，缺的是 2/16/24/32）
- [x] 用 `@supports` 渐进增强：支持 `corner-shape: superellipse(1.5)` 的引擎上整套刻度乘 1.25 并套用 `corner-shape`；不支持的退回 1 倍标准圆角
- [x] 浏览器宿主强制退回 1 倍标准圆角（与 Codex 一致）；桌面端与移动端启用条件一致
- [x] 三档圆角设置从「指定具体值」改成「Codex 刻度的缩放档」：sharp ×0.75、soft ×1.0（等于 Codex 原值，默认）、round ×1.35
- [x] elevation 体系成型：`0.5px 描边` + 近距离小模糊 + 超大扩散极低透明度三段式，接入表面面板与后续浮层；深色下提供内发光变体
- [x] 四条缓动的**值**换成 Codex 的（进入 `.19,1,.22,1` / 退出 `.8,0,.4,1` / snappy `.65,0,.4,1` / move `.65,0,.35,1`），三条时长保留 150/200/300ms
- [x] ⚠️ 现有动效 token 源码契约测试硬编码断言了当前曲线值，必须同步更新，否则本票第一步就会红
- [x] 源码契约测试新增「圆角不得写成字面量 px」的禁令，与既有的动效禁令同一模式
- [x] 三档圆角逐档截图确认：阶梯形状不变，只有整体缩放差异

## 代码评审修复

- **超椭圆只对桌面壳生效**：原来是无条件 `@supports` + 通配 `*`，PC 浏览器与移动端也会拿到 1.25 倍圆角 —— 与 spec 第 44 条 / 票面「浏览器宿主强制退回 1 倍」矛盾。改为 `html[data-host='desktop']` 作用域；`data-host` 由首帧引导脚本写入（`themeBoot.ts` 的 `THEME_BOOT_SCRIPT`），所以 JS 起来之前圆角就已经正确，不存在「先 1 倍后 1.25 倍」的跳变。
- **两条缓动曲线原本写反**：`ease-motion-in-out` / `ease-motion-standard` 与 spec 决策 13 相反。已换回并同步更新 `motionTokens.test.ts` 与 AGENTS.md。
- **`--radius-content` 原是写死的 15px**，不受两个缩放因子影响 —— sharp 档下整条阶梯都在缩放、唯独它不变。改成 `calc(0.9375rem * scale * superellipse)`，即阶梯里的一档。
- **`.surface-panel` 等面板类原本无 layer**：无 layer 的规则永远赢过 Tailwind utilities，挂在上面的 `shadow-elevation` / `bg-popover` 会静默失效。整体移进 `@layer components`。