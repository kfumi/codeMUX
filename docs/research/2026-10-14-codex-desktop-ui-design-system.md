# Codex（ChatGPT）桌面端 UI 设计体系逆向

调研对象：本机安装的 `OpenAI.Codex` 桌面端，MSIX 包 `OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0`。

结论先行：**它的好看不是靠一堆手挑的色值，而是靠"极小的语义种子 + 算法化派生 + 一套克制的刻度"**。整套前端 CSS 在 `app.asar` 里是明文可读的，下面的数值都是从安装包里直接抠出来的原文。

---

## 0. 怎么再读一次这些源码

```
安装根: C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0\
  app\resources\app.asar            # 567 MB，Electron(Owl 壳) 打包，前端全在里面
```

`app.asar` 是标准 Chromium pickle 格式：前 16 字节是头，之后是一段 JSON 目录树。解出目录树后按 `offset` 直接 `read` 即可，**不需要整包解压**。

关键文件（进入 `webview/assets/` 后按名字找，哈希会随版本变）：

| 文件 | 作用 |
|---|---|
| `app-initial-<hash>.js`（注意扩展名是 `.js`） | **主题引擎**：`Aba()` / `jba()` / `Nba()` 三个函数生成全部颜色变量；`cya` 是主题预设 |
| `app-initial-<hash>.css`（其实是 JS） | 同上另一份，主题变量映射表 |
| `app-shared-<hash>.js` | 巨型共享 chunk，尾部集中注入全局 CSS（`:root` token、elevation、tailwind v4 `@property`） |
| `ar-*.js` / `is-*.js` 等 locale chunk | 每个都打包了一份**完整的全局 CSS**，是最容易读的入口 |
| `webview/index.html` | 其实是 i18n 字典，不是 HTML 外壳 |

> 坑：`app-shared-<hash>.css` 这个名字下装的其实是 JS 遥测枚举，按文件名猜类型会扑空。

---

## 1. 技术栈

- **Electron + 自研 Owl 壳**（`owl-electron-app.json` / `owl-shell-runtime.json`），Chromium 155。
- **React + Tailwind CSS v4**。判据：产物里有完整的 `--tw-border-spacing-x` / `@property --tw-scale-x` / `@layer components{@layer properties{` 结构。Tailwind v4 没有 `tailwind.config.js`，主题全在 CSS `@theme` 里，且**被构建期抽成了 JS**（所以 grep CSS 找不到 token 定义）。
- **lightningcss** 负责产物压缩。产物里的 `--lightningcss-light` / `--lightningcss-dark` 是 lightningcss 把 CSS 原生 `light-dark()` 降级成变量技巧的产物：

  ```css
  --color-text-danger: var(--lightningcss-light, var(--red-400)) var(--lightningcss-dark, var(--red-300));
  ```
  现代浏览器直接用 `light-dark()`，老浏览器读到 fallback 分支。**这是全套明暗切换的实现方式**，没有 `.dark` 类切换。

---

## 2. 颜色：4 个种子 + 1 个对比度参数，算出全部语义色

这是整套设计最值得抄的部分。

### 2.1 主题对象（`cya`，权威预设，原文）

```js
{
  light: {
    accent: '#3a83f7',          // ChatGPT 蓝
    accentSource: 'chatgpt',
    contrast: 45,               // ← 0..100 的"对比度旋钮"，驱动所有 alpha 步进
    fonts: { code: null, ui: null },
    ink: '#0d0d0d',             // 主文字色
    surface: '#fcfcfc',         // 基础表面
    opaqueWindows: true,        // 是否关掉系统毛玻璃
    semanticColors: { diffAdded: '#00a240', diffRemoved: '#ba2623', skill: '#924ff7' },
  },
  dark: {
    accent: '#3a83f7',
    contrast: 60,
    ink: '#ededed',
    surface: '#000000',
    semanticColors: { diffAdded: '#40c977', diffRemoved: '#fa423e', skill: '#ad7bf9' },
  },
}
```

**用户能改的只有 accent / ink / surface / contrast / 字体 / 语义色**。其余几十个 `--app-color-*` 全是运行时算出来的。

> **深色 surface 取哪个值（2026-10-14 补充）**：包体里有两个内置值 —— 上面这份 `cya` 预设是 `#000000`，
> `KJ`（默认主题表，`kba` / `Fba` 拿它当参照）是 `#181818`；实机上用户 `~/.codex/config.toml` 里配的是
> `surface = "#111111"`。**CodeMUX 的深色种子取 `#111111`**：既与用户实际看到的 Codex 逐位一致，
> 也给窗口面留出了「比表面再深一档」的余量（纯黑表面无处可退，见 2.4）。

### 2.2 派生公式（`jba` 浅色 / `Nba` 深色，节选原文）

两套函数结构完全对称，只是混色目标不同：浅色往 **white** 混，深色往 **black** 混。

| 变量 | 公式 | light(45) 实际值 |
|---|---|---|
| `--app-color-border-light` | `rgba(ink, .04 + c*.02)` | `#0000000f` |
| `--app-color-border` | `rgba(ink, .06 + c*.04)` | `#00000013` |
| `--app-color-border-heavy` | `rgba(ink, .09 + c*.06)` | `#0000001a` |
| `--color-text` / `iconPrimary` | `ink` | `#0d0d0d` |
| `--color-text-secondary` / `iconSecondary` | `rgba(ink, .65 + c*.10)` | `#7a7a7a` |
| `--color-text-tertiary` / `iconTertiary` | `rgba(ink, .45 + c*.10)` | `#666` |
| `--color-background-accent` | `mix(surface, accent, .11 + c*.04)` | 淡蓝底 |
| `elevatedPrimary` | 浅色 `mix(surface, white, .16 + c*.12)` / 深色 `mix(surface, ink, .08 + c*.08)` | `#fff` 半透 |
| `elevatedSecondary` | 浅色 `mix(surface, white, .08 + c*.08)` / 深色 `rgba(ink, .02 + c*.02)` | |
| `controlBackground` | 浅色 `mix(surface, white, .09 + c*.04)` | |
| `simpleScrim` | `rgba(black, .08 + c*.04)` | |
| `buttonPrimaryBackground` | **light: `ink`；dark: `mix(surface, white, .38 + c*.12)`** | 主按钮反色 |
| `--app-color-border-focus` | `accent` | 焦点环 |

几个关键设计决定：

- **三档文字层级**（primary / secondary / tertiary），且 tertiary 在深色下从 `.45+c*.10` 放宽到 `.42+c*.13`（`Nba` 专用），保证深色可读性。
- **边框极细**：`border` 只有 8% 左右的墨色 alpha（浅色下 ≈ `#00000013`）。这就是它"看起来通透"的直接原因——**不用灰，用墨色低 alpha**。
- **hover 一律不用深浅**，统一往 `ink` 方向 `color-mix` 加 4~8%。
- `contrast` 旋钮让用户能整体"加重/减轻"UI，且**同一份代码同时服务 light 和 dark**。

### 2.3 中性灰阶（全局共享，极短）

```css
--gray-0:#fff;  --gray-25:#fcfcfc; --gray-50:#f9f9f9;  --gray-75:#f2f2f2;
--gray-100:#ececec; --gray-200:#e3e3e3;
--gray-750:#2f2f2f; --gray-800:#212121; --gray-950:#0d0d0d;
```

只有 9 档，且**浅色段和深色段刻意不对称**（`200` → `750` 之间直接跳过），因为实际用不到中间的深灰。

### 2.4 外壳的平面阶梯：谁比谁深，各深多少（2026-10-14 实测）

外壳不是「一块底 + 一块面板」，而是**窗框 + 面板 + 抬高档**三层。三层的取值都有公式，不是手挑的：

| 平面 | Codex 的 token / 公式 | 浅色(seed `#fcfcfc`, c=45) | 深色(seed `#111111`, c=60) |
|---|---|---|---|
| 窗口面（顶栏条 + 左侧图标轨连成的一片） | `surfaceUnder`（`Fba`）：浅色 `mix(surface, ink, .04 + (c-.45)*.0012)` / 深色 `mix(surface, black, .16 + (c-.6)*.0015)` | `#f2f2f2` = 242 | `#0e0e0e` = **14** |
| 侧栏 | `--color-surface`（= **surface 种子**） | `#fcfcfc` = 252 | `#111111` = 17 |
| 内容面 | `--color-surface`（同上；`_MainContentSurface_[data-app-shell-main-surface=default]` 就取它） | 252 | 17 |
| composer 输入框 | `--color-surface-elevated` = `elevatedPrimary`（浅色 `mix(surface, white, .16 + c*.12)` / 深色 `mix(surface, ink, .08 + c*.08)`） | 253 | `#2f2f2f` = **47** |
| composer 上下文条 | `--color-background-composer-action-bar` = 浅色 `--color-surface-secondary` / 深色 `elevatedSecondaryOpaque` = `mix(surface, ink, .04 + c*.05)` | 245 | `#212121` = **33** |

实机像素（无损 `PrintWindow` 抓图，用户自己的深色主题）：**窗框 14 / 侧栏 16 / 内容 17 / 上下文条 33 / 输入框 47**。
两条结论比具体数值更重要：

1. **窗框比面板更深**（浅色 242 < 252，深色 14 < 17），两套主题方向一致。这是「面板浮在窗框上」的读数来源。
2. **侧栏与内容面几乎是同一个颜色**（差 1 级），靠一条发丝分隔线分开。把它们拉开十几级（比如深色下侧栏纯黑、内容面用抬高档）会读成「面板上有个洞」。

第 2 条正是 CodeMUX 深色之前踩的坑：内容面误用了 `elevatedPrimary`（那是 composer 的档），
于是侧栏 0 / 内容面 30，差出 30 级；而 composer 又和内容面同色（都是 `--surface-1`），等于没有抬高。

**右侧面板是「凹面 + 平面卡片」（2026-10-15 补充，浅色实机量测）**：

| | Codex 的 token / 公式 | 浅色实测 |
|---|---|---|
| 面板主体 | `--color-surface-canvas` = `color-mix(in srgb, var(--color-surface) 98%, var(--black))` | **250**（内容面 255） |
| 顶栏条 / 地址栏那一带 | `--color-surface`（表面档） | 255 |
| 标签页（激活）/ 工具卡片 | `--color-surface` + `--color-border` 发丝描边 | 255（在 250 上，+5） |

即：**面板主体比内容面低一档，面板里的卡片回到表面档**。深色下 `98%` 只差不到 1 级
（`#111111` → 16.66，8bit 取整后仍是 17），所以那一侧的分层靠描边与抬高档，不靠凹面 ——
CodeMUX 因此把卡片取在 `elevatedPrimary`（深色下 45），比 Codex 的「只有描边」更立得住。

---

## 3. 圆角：极小基数 + Superellipse 渐进增强

```css
--radius-xs-base:  .125rem;   /*  2px */
--radius-sm-base:  .25rem;    /*  4px */
--radius-md-base:  .375rem;   /*  6px */
--radius-lg-base:  .5rem;     /*  8px */
--radius-3xl-base: 1.5rem;    /* 24px */
--radius-4xl-base: 2rem;      /* 32px */
--radius-full: 9999px;
```

**关键的一条**（`@supports` 渐进增强）：

```css
@supports (corner-shape: superellipse(1.5)) {
  :root {
    --codex-corner-radius-scale: 1.25;
    --codex-corner-shape: superellipse(1.5);
    --radius-md:  calc(var(--radius-md-base) * var(--corner-radius-scale));
    --radius-lg:  calc(var(--radius-lg-base) * var(--codex-corner-radius-scale));
    /* xl / 2xl / 3xl / 4xl 同样放大 */
  }
  .rounded-md, .rounded-lg, .rounded-xl, .rounded-2xl, ... {
    corner-shape: var(--codex-corner-shape);
  }
}
:root[data-codex-window-type=browser] { /* 浏览器端关掉，走标准圆角 */
  --codex-corner-radius-scale: 1;
  --codex-corner-shape: round;
}
```

桌面端把圆角整体放大 25% 并换成**超椭圆（squircle）**，浏览器端保持 1:1 圆角。这是"同一个设计系统、两种气质"的分叉点。

另外两个高频特例：

- 侧栏行 `--radius-token-row: 9999px` —— **完全药丸形**。
- 输入框容器 `--composer-radius: calc(var(--spacing) * 7)` = 28px，`--composer-corner-shape: superellipse(1.1)`（比全局更"方"一点）。

---

## 4. 间距与尺寸

```css
--spacing: 4px;   /* 唯一基数，所有间距都是 calc(var(--spacing) * N) */
```

| Token | 值 | 说明 |
|---|---|---|
| `--padding-row-y` | `spacing * 1` = 4px | 列表行上下留白 |
| `--height-token-nav-row` | `text-base*1.5 + padding-row-y*2` = **32px** | 侧栏行高 |
| `--padding-panel` | `spacing * 3` = 12px | 面板内边距 |
| `--padding-toolbar` | `spacing * 4` = 16px | 工具栏 |
| `--height-toolbar` | `spacing * 13` = **52px** | 标题栏/工具栏高 |
| `--sidebar-navigation-header-height` | `spacing * 13` = 52px | 与工具栏对齐 |
| `--max-height-suggestion-menu` | 320px | |
| `--thread-content-top-inset` | `spacing * 8` = 32px | |
| `--thread-content-margin` | `spacing * 3` = 12px | |
| `--thread-gutter` | `clamp(12px, 3cqi, 24px)` | **容器查询**做流式边距 |
| `--conversation-item-gap` | 16px | 消息之间 |
| `--conversation-grouped-item-gap` | 4px | 同组消息之间 |
| `--composer-inline-overhang` | `spacing * 6` = 24px | composer 比正文宽出的量 |
| `--home-composer-inline-inset` | `spacing * 3.25` = 13px | |
| `--thread-content-max-width` | **48rem** = 768px（浏览器紧凑档 40rem） | 正文栏宽 |

**控件尺寸阶梯**（`--control-size-*`，浏览器端 == 按钮高度）：

```
4xs 20 · 3xs 22 · 2xs 24 · xs 26 · sm 28 · md 32 · lg 36 · xl 40 · 2xl 44 · 3xl 48
--control-gutter-*: 6 · 8 · 10 · 12 · 14 · 16
```

---

## 5. 字体与排版

```css
--font-sans-default: -apple-system-body, ui-sans-serif, -apple-system, system-ui,
                     "Segoe UI", "Helvetica", "Apple Color Emoji", "Arial", sans-serif;
--font-code-family:  ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas,
                     "Liberation Mono", monospace;

body { color: var(--color-text);
       font-family: var(--font-ui-family);
       font-weight: var(--font-ui-weight);   /* Electron 下 = 430 */
       background: transparent; height: 100svh; }
#root { height: 100svh; }
```

**Electron 端的字号整体下调一档**（为桌面小窗口优化）：

```css
[data-codex-window-type=electron] {
  --text-sm: 13px;      /* 浏览器端 14px / .875rem */
  --text-xs: 12px;
  --font-weight-medium: 500;
  --font-ui-weight: 430;   /* ← 非标准字重，取 400~500 之间的中间值 */
}
```

完整字阶（`--font-text-*` / `--font-heading-*`，每档都是 size+line-height+weight+tracking 四元组）：

| token | size | line-height | weight |
|---|---|---|---|
| text-3xs | .5rem (8) | .75rem | 400 |
| text-2xs | .625rem (10) | .875rem | 400 |
| text-xs | .75rem (12) | 1.125rem | 400 |
| text-sm | .875rem (14) | 1.25rem | 400 |
| text-md | 1rem (16) | 1.5rem | 400 |
| text-lg | 1.125rem (18) | 1.8125rem | 400 |
| heading-xs | 1rem | 1.5rem | 600 |
| heading-md | 1.25rem | 1.625rem | 600 |
| heading-lg | 1.5rem | 1.75rem | 600 |
| heading-2xl | 2.25rem | 2.625rem | 600 |
| heading-5xl | 4.5rem | 4.5rem | 600 |

注意 `text-*` 全部 400 字重，**只有 heading 用 600**——正文不加粗是这个设计的关键克制点。

行高用比例 token（`--leading-relaxed` 等），Markdown/表格行高统一 `calc(font-size * leading-relaxed)`，Markdown 间距 `calc(font-size / 4)`。

Diff 专用：`--diffs-line-height: calc(var(--diffs-font-size) * 1.8)`（**1.8 倍行高**，为了看多行变更）。

---

## 6. 阴影：分"描边式 elevation"和"投影式 shadow"两套

**A. elevation 系列——以 0.5px 描边打底**，这是它"卡片浮起来但不脏"的原因：

```css
--elevation-stroke:        0 0 0 .5px var(--color-border-strong);
--elevation-stroke-subtle: 0 0 0 .5px rgb(from var(--color-border-strong) r g b / .04);
--elevation-prominent:  var(--elevation-stroke), 0 3px 7.5px  #0000000a, 0 0 20px  #0000000d;
--elevation-sidebar:   var(--elevation-stroke), 0 3px 7.5px  #00000008, 0 0 16px  #00000005;
--elevation-composer:  0 0 0 1px #0000000a, 0 2px 8px 0 #0000000a, 0 4px 80px 8px #00000006;
--elevation-composer-dark: inset 0 0 1px 0 #ffffff3;   /* 深色下换成内发光 */
```

规律：**近距离小模糊 + 超大 spread 极低透明度**（`0 4px 80px 8px #00000006`）。这是把窗口背景的"环境光"模拟出来，远比常规 `0 4px 12px rgba(0,0,0,.1)` 高级。

**B. shadow 系列——几何 + 颜色分离**，同一套阴影可以派生 3 档强度：

```css
--shadow-100: var(--elevation-100-geo) rgb(var(--shadow-color) / var(--shadow-alpha-100));
--shadow-100-strong:   /* 同几何 × 1.25 alpha */
--shadow-100-stronger: /* 同几何 × 1.60 alpha */
```

以及 `--shadow-card: 0 4px 16px 0 #0000000d`。

---

## 7. 动效

```css
--cubic-enter:       cubic-bezier(.19, 1,   .22, 1);   /* 进入：强减速 */
--cubic-exit:        cubic-bezier(.8,  0,   .4,  1);   /* 退出：快走 */
--cubic-exit-snappy: cubic-bezier(.65, 0,   .4,  1);
--cubic-move:        cubic-bezier(.65, 0,   .35, 1);   /* 尺寸变化 */
--transition-duration-basic: .15s;
--transition-ease-basic: ease;
--animation-duration-streaming-text: .7s;
--duration: 0s;
```

`cubic-bezier(.19,1,.22,1)` 是当下最流行的"expo out"曲线。**时长克制在 75–150ms**，且全部包了 `@media (prefers-reduced-motion: reduce)`。

两个很有想法的细节：

- `@property --top-fade / --bottom-fade` + `@keyframes edge-fade` —— 滚动列表顶/底渐隐用**可插值的自定义属性**实现，不是遮罩层。
- 滚动条 `--scrollbar-color: var(--alpha-30)`，以及滚动条 `gutter: stable` 防止内容跳动。

---

## 8. 布局架构（从截图 + CSS 属性名还原）

从截图可以看到，实际窗口是：

```
┌──────────────────────────────────────────────────────────┐
│ ← → │ 文件 编辑 视图 帮助              ─ □ ×   ← Windows 原生标题栏 │
├──┬───────────────────────────────────────────────────────┤
│⛶ │ Codex ⌄                              🔔 🔍        │ ← 侧栏头 52px
│◷ │ ✏ 新聊天                                              │
│@ │ 项目                                                  │
│⋯ │  📁 装修                                               │
│  │    帮我做下装修方案，可视化给我展示，…                  │
│  │  📁 codeMUX-gh-pages                                  │
│  │  📁 fumi-git                                          │
│  │  ▐codeMUX▌ ← 药丸形选中态（灰底圆角）                  │
│  │    调整思考消息实时展示                                │
│  │ 最近                                                  │
│  │  调整思考消息实时展示 …                                │
├──┴───────────────────────────────────────────────────────┤
│                                              ┃ ← 细分隔线 │
│                    ⬡ 空状态图标                            │
│         你想让我们在 codeMUX 中构建什么？     ← 大标题居中    │
│                                                           │
│         ┌─────────────────────────────────────┐           │
│         │ 📁codeMUX  💻本地  ⑂master  ← 上下文条│           │
│         │ 随心输入                          │           │
│         │ ＋  ⏱完全访问      6 Luna 极高 ⌄  ↑ │           │
│         └─────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────┘
   ↑ 图标导航栏(窄)
```

对应的 CSS 属性名（都在 `ar-*.js` 的 CSS 里）：

- `--app-shell-titlebar-height` / `--height-toolbar` = 52px
- `--app-shell-main-surface-clip-start-radius` / `-end-radius`，主内容区圆角通过 `clip-path: inset(... round R)` 做**非对称圆角**（左上左上圆、右上直角，见 browser 变体）
- `--app-shell-navigation-rail-width`（图标栏）
- `--app-shell-page-inline-end-inset` = `--spacing`
- `.app-shell-left-panel[data-app-shell-left-panel-appearance=content-surface]` —— 左侧栏有两种形态：纯色 / 与内容同表面
- `--sidebar-navigation-header-height` = 52px，与工具栏严格对齐
- `--sidebar-scroll-footer-fade` / `--sidebar-scroll-header-mask`：侧栏滚动时的上下渐隐
- `--edge-fade-distance` = `spacing * 10`
- `--composer-layout-surface-background` 在 `default / opaque / inline / secondary / document` 五种变体间切

**容器查询用得很重**（`@container style(--theme-variant: dark)`、`50cqi + 50%` 算宽度、`3cqi` 算 gutter），说明它同一份前端要同时跑 Electron / 浏览器 / 移动 / 插件 iframe。

---

## 9. 给 CodeMUX 的可执行建议

按"改动小、收益大"排序：

### 立刻可抄

1. **把 `appearanceStore` 的调色板从"手挑色值"改成"种子 + 派生"**。当前 `globals.css` 里 `bg-background` / `bg-card` / `text-muted-foreground` 是分别定义的。改成只暴露 4 个种子（`surface` / `ink` / `accent` / `contrast`），其余全部 `color-mix` 派生——这样"换主题"只改 4 个值，暗色模式不需要第二套表。

2. **边框用墨色 alpha，不用灰**。`border-border` 在浅色下改成 `rgb(from var(--foreground) r g b / .06)` 这一档。AGENTS.md 里已经写明"透明度只用于表面层次"，这条正好落在允许范围内。

3. **elevation 用"0.5px 描边 + 超大 spread 极低透明度"**，替换现有的常规投影。这是最能拉开质感差距的一条。

4. **超椭圆圆角渐进增强**。CodeMUX 的 Chromium 版本够新，直接上：

   ```css
   @supports (corner-shape: superellipse(1.5)) {
     :root { --corner-radius-scale: 1.25; --codex-corner-shape: superellipse(1.5); }
   }
   ```
   并让 `rounded-*` 消费 `--codex-corner-shape`。

5. **正文不加粗**。CodeMUX 目前 `text-ui-body` 用的是默认字重，对齐到 430（Electron）/ 400，`font-semibold` 只留给标题和强调。

### 需要讨论

6. **给 composer / 对话区一个独立的 "context bar"**（截图中输入框上方那条 `📁 codeMUX · 本地 · master`）。CodeMUX 目前的 composer 是单层的，缺少这层"当前上下文"的视觉锚点。

7. **正文栏宽固定 48rem**，并让 composer 比正文宽 24px（`--composer-inline-overhang`）。CodeMUX 现在两者等宽。

8. **列表行用 9999px 药丸形**，目前 CodeMUX 是圆角矩形。

9. **容器查询替代媒体查询**做侧栏/主区的响应式，配 `3cqi` 做流式 gutter。CodeMUX 三个宿主（Electron / PC 浏览器 / 移动）共用一套前端，这正是 Codex 用容器查询的原因。

### 不要抄

- 别抄它的信息密度。它的功能面（workbook / widget / plugin / skill / 3D 可视化）是 ChatGPT 全家桶，CodeMUX 是多 agent 编排，导航结构应该按自己的心智模型设计，只借**视觉语言**，不借**信息架构**。

---

## 10. 一句话总结

Codex 桌面端的"高级感"来自四件事：**① 用墨色低 alpha 做边框而不是用灰；② 用 4 个种子 + 算法派生出全部语义色，主题只有一个旋钮；③ 阴影靠"0.5px 描边 + 超大 spread 极低透明度"而不是常规投影；④ 圆角极小（2/4/6/8/24/32）再靠 superellipse 放大 25%**。这四条加起来，实现成本极低，但视觉差距是数量级的。
---

## 附录 A. 设置页实测（2026-10-16 补充）

来源两处：用户提供的 Codex 设置页截图（1482×946，用 `zlib` 解 PNG 逐像素取样）与应用包内
明文前端（`app.asar` 的 `chunks/settings-page-*.js`、`chunks/general-settings-*.js`、
`select-*.css`、`app-shared.css`）。工单 `codex-ui-alignment/11` 按这些值改的 CodeMUX 设置页。

### A.1 颜色（截图取样，抗锯齿使测得值偏亮，可视为上限）

| 元素 | 实测最暗像素 | 含义 |
|---|---|---|
| 页标题「常规」 | `#0d0d0d` | 正文墨色 |
| **分区标题「权限」** | `#0d0d0d` | **墨色**，不是灰 —— 只有字号(13px)与字重(medium)区分层级 |
| 行标签「默认权限」 | `#0d0d0d` | 墨色 |
| 行描述 | `#616161` | 次级（`--color-text-secondary`） |
| **导航项「外观」** | `#0d0d0d` | **墨色** —— 导航整列发灰是「设置页看起来浅」的最大成因 |
| 导航分组「个人」 | `#858585` | 弱色（tertiary）；**与项同字号**，只靠颜色退后 |
| 导航标题「设置」 | `#0d0d0d` | 墨色 |
| 卡片填充 | `#ffffff` | 与页面同色 |
| 卡片描边 | `#ececec` 1px | 卡片 x 555→1282 |
| 分隔线 | 从 x 572 画到 1265 | **两侧各内缩 16~17px**，不是通栏 |

结论：卡片**不靠色调分层**，就是白底 + 一圈 1px 描边；分层感来自「墨色文字 + 内缩发丝线」。
（此前有把设置卡写成 `settings-tile` 色调底的版本，那是错的。）

### A.2 排版与尺寸（asar 原文）

- 设置页标题 `heading-xl` = **32px / 38px / 590 / -0.025em**；标题块 `min-height: 60px`。
- 导航标题 18px / 24px / 590。
- 行标签 13px / 510 / 墨色（`text-sm` + `font-medium`），描述 12px / **16px 行高** / 次级，
  两者间距 **2px**（`flex-col gap-0.5`）。
- 行：`px-4 py-3`，文字↔控件 **24px**（`gap-6`）；密集档 `gap-4 py-2`。
- 导航行高 **30px**（浏览器 36）、`px-2`、图标 **14px**、`gap-6px`、圆角 12.5px（`--radius-lg`）；
  选中 = `--color-background-primary-ghost-hover`（浅色 `#0000000d` / 深色 `#ffffff1a`）。
- 导航分组标题：min-height 30px、13px / 510 / tertiary。
- 搜索框：**36px 高、圆角 full、无描边**、底 `--color-background-secondary-soft-alpha`（ink 8~12%）、
  `padding-inline: 12px`、14px 字、占位符 tertiary、图标 secondary。
- 页面栅格：`max-w-3xl`（768px，截图实测内容 ≈730px）+ `px-panel`（20px），
  分组之间 **40px**（`--settings-section-gap: calc(spacing*10)`），紧凑档 22px。
- 页面根节点带 `data-density`（`default|compact|form`），行的类名大量依赖
  `group-data-[density=…]/settings:` 变体。

### A.3 控件

| 控件 | Codex |
|---|---|
| 下拉 | md 档：**32px 高**、gutter 12px、圆角 10px、13px 字；`outline` 变体 = 透明底 + 1px inset 描边；`soft` 变体 = ink alpha 底；箭头是 **11×6 的窄扁 SVG**，不是常规 chevron；hover 只加重描边 |
| 开关 | 轨道 **32×20**，关 = `bg-text/10`，开 = `--color-chart-blue`；滑块 16px 白（`--color-control-thumb-on-accent`），位移 2px → 14px |
| 行内动作按钮 | `settingsAction` = **28px 高**、`px-2`、圆角 12.5px；`color: secondary` = `bg-text/5`、无描边、hover `bg-text/10`、13px |

### A.4 i18n 文案长度（`zh-CN-*.js` 与内联 `defaultMessage`）

Codex 的描述是**一句话**，通常 3~9 词 / 约 30~60 字符，最多两个短句，且**不写「在哪儿点」**：

| 标签 | 描述 |
|---|---|
| 显示预测内容 | 根据对话内容预测你的下一条消息 |
| 减少动态效果 | 减少动画效果或匹配系统设置 |
| 差异标记 | 使用颜色或 +/− 标记显示更改 |
| 默认采用完整视图 | 开始新任务时，在同一标签页栏中显示聊天和内容 |
| 关闭窗口前确认 | 选择何时在关闭窗口前显示警告。仅当设置为"始终"时，按 Alt+F4 或点击关闭按钮才会显示警告。 |

注意最后一条：**危险项允许第二个短句**，但仍是行为描述，不是操作指引。
