# 加载动效大面积失效：真实根因与修复

- 日期：2026-09-16
- 现象：流式对话期间，界面上所有 loading 动效**一起**失效 —— `DotMatrix` 点阵闪烁、
  `RunningElapsedTimer` 的 `.shimmer` 流光、"正在执行 · 46s" / "运行中 · 29s"、
  左侧面板的会话/加载图标，全部静止。

> **勘误**：本文件的第一版把根因归为"分帧绘制的 60Hz 提交把主线程占满"。**那个结论是错的**，
> 已由下面的直接测量推翻。同轮的提交节流本身仍是有效的改进（见文末），但它**不是**
> 本次动效失效的原因。

---

## 一、真实根因（已直接测量确认）

### 1.1 两步证据

**第一步：这台机器的 `prefers-reduced-motion` 是 `reduce`。**

用本机 Chrome 以 headless 模式探测（`--dump-dom` 读回页面写出的结果，与 Electron 走
同一套 NativeTheme 判定）：

```
PROBE_RESULT={"reduce":true,"noPreference":false,"dark":true,"ua":"...HeadlessChrome/142..."}
```

**第二步：产物 CSS 里存在一条通配符 `!important` 规则，会关掉整个应用的动画。**

`src/styles/globals.css:547` 的这条规则经构建后原样进入
`desktop-electron/renderer-dist/assets/index-DLqJS0sO.css`（偏移 262125）：

```css
@media(prefers-reduced-motion:reduce){
  *,:before,:after{
    scroll-behavior:auto!important;
    transition-duration:.01ms!important;
    animation-duration:.01ms!important;
    animation-iteration-count:1!important
  }
}
```

`*` + `!important` ⇒ **每一个元素的每一个动画**都被压成 0.01ms 且只播一次。
两步叠加的结果就是"全应用动效一起失效"，包括与渲染路径完全无关的左侧面板。

### 1.2 这不是代码回归

这些 loading 动效的代码路径（`dot-matrix.tsx`、`RunningElapsed.tsx`、
`ProjectExplorer`、`SidePanel` 等）在前面几轮里**一处都没有被改动**。这条 CSS 规则
和系统偏好都不是本轮引入的。

之所以感觉"改完之后才失效"，最可能是系统侧的"动画效果"开关被关闭（Windows 更新或手动
更改），或此前未留意到；本次因为连续几轮都在看流式表现，被注意到并归因到了最近的改动上。

---

## 二、修复：状态类动画保留（降速），装饰类照旧停掉

### 2.1 为什么值得改而不是"让用户去开系统设置"

`*, * { animation: none !important }` 这种写法对**装饰性**动画是正确的，但对**状态
指示**动画是错的：CodeMUX 的核心场景是"agent 跑几分钟、用户切去别的窗口"，此时
`正在执行 · 46s` 与转圈图标承载的是"**还在运行**"这一信息。完全静止会让状态不可读 ——
那就不是"少了个动效"，而是**信息丢失**。

因此改为：**装饰/入场/骨架动画照旧停掉；负载类动画（转圈、点阵、流光、运行中脉冲）
保留，但降速到 2.4s 的呼吸级** —— 既不以高频闪烁刺激，也不丢失状态反馈。

### 2.2 实现（`globals.css`）

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }

  html .animate-spin,
  html .animate-pulse,
  html .animate-pulse-soft,
  html .animate-glow-pulse,
  html .shimmer,
  html [data-motion-status],
  html [data-motion-status] * {
    animation-duration: 2.4s !important;
    animation-iteration-count: infinite !important;
  }

  html .shimmer { animation-name: shimmer !important; }
  html [data-slot='dot-matrix'] * {
    animation-name: aui-dot-matrix-blink !important;
    animation-duration: 2.4s !important;
    animation-iteration-count: infinite !important;
  }
}
```

两个必须注意的点：

1. **特异性**：状态规则带 `html` 前缀（0,1,1），稳定压过通配规则（0,0,0）。因此**不需要**
   把通配规则改写成复杂的 `:not()` 列表 —— 那种写法要把名单重复三遍，易错且难审。
2. **光恢复时长不够**：`DotMatrix` 的圆点带 Tailwind 的
   `motion-reduce:[animation-name:none]`，`RunningElapsedTimer` 的流光带
   `motion-reduce:animate-none`（即 `animation: none`）—— 这两处**把动画名也清掉了**。
   名字为 `none` 时一秒都不会动，所以必须把 `animation-name` 一并写回。
   **这一点是第一版探针跑出来才发现的**（当时 `dotMatrixDot.name` 读数是 `none`）。

### 2.3 验证（在本机真实条件下）

用本机 Chrome headless 加载一个复制了上述规则 + 真实 markup 结构的探针页，
读取 `getComputedStyle`。因为这台机器 `reduce` 为真，所以这是**真实的降级路径**，不是模拟：

| 元素 | animation-name | duration | 次数 | 期望 |
|---|---|---|---|---|
| DotMatrix 圆点（内联 duration + `motion-reduce:[animation-name:none]`） | `aui-dot-matrix-blink` | 2.4s | infinite | ✅ 恢复 |
| `.shimmer`（带 `motion-reduce:animate-none`） | `shimmer` | 2.4s | infinite | ✅ 恢复 |
| `.animate-spin` | `spin` | 2.4s | infinite | ✅ 恢复 |
| `.animate-pulse` | `pulse` | 2.4s | infinite | ✅ 恢复 |
| 装饰性 `.animate-in` | `fade-in` | **0.01ms** | **1** | ✅ 仍停用 |
| 普通带动画元素 | `shimmer` | **0.01ms** | **1** | ✅ 仍停用 |

---

## 三、你可以怎么取舍

- **想要完全静止**（严格遵循系统偏好）：把 `globals.css` 里那段状态规则删掉即可，
  会退回改动前的行为。
- **想要全速动画**：Windows「设置 → 辅助功能 → 视觉效果 → 动画效果」打开，
  或临时在控制台看 `matchMedia('(prefers-reduced-motion: reduce)').matches` 是否为 `false`。
- 浮层新增的 `系统动效 · 已被系统关闭` 行可直接显示这个状态（仅 DEV 且命中时出现）。

构建提示：本次只改了 CSS。`npm run dev:desktop` 会热更新；若跑的是打包产物，需要重新构建。

---

## 四、同轮另一项改动：分帧绘制的提交节流（与本次故障无关，但保留）

上一轮新增的分帧绘制原本按 rAF **每帧提交**，每次提交都会让 `Streamdown` 对累积正文
重新分块并对尾部代码块重跑 Shiki 分词，60Hz 提交等于每秒 60 次 Markdown 解析。
这一项**确实是值得改的**（Paseo 能在 60Hz 是因为它每帧只渲染纯文本 `<Text>`，
这个前提在 CodeMUX 不成立），因此保留：

- 提交按 `minFrameMs`（默认 40ms ≈ 25Hz）节流，**低于改动前 50ms 窗口驱动的 20–40 次/秒**；
- 闸门**跨实例共享**（`StreamingContent` 跑两个绘制实例，各自计时会错开提交、频率翻倍）；
- 加载指示器抽成 `memo` 的 `StreamingStatusFooter`，脱离重渲染路径；
- 平滑度度量口径修正 + 哨兵值 bug（`windowStartedAt` 用 `0` 当"未开始"与合法时间戳
  0 冲突）+ 样本缓冲上限。

**但它不是本次动效失效的原因。** 上一轮的报告把两者混为一谈，这里的措辞已更正。

---

## 五、教训

1. **我犯了"用推断替代取证"的错**：把"绘制类动画在主线程饱和时会冻住"这个**正确的一般
   事实**，直接套到本次故障上，而没有先测环境。**正确的顺序是先问"环境是否已经禁用了
   动画"，再谈渲染成本** —— 一条 `*, * { animation: none !important }` 就在仓库里躺着，
   我读了 `globals.css` 的其它部分却跳过了它。
2. **可复用的取证手段**：本机 Chrome `--headless=new --dump-dom` 加载一个把
   `matchMedia` 结果写进 DOM 的探针页，可以**确定性地**读回 `prefers-reduced-motion` /
   `prefers-color-scheme` 等环境媒体查询 —— 与 Electron 同源判定，无需启动应用。
   同类"环境相关"的疑难症状应优先用它排除。
3. **不要用 `!important` 通配规则一刀切地禁用动画**：对装饰动画是对的，对**状态指示**
   动画是错的 —— 后者承载信息。正确做法是分档处理。
