# 调研：桌面应用 UI 内置 Inter 的 OpenType 特性（font-feature-settings）最佳实践

- 日期：2026-09-18
- 范围：CodeMUX 前端全局样式 `src/styles/globals.css:221` 的 `font-feature-settings: "cv05", "cv08", "tnum", "ss02"` 是否为最佳实践
- 方法：只调研与写文档，不修改任何业务代码。规范/官方文档/公开源码为一手来源；无法取到一手证据的论断显式标注"未验证"。
- 本仓库证据中，标注 **【实测】** 的条目是本次用 fontTools 直接解析 `public/fonts/*.woff2` 与 `node_modules/@fontsource-variable/jetbrains-mono` 实际字体文件得出的第一手结果。

---

## TL;DR（结论先行）

**`font-feature-settings`（低级属性）不是全局启用 OpenType 特性的正确层级；W3C 规范与 MDN 都明确建议优先使用高级属性（`font-variant-*`），原因是高级属性可以独立 cascade、不会整列表继承压制子元素，且能对不支持的字体做合成。** 对 CodeMUX 这种"可切换多款内置字体"（Inter / Geist / Noto Sans SC / LXGW WenKai，`src/lib/appearance.ts:35-40`）的应用，在 `body` 上全局写死 `"cv05", "cv08", "tnum", "ss02"` 有一个被实测证实的硬伤：**`ssXX`/`cvXX` 是 font-specific 的 tag，同一 tag 在不同字体里替换的字形完全不同** —— Inter 的 `ss02` 是"消歧（含斜杠零）"，而 **Geist 的 `ss02` 是把全应用所有小写 `a` 换成替代字形**（【实测】`public/fonts/geist.woff2` GSUB：`a → a.ss02`）。用户把 UI 字体切到 Geist 时，全局 `"ss02"` 会静默改变整个应用的 `a` 字形。

**推荐方案（D，混合细化）：**

1. 删除 `globals.css:221` 整行低级设置；
2. 数字对齐（`tnum`）继续走已有的高级属性 `tabular-nums`（Tailwind 工具类，本仓库已有 30 处局部使用），需要全局兜底时用高级属性 `font-variant-numeric: tabular-nums` 挂在数字容器层，而不是 `body` 低级列表；
3. 斜杠零等消歧需求在 token/ID/序列号等场景**按组件局部**启用 `slashed-zero`（高级属性）或独立工具类；
4. `.font-liga-none`（`globals.css:569-572`）可简化为仅保留高级属性 `font-variant-ligatures: none`（规范语义已覆盖 `liga/calt` 的关闭），并消除其与 body 低级列表"整列表替换"的隐式耦合。

理由细节见下文各节与"候选方案对比"。

---

## 1. CSS 规范层面：低级 vs 高级属性的相互作用与优先级

### 1.1 两者并存时谁赢：低级 `font-feature-settings` 永远最后应用，压制高级属性

CSS Fonts Module Level 4 §7.2 "Feature and variation precedence" 定义了合并顺序，高级与低级分别处于第 10 步和第 13 步（最后一步）：

> 10. Font features implied by the value of the font-variant property, the related font-variant subproperties and any other CSS property that uses OpenType features ... are applied.
> 13. Font features implied by the value of font-feature-settings property are applied.

并明确总结：

> "General property settings override the settings in @font-face rules and **low-level font feature settings override font-variant property settings**."
> "For situations where the combined list of font feature settings contains more than one value for the same feature, **the last value is used**."

来源：CSS Fonts Module Level 4 (W3C Working Draft, 2026-09-13), §7.2 — https://www.w3.org/TR/css-fonts-4/#feature-variation-precedence

MDN 同义表述：`font-feature-settings` "is a low-level feature designed to handle special cases where no other way exists to enable or access an OpenType font feature"，并建议"Whenever possible, Web authors should instead use the font-variant shorthand property or an associated longhand property ... These lead to more effective, predictable, understandable results"。来源：https://developer.mozilla.org/en-US/docs/Web/CSS/Web/CSS/Reference/Properties/font-feature-settings （正式名 https://developer.mozilla.org/en-US/docs/Web/CSS/font-feature-settings ）

### 1.2 低级列表是普通继承属性：父级写死低级列表后，子元素的高级声明会被"同一 tag"压制，且无法用高级属性关掉

`font-feature-settings` 是 inherited 属性（Computed value: as specified）。规范原文（§6.12 属性表）：Inherited: yes。来源：https://www.w3.org/TR/css-fonts-4/#font-feature-settings-prop

因此：在 `body` 声明的 `"cv05", "cv08", "tnum", "ss02"` 会作为**每个子元素自身生效的低级设置**参与其 feature resolution。子元素若声明高级属性（例如 Tailwind 的 `tabular-nums` 即 `font-variant-numeric: tabular-nums`）：

- 与继承下来的低级列表**不冲突**时（如都要求 `tnum=1`）：高级声明冗余，无实害；
- 与低级列表**冲突**时（例如子元素想要 `font-variant-numeric: proportional-nums`，对应 `pnum`，隐含取消 `tnum`）：**低级的 `tnum` 赢**，子元素无法通过高级属性达成目的。唯一的逃生门是子元素自己再声明一个完整的 `font-feature-settings` 列表。

规范给出的官方示例直接演示了这种压制（§7.3 "ex-no-dlig-in-special"）：

> `body { font-feature-settings: "dlig"; }` 且 `span.special { font-variant-ligatures: no-discretionary-ligatures; }` 时，`span.special` 内 dlig 仍然生效："because the font-feature-settings is resolved after that, the 'dlig' value reenables discretionary ligatures."

来源：https://www.w3.org/TR/css-fonts-4/#feature-precedence-examples

这正是"父级低级列表压制子元素高级属性"的规范级确认。对 CodeMUX 的含义：body 上的低级 `"tnum"` 一旦存在，将来任何组件想局部用 `proportional-nums`（比例数字，正文段落有时需要）都会被静默压制。

### 1.3 子元素声明自己的 `font-feature-settings`：整体**替换**继承列表，不是合并

`font-feature-settings` 的继承就是普通 CSS computed-value 继承：子元素一旦自己声明了该属性，其计算值整体覆盖从父级继承的整个列表（MDN 属性表：Inherited: yes; Computed value: as specified；级联语义见 CSS Cascading & Inheritance）。**不会**与父级列表合并。

落到本仓库：`.font-liga-none { font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; }`（`src/styles/globals.css:569-572`）的元素上，body 继承下来的 `"cv05", "cv08", "tnum", "ss02"` **整体失效**（被 `"liga" 0, "calt" 0` 替换）。当前该类只用于地址栏/URL 类元素（JetBrains Mono），功能影响小，但这是一处"全局低级设置 + 局部低级覆盖"的隐式耦合：任何人在 `.font-liga-none` 元素上期望 tnum 都会落空。

另一个细节：规范定义 `font-variant-ligatures: none` 的语义本身就覆盖关闭 common ligatures（liga/clig）、discretionary（dlig）、historical（hlig）与 contextual alternates（**calt**）：

> none: "Specifies that all types of ligatures and contextual forms covered by this property are explicitly disabled."

来源：https://www.w3.org/TR/css-fonts-4/#font-variant-ligatures-prop 。即 `.font-liga-none` 里的高级属性一行已达成目的，低级行是双保险（也顺带把 body 列表替换掉了）。

### 1.4 规范/MDN 对"应该用哪个"的建议原文

规范 §6.12：

> "This property provides low-level control over OpenType font features. It is intended as a way of providing access to font features that are not widely used but are needed for a particular use case. **Authors should *not* use font-feature-settings to set any of the font features in the table below. Instead, please use the higher-level replacement properties**, because: 1. The higher-level properties cascade individually. You can set one without setting the whole font-feature-settings list. 2. Some higher-level properties can be synthesized for fonts that do not support the font feature."

规范映射表中与本调研直接相关的三行：
- Tabular Figures (`tnum`) → `font-variant-numeric: tabular-nums`
- Slashed Zero (`zero`) → `font-variant-numeric: slashed-zero`
- Contextual Alternates (`calt`) → `font-variant-ligatures: contextual`

来源：https://www.w3.org/TR/css-fonts-4/#font-feature-settings-prop

MDN（font-feature-settings 页首）：

> "Whenever possible, Web authors should instead use the font-variant shorthand property or an associated longhand property such as font-variant-ligatures, font-variant-caps, font-variant-east-asian, font-variant-alternates, font-variant-numeric or font-variant-position. These lead to more effective, predictable, understandable results than font-feature-settings..."

来源：https://developer.mozilla.org/en-US/docs/Web/CSS/font-feature-settings

补充：`cv05`/`cv08`/`ss02` 这类字体自定义 alternates，高级通道是 `@font-feature-values` + `font-variant-alternates: styleset(...) / character-variant(...)`（规范 §6.8/§6.9，明确称 stylistic sets 为 "**font specific**"）——它给这些 tag 起了可读名字，但本质仍是字体特定的，换字体即失效/漂移。来源：https://www.w3.org/TR/css-fonts-4/#font-variant-alternates-prop 、https://www.w3.org/TR/css-fonts-4/#font-feature-values

### 1.5 默认开启的特性（与 `calt` 相关）

规范 §7.1：浏览器必须默认开启 `rlig, liga, clig, calt, locl, ccmp, mark, mkmk`——"These features must always be enabled, even when the value of the font-variant and font-feature-settings properties is normal"。来源：https://www.w3.org/TR/css-fonts-4/#default-features 。即现代浏览器里 `calt`/`liga` 默认就是开的，除非显式关闭。

---

## 2. Inter 官方立场

### 2.1 官方特性命名（rsms.me/inter "Listing of all features"）

Inter 官网完整特性清单（一手，rsms.me/inter 页面 "Listing of all features" 区块；镜像缓存自 2026-09-18 抓取）：

- `calt` Contextual Alternates（官网另有交互示例标注 "**Enabled by default**"）
- `cv01` Alternate one / `cv02` Open four / `cv03` Open six / `cv04` Open nine / **`cv05` Lower-case L with tail** / `cv06` Simplified u / `cv07` Alternate German double s / **`cv08` Upper-case i with serif** / `cv09` Flat-top three / `cv10` Capital G with spur / `cv11` Single-story a / `cv12` Compact f / `cv13` Compact t
- `ss01` **Open digits**（页面示例区又称 "Alternate digits"）
- `ss02` **Disambiguation (with zero)**（示例区描述："Alternate glyph set that increases visual difference between similar-looking characters"；应用示例 "Disambiguate between similar-looking characters with ss02 or individual character variants: ss02 Disambiguation, or cv08 Upper-case i with serif, cv05 Lower-case L with tail, zero Slashed zero"）
- `ss03` Round quotes & commas
- `ss04` **Disambiguation (no zero)**
- `ss05` Circled characters / `ss06` Squared characters / `ss07` Square punctuation / `ss08` Square quotes
- `tnum` Tabular Figures（"Fixed-width numbers are useful for tabular data, where comparing columns across rows is desired."）
- `zero` Slashed Zero

来源：https://rsms.me/inter/ （Features / Listing of all sections）

**ss02 与 ss04 的区别（字体源码级，一手）**：`v4.0` 标签下 `src/features/ss02-disambiguation.fea`（featureNames "Disambiguation"）替换 `l→l.ss02`（小写 l 带尾）、`germandbls`、`I→I.1`（大写 I 带衬线），并且**包含 `sub zero by zero.slash;`（斜杠零）**；`src/features/ss04-disambiguation.fea`（featureNames "Disambiguation (no slashed zero)"）替换集合与 ss02 完全一致，唯独没有 zero 替换。文件内注释 "All by zero should be synchronized with ss04" 确认了两者除零以外同构。

来源：https://github.com/rsms/inter/blob/v4.0/src/features/ss02-disambiguation.fea 、https://github.com/rsms/inter/blob/v4.0/src/features/ss04-disambiguation.fea

### 2.2 ss04 的引入版本：不是 4.0，至少 v3.19（2021-06）就存在

Inter 4.0 官方 release notes 只写了 "Several new OpenType features"，未点名 ss04。一手核验：`v3.19` 标签的 `src/features/` 目录里已存在 `ss04-disambiguation.fea`，且其 `ss02-disambiguation.fea` 同样包含 `zero → zero.slash`。v3.19 发布于 2021-06-18（GitHub API `published_at`）。

来源：
- https://api.github.com/repos/rsms/inter/contents/src/features?ref=v3.19 （目录列表，含 `ss04-disambiguation.fea`）
- https://github.com/rsms/inter/releases/tag/v4.0 （"Several new OpenType features"）
- https://github.com/rsms/inter/releases/tag/v3.19 （published 2021-06-18）

（未验证：ss04 最早引入的更早具体版本号；结论按证据保守表述为"至少自 v3.19 起存在"。另注意 4.0 对 ss03 的语义做过变更——v3.19 的 ss03 源文件名为 `ss03-r-curve.fea`，4.x 官网清单里 ss03 已是 "Round quotes & commas"，再次说明 ssXX 语义在版本间也可能漂移。）

### 2.3 官方对 UI 启用哪些特性的态度：全局只兜底 `liga`/`calt`，stylistic 特性留给按需开启

Inter 官方 web 发行 CSS 的全部 `font-feature-settings` 只有一行：

```css
:root {
  font-family: Inter, sans-serif;
  font-feature-settings: 'liga' 1, 'calt' 1; /* fix for Chrome */
}
```

来源：https://rsms.me/inter/inter.css （官网 Usage 区块原样给出；页面缓存确认）。即官方对"全局"的处理仅是把默认连字/上下文替换显式钉住（历史 Chrome 兼容修复），**从不全局开启 ss02/tnum/cv05/cv08**。Inter README 对 `zero` 的定位也是按需工具："slashed zero for when you need to disambiguate '0' from 'o'"。来源：https://github.com/rsms/inter （README）

（注：规范 §7.1 已要求现代浏览器默认开启 liga/calt，见 §1.5；官方这行属于历史兼容层，不是"必须模仿"的配置。）

---

## 3. 业界实践对照

| 产品/系统 | 全局 font-feature-settings？ | 数字特性做法 | 证据强度与来源 |
| --- | --- | --- | --- |
| **Ant Design (antd 4.x)** | **是——唯一找到的知名全局案例，但只有 `tnum`**，绝无 ss02/cvXX：`body { font-feature-settings: @font-feature-settings-base; }`，变量定义为 `@font-feature-settings-base: 'tnum';`，并且同时设了高级属性 `font-variant: @font-variant-base;`（`= tabular-nums`）双保险 | 全局 tabular（tnum），组件层不再另设 | 一手（GitHub 源码）：components/style/core/global.less 与 components/style/themes/default.less @ 4.24.16，https://github.com/ant-design/ant-design/blob/4.24.16/components/style/core/global.less |
| **Tailwind CSS v4** | **否**。Preflight 对 html 的默认是 `font-feature-settings: --theme(--default-font-feature-settings, normal)`，即默认 `normal`（无特性），仅允许项目作者经 theme 变量自定义；表单控件显式 `font-feature-settings: inherit` | 提供的是**按元素的工具类**：`tabular-nums` / `slashed-zero` / `proportional-nums` / `normal-nums`（= `font-variant-numeric` 各值），文档示例全是局部 `<p class="slashed-zero tabular-nums">` 用法 | 一手：packages/tailwindcss/preflight.css（GitHub main）；https://tailwindcss.com/docs/font-variant-numeric |
| **shadcn/ui** | **否**。官方 Theming 文档给出的完整默认主题 CSS（`@theme inline` + `:root` + `.dark` + `@layer base` 的 body）里没有任何 font-feature-settings | 无内置数字特性；用户按需用 Tailwind 的 `tabular-nums` 等工具类 | 一手（官方文档全文）：https://ui.shadcn.com/docs/theming （"Default Theme CSS" 区块全文核验无该属性） |
| **VS Code** | **否**（工作台 UI 无全局设置）。编辑器画布的 `editor.fontLigatures` **默认 `false`**（实现为 font-feature-settings `"liga" off, "calt" off`），接受字符串值作为 "Explicit 'font-feature-settings' CSS property" 供用户自定义 | 等宽编辑器本身无数字错位问题；特性开放给用户按需配置 | 一手（源码）：src/vs/editor/common/config/editorOptions.ts（`EditorFontLigatures`，default: false，OFF = '"liga" off, "calt" off'），https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/config/editorOptions.ts |
| **Figma** | 编辑器为设计工具（非本调研对象产品形态），但可参考其交互模型：**OpenType 特性（含 Slashed Zero、Monospace/Tabular figures、Inter 的 stylistic sets、character variants）全部是 Type settings 面板里按选中对象的 opt-in 开关**，没有任何全局默认 | "Use slashed zero to display the zero integer with a slash through it. This is another way to distinguish it from the letter O."；Style 提供 Proportional/Monospace figures 选项 | 一手（官方帮助文档）：https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties （"Figma supports OpenType features across all fonts"） |
| **Vercel Geist（字体）** | 字体仓库 README 无任何"推荐全局启用哪些 OpenType 特性"的内容（全文无 feature/tnum/zero 建议性文字） | — | 一手：https://github.com/vercel/geist-font （readme.md 全文核验）。（Vercel 站点运行时 CSS 未取证，标注未验证） |
| **Linear** | **未验证**（其生产站 CSS 无法在本环境取得一手证据；公开渠道未见到"全局 body 级 ss02/tnum"的可引用证据，传闻其重度使用 Inter 但配置不可考） | — | 未验证，按传闻处理 |
| **GitHub Primer / Microsoft Fluent UI** | **未验证**（本环境未能取得其一手样式源码；未发现公开的"全局数字特性"文档化声明） | — | 未验证 |
| **PI-Desktop（本机对照项目）** | **否**。`apps/desktop/src/styles/` 全部 CSS/TSX 中 **0 处** `font-feature-settings`；数字对齐全部用局部高级属性 `font-variant-numeric: tabular-nums`（39 处，分布于 messages/projects/settings/plugins/model-config/providers 等），另有 1 处局部 `font-variant-ligatures: none`（prose.css:310） | 数字组件局部 `tabular-nums` | 一手（本机源码 grep）：`D:\project\my-project\PI-Desktop\apps\desktop\src\styles\*.css`；字体注册 `fonts.css:17`（Inter） |

**综合结论**：没有找到任何知名产品在 body 级全局开启 `ss02`（或任何 ssXX/cvXX）的公开案例。全局化 `tnum` 的案例只有 antd（且仅 tnum、并同时声明高级属性）。主流生态（Tailwind、shadcn、Figma、PI-Desktop）的一致哲学是：**数字/消歧特性按元素局部 opt-in**。

---

## 4. 排版 / UX 层面：斜杠零（slashed zero / ss02）的利弊

**支持局部启用的论点：**

- **0/O 消歧**在 token、API key、ID、序列号、验证码、hex/base32 串等场景有真实价值——这些正是 Inter 官方对 `zero`/`ss02` 的定位（"when you need to disambiguate '0' from 'o'"，Inter README；Figma 帮助文档同义）。Inter 官网的应用示例也是面向 "Illusion A03" 这类编码串而非整篇 UI 文案。
- **表格数字**（计时器、统计、用量、行号）需要 `tnum` 防抖动——这是 `tabular-nums` 的经典适用面（Inter 官网：useful for tabular data; Figma: Monospace figures）。

**反对全局默认启用的论点：**

- **与平台默认字形体验不一致**：Windows 默认 UI 字体 Segoe UI 与 Apple SF Pro 的默认 `0` 都是光椭圆（无斜杠）；系统对话框、浏览器原生 UI、其它应用一律无斜杠零，CodeMUX 里全局换成斜杠零会显得"字体被改过"。用户困惑成本：数字 0 是 UI 中出现频率极高的字符，非预期变形容易被感知为渲染 bug。（平台默认形态为可观察事实；SF/Segoe 将 `zero`/Slashed Zero 列为可选 OpenType 特性而非默认形态——Microsoft Typography 字体页 https://learn.microsoft.com/en-us/typography/font-list/segoe-ui 提供字体清单，特性级"可选"表述基于 OpenType 规范对 `zero` 的定位，属合理推断。）
- **正文观感**：斜杠在长文本、金额、百分比里增加视觉噪声；斜杠零与北欧字母 `Ø`、空集符号 `∅` 在小字号下存在误读可能（经验性论断，未引用权威文献）。
- **CJK 场景**：本应用正文大量中文（Noto Sans SC / LXGW WenKai fallback），西文数字特性对这些字体无效（见 §5 实测），"全局开启"实际只作用于拉丁数字，进一步削弱了"全局统一观感"的动机。
- **可移植性**：`ssXX`/`cvXX` 是 font-specific 的（规范 §6.8 原文标注 "font specific"），含义随字体漂移；`zero`/`tnum` 这类语义化 tag 才是跨字体安全的。全局挂 `ss02` 的产品等于把 UI 外观绑死在"某个特定字体的某个特性版本"上（Inter 3.x→4.x 就变更过 ss03 的语义，见 §2.2）。

---

## 5. 本仓库落点（只读代码 + 实测，未修改）

### 5.1 现状

- `src/styles/globals.css:221`：`body { font-feature-settings: "cv05", "cv08", "tnum", "ss02"; }` ——低级属性，inherited，作用于全文档所有元素。
- `src/styles/globals.css:569-572`：`.font-liga-none { font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; }`（地址栏等 URL 场景禁用 JetBrains Mono 连字）。
- `tabular-nums`（高级属性工具类）局部使用 **30 处**，集中在数字密集组件：`UsageStatistics.tsx`（统计卡/表格）、`UsageBarChart.tsx`（用量）、`ThemeToggle.tsx`（数值 output）、`CodeMuxMessageParts.tsx`（token/时长）、`assistantCollapse.tsx`（durationMs）、`context-display.tsx`（上下文计数）、`message-footer.tsx`（时间戳）、`GitEnvironmentPopover.tsx`（完成度 x/y）、`ToolCallCard.tsx`、`AskUserQuestionCard.tsx`、`QueuedMessages.tsx`、`SessionItem.tsx`、`DiffView.tsx`/`FileView.tsx`（行号）、`reasoning.tsx`。
- 外观系统允许切换内置字体：`Geist / Inter / Noto Sans SC / LXGW WenKai`（`src/lib/appearance.ts:35-40`，@font-face 见 `src/styles/fonts.css`；`--font-ui` 写入见 `appearance.ts:167`）。默认 `uiFontFamily: ''`（`appearance.ts:70`），即默认走系统字体栈，四个特性此时多为 no-op——**当前全局规则只在用户手动选择 Inter 时"完全生效"**。

### 5.2 【实测】内置字体的 GSUB 特性表（fontTools 解析实际打包的 woff2）

| 字体文件 | 目标 tag 有无（tnum / ss01 / ss02 / ss03 / ss04 / cv05 / cv08 / zero / calt / liga） |
| --- | --- |
| `public/fonts/inter.woff2` | 全部有：`calt, cv05, cv08, ss01, ss02, ss03, ss04, tnum, zero`（39 个 feature tag） |
| `public/fonts/geist.woff2` | `liga, ss01, ss02, ss03, ss04, tnum` —— **无 cv05 / cv08 / zero**（26 个 tag） |
| `public/fonts/noto-sans-sc.woff2` | 仅 `liga`（12 个 tag） |
| `public/fonts/lxgw-wenkai.woff2` | 仅 `calt`（9 个 tag） |
| `node_modules/@fontsource-variable/jetbrains-mono/.../latin-wght-normal.woff2`（代码字体，code/pre 继承 body 设置） | `calt, ccmp, frac, locl` —— **无 tnum / ss02 / cv05 / cv08** |

### 5.3 冲突点与风险（按严重度排序）

1. **【实测，真实缺陷】Geist 下 `ss02` 语义漂移**：Geist 的 `ss02` 是小写 `a` 系列替代字形（`a → a.ss02`，连同 aacute/acircumflex/agrave/... 全族；ss01 亦为 a 系、ss04 为 R 系替代字形）。用户把 UI 字体切成 Geist 后，全局 `"ss02"` 会把**整个应用所有小写 a** 换成 Geist 的替代设计——没有任何提示，也不是任何人期望的效果。这是"全局 font-specific stylistic set + 多字体可切换"结构下的必然产物。
2. **规范级压制**：body 低级列表让 `tnum` 成为每个元素的低级设置（§1.2）。现有 30 处 `tabular-nums` 目前与它重复（无实害），但未来任何组件想用 `proportional-nums`（或 `font-variant-numeric: normal`）做正文比例数字，都会被继承下来的低级 `tnum` 静默压制，只能再写一整条 `font-feature-settings` 逃生。
3. **`.font-liga-none` 的整列表替换**（§1.3）：该类元素上 body 的 cv05/cv08/tnum/ss02 全部失效。当前场景（URL/地址栏、代码字体）影响可忽略，但它是"全局低级设置"耦合的实例：设置项越多的全局列表，局部覆盖时丢掉的也越多。
4. **泄漏给 fallback/代码字体**（【实测】结论：当前无实害）：`tnum/ss02/cv05/cv08` 传给 Noto Sans SC / LXGW WenKai / JetBrains Mono 时均为 no-op（它们没有这些 tag），所以中文字形不受影响；但这依赖"今天这些字体恰好没有同名 tag"这一事实，属于脆弱的偶然安全。
5. **`cv05`/`cv08` 只对 Inter 存在**：Geist 无此二 tag（【实测】），选 Geist 时这两个设置静默失效；选默认系统栈时四个全部失效。也就是说这条全局行的实际语义是"仅当 UI 字体 = Inter 时生效"，但它写在 `body` 上，读代码的人很容易误以为是全字体一致的基线。

### 5.4 PI-Desktop 对照结论

PI-Desktop（同样内置 Inter）证明了替代路径可行且更惯用：**零全局 font-feature-settings**，数字密集处一律局部 `font-variant-numeric: tabular-nums`（39 处），需要禁连字处局部 `font-variant-ligatures: none`（prose.css:310）。其 0 保持 Inter 默认光椭圆。这与 Tailwind 工具类设计、shadcn 默认主题、Figma 交互模型、VS Code 默认值的方向完全一致。

---

## 6. 候选方案对比

| 方案 | 内容 | 优点 | 缺点 | 评价 |
| --- | --- | --- | --- | --- |
| **A. 整行删除** `globals.css:221` | body 不做任何字体特性设置，全部依赖既有 30 处局部 `tabular-nums` | 完全符合规范建议与业界主流；消除 Geist `a` 变形、压制、替换耦合三类问题；0 回归默认观感 | 若存在"没被 `tabular-nums` 覆盖的数字"将失去全局对齐兜底（现状下该兜底只对 Inter 生效，收益本来就近零） | ✅ 最干净；风险极低 |
| **B. 只留 `tnum`**（仍用低级） | `font-feature-settings: "tnum";` | 保留全局数字对齐；去掉字体特定 ss/cv | 仍是低级属性：继续压制子元素高级 `proportional-nums`；与 30 处 `tabular-nums` 长期双轨冗余；antd 是唯一先例且其同时声明高级属性 | ⚠️ 可用但非最佳层级 |
| **C. `ss02` → `ss04`** | 保留其余，ss02 换成不含斜杠零的 ss04 | 0 回默认观感，保留 l 带尾/I 衬线消歧 | **没解决任何结构性问题**：cv05/cv08/ss04 依旧 font-specific，Geist 下 `ss04` 会替换 R 系字形（【实测】`R → R.ss04`），比 ss02 的 a 变形更隐蔽；且 Inter 语义会随版本漂移 | ❌ 治标且引入新隐患 |
| **D. 改用高级属性 + 按组件局部启用**（推荐） | 删除 body 低级行；数字对齐用既有 `tabular-nums`（必要时在少数数字容器补高级 `font-variant-numeric: tabular-nums`）；token/ID 场景局部加 `slashed-zero`；`.font-liga-none` 简化为仅高级 `font-variant-ligatures: none` | 与规范/MDN 建议一致；高级属性可独立 cascade、互不整列表压制、可被子元素正常覆盖；对不支持字体可合成（规范 §6.12 理由 2）；多字体安全（语义 tag 跨字体） | 需要审计是否有遗漏的数字热点（一次性成本，量小）；"全局 0 对齐兜底"没有的话需接受个别数字列轻微抖动 | ✅ 最佳 |
| **E. 维持现状** | 不动 | 无迁移成本 | Geist 下全应用 `a` 变形的实际缺陷保留；规范反模式保留；未来 `proportional-nums` 需求被锁死；`.font-liga-none` 隐式耦合保留 | ❌ 不建议 |
| **F.（补充）高级属性全局兜底** | body 用 `font-variant-numeric: tabular-nums;`（高级）替代低级 tnum，其余删除 | 保留全局数字对齐且属高级层级：子元素可用自己的 `font-variant-numeric` 正常覆盖（高级属性之间按级联解决，不再被低级列表压制） | 仍是全局强制（继承到所有元素与代码字体；后者无 tnum，无实害）；不如 D 聚焦，但比 B 正确 | ✅ 作为 D 的可选折中（若坚持要全局兜底，用这个形态） |

---

## 7. 最佳方案推荐及理由

**推荐 D（删除 `globals.css:221` 低级列表；数字特性用高级属性局部启用；若要全局兜底则用 F 的高级形态）。**

1. **层级正确**：规范明文 "Authors should not use font-feature-settings to set ... Tabular Figures (tnum) ... Slashed Zero (zero)"，MDN 同义且更直接（§1.4）。`tnum`/`zero` 都有高级对应物，用低级属性属反模式。
2. **消除已实测存在的缺陷**：Geist `ss02` = 全应用小写 a 变形（§5.3-1）。这是当前代码里真实存在的、用户切换字体即可触发的字形漂移；任何保留全局 ss02 的方案（含 C：Geist `ss04` 替换 R 系）都无法消除。
3. **恢复级联自由度**：去掉低级继承压制后，30 处既有 `tabular-nums` 语义不变，未来 `proportional-nums`/`normal-nums` 可正常工作（§1.2）；`.font-liga-none` 不再隐式丢设置（§1.3）。
4. **与生态一致**：Tailwind v4 默认 `normal` + 工具类、shadcn 默认主题无全局设置、Figma 全部 opt-in、VS Code 默认关、PI-Desktop 全局部、Inter 官方 CSS 全局只兜底 liga/calt（§2.3/§3）。唯一的反例 antd 也只全局 `tnum` 且并用了高级属性（§3）。
5. **收益成本比**：现状的全局兜底只对"UI 字体 = Inter"生效（默认系统栈与其余字体下多为 no-op，§5.1/§5.2），删行的视觉回归面极小；数字对齐需求已被 30 处局部类覆盖，补漏属一次性小审计。

**落地清单（供后续实施参考，本文档不执行）：**
- 删除 `src/styles/globals.css:221`；
- 若需全局数字兜底，在 body 或数字容器层用 `font-variant-numeric: tabular-nums;`（方案 F 形态）；
- token/ID/序列号展示组件按需加 `slashed-zero`（可与 `tabular-nums` 组合，参考 Tailwind 文档的组合用法）；
- `.font-liga-none` 收敛为 `font-variant-ligatures: none;`（如需兼容旧渲染环境可暂留低级行，但注意它会替换任何未来的全局低级列表）；
- 实施后回归点：Usage 统计页、会话列表时间戳、DiffView 行号、ThemeToggle 数值、地址栏（`.font-liga-none`）在 Inter / Geist / 系统字体三种选择下的渲染。

---

## 8. 参考来源

**规范与 MDN（一手）**
1. CSS Fonts Module Level 4, W3C Working Draft 2026-09-13 — §6.12 font-feature-settings（含"应用高级替换属性"的映射表与理由）：https://www.w3.org/TR/css-fonts-4/#font-feature-settings-prop
2. 同上 — §7.1 Default features（liga/calt 等默认开启）：https://www.w3.org/TR/css-fonts-4/#default-features
3. 同上 — §7.2 Feature and variation precedence（第 10/13 步顺序与"low-level overrides font-variant"原句）：https://www.w3.org/TR/css-fonts-4/#feature-variation-precedence
4. 同上 — §7.3 Feature precedence examples（body 低级压制 span 高级的官方示例）：https://www.w3.org/TR/css-fonts-4/#feature-precedence-examples
5. 同上 — §6.4 font-variant-ligatures（`none` 语义覆盖 calt）：https://www.w3.org/TR/css-fonts-4/#font-variant-ligatures-prop ；§6.7 font-variant-numeric（slashed-zero = OpenType `zero`）：https://www.w3.org/TR/css-fonts-4/#font-variant-numeric-prop ；§6.8 font-variant-alternates（styleset/character-variant 标注 "font specific"）：https://www.w3.org/TR/css-fonts-4/#font-variant-alternates-prop
6. MDN font-feature-settings（"should instead use font-variant..." 原文；Inherited: yes）：https://developer.mozilla.org/en-US/docs/Web/CSS/font-feature-settings

**Inter 官方（一手）**
7. Inter 官网特性文档（calt 默认开启示例、ss01–ss08 / cv01–cv13 / tnum / zero 命名与用法示例、"Listing of all features"）：https://rsms.me/inter/
8. Inter 官方 web CSS（全局仅 `'liga' 1, 'calt' 1; /* fix for Chrome */`）：https://rsms.me/inter/inter.css
9. Inter v4.0 源码 — ss02/ss04 差异（`sub zero by zero.slash` 仅在 ss02）：https://github.com/rsms/inter/blob/v4.0/src/features/ss02-disambiguation.fea 、https://github.com/rsms/inter/blob/v4.0/src/features/ss04-disambiguation.fea
10. Inter v3.19 特性目录（ss04 已存在；ss03 为 r-curve）与发布时间：https://api.github.com/repos/rsms/inter/contents/src/features?ref=v3.19 、https://github.com/rsms/inter/releases/tag/v3.19
11. Inter v4.0 release notes（"Several new OpenType features"，未点名 ss04）：https://github.com/rsms/inter/releases/tag/v4.0
12. Inter README（"slashed zero for when you need to disambiguate '0' from 'o'"）：https://github.com/rsms/inter

**业界实践（一手）**
13. Ant Design 4.24.16 — 全局 `font-feature-settings: @font-feature-settings-base`（body）与 `@font-variant-base: tabular-nums; @font-feature-settings-base: 'tnum';`：https://github.com/ant-design/ant-design/blob/4.24.16/components/style/core/global.less 、https://github.com/ant-design/ant-design/blob/4.24.16/components/style/themes/default.less
14. Tailwind CSS v4 Preflight（`--default-font-feature-settings, normal`；表单控件 inherit）：https://github.com/tailwindlabs/tailwindcss/blob/main/packages/tailwindcss/preflight.css ；font-variant-numeric 工具类文档（tabular-nums / slashed-zero / normal-nums 局部用法）：https://tailwindcss.com/docs/font-variant-numeric
15. shadcn/ui Theming — 完整默认主题 CSS 无 font-feature-settings：https://ui.shadcn.com/docs/theming
16. VS Code 源码 — `EditorFontLigatures`（default false；字符串值 = "Explicit 'font-feature-settings' CSS property"）：https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/config/editorOptions.ts
17. Figma 帮助中心 — OpenType features（Slashed Zero、Monospace/Proportional figures、Inter stylistic sets）为 Type settings 内 per-selection opt-in：https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties
18. Vercel Geist 字体仓库 README（无特性启用建议）：https://github.com/vercel/geist-font
19. Microsoft Typography — Segoe UI 字体页（平台默认 UI 字体背景）：https://learn.microsoft.com/en-us/typography/font-list/segoe-ui

**本仓库 / 本机（一手，只读）**
20. `src/styles/globals.css:221`（body 低级列表）、`globals.css:569-572`（`.font-liga-none`）、`src/styles/fonts.css`（内置 @font-face）、`src/lib/appearance.ts:35-40,70,104,167`（可切换字体与 `--font-ui`）
21. 本仓库 `tabular-nums` 用法 30 处（grep 汇总）：UsageStatistics.tsx / UsageBarChart.tsx / ThemeToggle.tsx / CodeMuxMessageParts.tsx / assistantCollapse.tsx / context-display.tsx / message-footer.tsx / GitEnvironmentPopover.tsx / ToolCallCard.tsx / AskUserQuestionCard.tsx / QueuedMessages.tsx / SessionItem.tsx / DiffView.tsx / FileView.tsx / reasoning.tsx
22. 【实测】fontTools 解析：`public/fonts/inter.woff2`、`public/fonts/geist.woff2`（ss02 = a→a.ss02 全 a 族；ss04 = R→R.ss04；无 cv05/cv08/zero）、`public/fonts/noto-sans-sc.woff2`、`public/fonts/lxgw-wenkai.woff2`、`node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2`（2026-09-18）
23. PI-Desktop（对照）：`D:\project\my-project\PI-Desktop\apps\desktop\src\styles\`（无全局 font-feature-settings；`font-variant-numeric: tabular-nums` 39 处；`prose.css:310` 局部禁连字；`fonts.css:17` 注册 Inter）

**未验证 / 传闻（明确降级）**
24. Linear 生产站 CSS 的字体特性配置 — 未取得一手证据，不可考
25. GitHub Primer、Microsoft Fluent UI 是否存在全局数字特性设置 — 未取得一手证据
26. Vercel 线上站点运行时 CSS — 仅核验了字体仓库 README，站点本身未取证
