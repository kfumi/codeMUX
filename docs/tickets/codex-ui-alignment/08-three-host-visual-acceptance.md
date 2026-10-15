# 08 三宿主截图对照验收

**What to build:** 形状层无法数值断言的那部分——导航栏宽度、圆角裁切的实际观感、composer 两层间距——用逐区截图比对收尾。三宿主（桌面 / PC 浏览器 / 移动）× 浅色 / 深色共 6 套，与 Codex 同屏比对，把残留差异记录成可执行的返工项。验收通过的口径是：打开 CodeMUX，第一眼能认出是那个风格。

**Blocked by:** 03, 04, 05, 06

**Status:** 自动化项 done，人工截图验收待执行

- [x] 自动化替代：`src/styles/distWebTokens.test.ts` 直接对 `dist-web/` 产物断言阶梯 / elevation / 明暗兜底值 / 内容面 token（见 Comments）
- [ ] 桌面端浅色 / 深色各出一张全窗口截图，覆盖：首屏新建会话页（问候区居上、composer 贴底）、导航栏、侧栏、标题栏、内容面圆角、composer 与上下文条、至少一个浮层
- [ ] PC 浏览器端同样两套（走 `dist-web` 产物，注意浏览器端超椭圆按设计退回 1 倍圆角）
- [ ] 移动端同样两套
- [ ] 每张与 Codex 对应区域并排比对，逐条记录残留差异
- [ ] 残留差异要么当场修掉，要么转成新的返工票，不允许「差不多」
- [ ] 特别复核三处高风险项：① `--sidebar-fg`（全仓最高频引用）落到 secondary 还是 tertiary 的档位是否正确；② 导航栏实测宽度；③ 页面浮层圆角在深色下的实际观感
- [x] 自动化替代：构建门禁 `npm run build` + `npm run build:web` + 全量 `npx vitest run` 通过，首帧底色与 surface 种子的对齐由 `themeBoot.test.ts` 钉住

## Comments

自动化部分完成，人工截图部分**未执行**。

**已自动化**（新增 `src/styles/distWebTokens.test.ts`，9 条）：直接读 `dist-web/` 产物做断言 —— 圆角阶梯九个档位都进了产物、`@supports (corner-shape: superellipse(1.5))` 出现在默认值之后、elevation 四档工具类、明暗两套兜底值与派生引擎逐项一致、深色 surface 是纯黑、三个内容面圆角 token 与 `clip-path` 都在、三档文字色与 diff 色工具类都产出。产物不存在时整组 `skip`（不是失败）。

这份测试当场抓到两个真实问题：
1. `@theme` 默认按需产出，导致 `--radius-xs` 因为「当前没组件用到」被摇掉，阶梯在产物里缺了一格 → 改用 `@theme static`。
2. `:root` 里 `--diff-added` 的兜底值写错（照抄了 `--success` 的值而不是 `#00a240` 的派生结果）→ 改正。

**已跑通的构建**：`npm run build`（tsc + Vite，桌面渲染层）、`npm run build:web`（浏览器 / 移动宿主产物）、sidecar `npx vitest run` 767 passed、仓库根 `npx vitest run` 2483 passed / 7 failed（7 条全部是本工作开始前就在 master 上复现的 `ActivityStepThinking` / `CodeMuxAssistantRuntime` / `CodeMuxThread.streamingSegments` 失败，与本次改动无关，已用 `git stash` 对拍确认）。

**未执行**：三宿主 × 明暗的逐区截图比对。本会话运行在 CodeMUX 自身进程内，宿主自身窗口不在 `computer_windows` 的清单里（设计如此），拿不到应用窗口画面；本机也没有可驱动的外部浏览器来加载 `http://127.0.0.1:<port>`。

**留给人工的清单**：
- 桌面端浅色 / 深色各一张全窗口截图：导航栏宽度、侧栏、内容面圆角裁切、composer 与上下文条、至少一个浮层。
- PC 浏览器端两套（走 `dist-web`；浏览器端超椭圆按设计退回 1 倍圆角）。
- 移动端两套（390px 宽；图标轨已隐藏，顶层视图切换在抽屉顶部分段行、Proxy 状态/移动伴侣/设置在抽屉页脚，内容区应为全宽）。
- 特别复核三处高风险：① `--sidebar-fg` 落到 secondary 还是 tertiary 档位；② 导航栏实测宽度是否 56px；③ 页面浮层圆角（15px）在深色下的实际观感。
- 端到端跑一遍：改对比度、改强调色、切三宿主、深浅各切一次，确认首帧无错配窗口。
- **Win11 贴靠布局**：悬停自绘的最大化按钮，确认窗口仍可贴靠与最大化（见 04 的 Comments）。