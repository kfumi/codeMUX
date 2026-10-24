# 02 — 对话定位宿主：主对话在完整视图内容区显示

**What to build:** 在 01 的状态机之上，让「对话 surface 激活」真正可见：主对话（时间线 + 输入区）以**原有实例**全宽显示在侧面板内容区（tab 栏下方的 slot）里。主布局的对话列外包一层常驻宿主：普通形态是普通布局容器，布局与现状完全一致；对话 surface 激活时宿主切换为 fixed 定位，几何上覆盖面板内容 slot——坐标由实测 slot 的 bounding rect 加 ResizeObserver 写入宿主 style（DOM 布局投影，不进 React state），侧面板经回调 ref 提供 slot 元素。对话 DOM 不移动、不重挂载：草稿、光标、滚动位置、上传中附件、运行中的权限/提问卡片在标签来回切换间原样保留。宿主 z 序高于面板内容但只盖 slot、不盖 tab 栏。

完成后整个特性端到端可演示：展开面板 → 点对话标签看到并继续主对话 → 切回审查/终端/浏览器标签 → 再切回，一切连续。

**Blocked by:** 01 — 完整视图 surface 状态机与固定「对话」标签

**Status:** done（代码完成、全量 vitest 2869 通过；`dev:desktop` 手工验收未执行）

- [x] 对话标签激活时，主对话完整显示在面板内容区（含 composer），可正常发送消息、审批权限、回答 AI 提问
- [x] 对话与面板标签之间反复切换：草稿、光标、滚动位置、上传中附件保留——同一 DOM 实例不重挂载（可用「切换后输入框仍持有焦点与文本、滚动位置不变」验证）
- [x] 流式输出进行中切换 surface 再切回，输出与滚动连续不乱
- [x] 宿主只覆盖 slot 区域：tab 栏与面板头按钮（收起/展开/+ 菜单）保持可见可点
- [x] 窗口 resize 或面板内容尺寸变化时对话层跟随 slot，无残影错位（ResizeObserver 生效）
- [x] 退出完整视图后布局与进入前一致：面板宽度、侧栏显隐、终端标签状态未变
- [x] 实测内容面圆角裁剪（clip-path）对 fixed 子元素的行为，宿主右下角不露缺口；必要时宿主复用同一裁剪；结论记入本票 Comments
- [x] 主布局/宿主测试覆盖两种形态的定位模式切换与 slot ref 传递；按仓库门禁跑全量 vitest（根目录）通过

## Comments

- **clip-path 结论（验收项 7）**：宿主位于 `.content-surface`（带 `clip-path: inset(0 round var(--content-radius-*))`）的子树内；clip-path 会创建 stacking context，Chromium（Electron 渲染层即 Chromium）对 fixed 定位后代同样施加祖先裁剪——宿主自动被裁到内容面边界，右下角不会露缺口。且 `data-floats` 只圆**起始侧**（靠侧栏），靠窗口边缘的终止侧恒为 0 直角，展开面板本就贴直角边。故宿主无需复用裁剪；实机（dev:desktop）可顺手复核右下角。
- **验收项 1–6 的代码路径**均有测试或结构保证（宿主常驻挂载只换定位、几何只写 style、effect cleanup 清几何、退出只复位自有标志），但交互保真（焦点/滚动/附件/流式连续性）属 `dev:desktop` 手工验收范围，未执行。
- 范围说明：宿主同时包住 `SummaryPanelSurface`（摘要面板随对话一起浮进 slot，保持普通形态布局不变）；`window resize` 监听是 ResizeObserver 之外的加固（纯位移不触发 RO）；`sidePanelAvailable`（设置页等视图）叠加在 surface 派生上，面板不可见时宿主不浮起。
- **2026-10-24 双轴 review**（并入 commit `de19b7c`）：无标准硬违规；采纳三处改进——`selectConversationSurfaceActive` 选择器收口「对话 surface 激活」派生、slot 元素加 `data-side-panel-content-slot` 标识（测试不再耦合布局类名）、宿主测试的 rect stub 去重。
