# 10 摘要面板的三种档位

**What to build:** 标题栏的「切换摘要」按钮对齐 Codex app：对话列够宽时，展开的面板钉在**对话列右侧的内联浮岛**上（不占 Flex 排版，正文列让位），而不是永远挂在按钮上的浮层；按钮的语义随宽度在「开浮层 / 钉住」之间切换。档位算法逐字转写 Codex 的 `thread-summary-panel-layout`。

**Blocked by:** 01（颜色/档位派生）

**Status:** done

- [x] `src/lib/summaryPanelLayout.ts`：转写 Codex 的三个函数（档位 / 面 / 让位）+ `--content-width` 解析
- [x] `src/stores/summaryPanelStore.ts`：`{displayMode, isPinned, isPopoverOpen}`，按钮语义随档位切换
- [x] `src/hooks/useSummaryPanelLayout.ts`：ResizeObserver 量对话列，写测量值（档位在 store 里派生）
- [x] `SummaryPanelSurface`：内联浮岛（绝对定位、右对齐、四周内缩 20px、宽 300px）
- [x] `MainLayout`：对话列成为定位上下文；shift 档给右侧留出面板占位（正文列随之左移半个占位宽）
- [x] `GitEnvironmentPopover`：抽出 `SummaryPanelBody` 供两张面共用；按钮按档位改语义与文案
- [x] 就近测试：算法冻结表 21 条 + store 语义 6 条 + 内联面 5 条 + 触发按钮 2 条 + MainLayout 让位 2 条

## Comments

### 反推过程

Codex 的 Electron 壳把 webview 打包在 `app.asar` 里（本机 `C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0\app\resources\app.asar`）。面板逻辑落在三个 chunk 上：

| chunk | 内容 |
|---|---|
| `thread-summary-panel-layout-*.js` | **全部算法**：三个纯函数，共 600 字节 |
| `use-thread-summary-panel-*.js` | 把宽度、钉住、浮层三个状态接成弹簧与档位 |
| `thread-summary-panel-components-*.js` | 面板组件（`Root` / `Content` / `HeaderButton` / `PopoverContent`） |
| `local-conversation-page-*.js` | 标题栏按钮：`displayMode === 'overlay'` 才是 Popover，否则是普通按钮 |

去混淆后就是这三行判断（`half` = 正文两侧各自的空槽）：

```js
const half = (mainContentWidth - 736) / 2;
if (half < 180) return 'overlay';   // 面板放弃占位，挂按钮当浮层
if (half < 400) return 'shift';     // 面板压住右空槽，正文列左移半个占位宽
return 'gutter';                    // 面板落进右空槽，正文不动
```

**按钮语义随档位切换**是这次对齐里最容易漏掉的一条：宽档下它不再是「开/关面板」，而是「钉住/取消钉住」。Codex 的文案也分两套（`Toggle summary` / `Toggle pinned summary`）。

### 与 Codex 的取舍

| | Codex | CodeMUX |
|---|---|---|
| 基准正文宽 | 736（硬编码在算法里，= 46rem） | `--content-width` 实读，默认 48rem=768；铺满档解析不出 → 无空槽 → 恒为浮层 |
| 面板宽 | 300 | 300（浮层与内联面**同宽同源**，跨档不变宽窄；原来浮层是 `w-84`=336） |
| 正文让位 | `contentShift` 弹簧直接位移正文列 | 等价写法：给对话列加 `padding-right`（正文列 `mx-auto`，右侧留出 2 倍位移后自动左移位移值）。少一层 transform，也不影响测量 |
| 档位过渡 | `transition-[padding-right] duration-relaxed` | `transition-[padding-right] duration-slow`（AGENTS.md 的 300ms 上限） |
| 退场动画 | 弹簧 `translateX(100%)` | 只做入场（与 `PreviewPanel` 同惯例）；退场即时卸载 |
| 面板内滚动 / 宽度自适应 / 拖拽改宽 | 浮岛形态无 resizer | 同：浮岛不参与 Flex，无 resizer |

### 一处刻意的行为保留

钉住状态跨档位保留：窗口拉窄到 overlay 档时面板只是**不显示**（按钮回到浮层语义），拉宽后自动回来。这是 Codex 的 `resolveSurface` 的读法（`inline = isPinned && displayMode !== 'overlay'`），不是 bug。

### 目视校验（真的看了一眼，不是推的）

用一张临时的 dev 校验页（`MainLayout` + 真实 store + 真实测量，无 daemon）在三档下量了几何并截图，量完即删。实测数据（正文列 768、面板 300）：

| 视口 | 档位 | 对话列 | 正文列 | 面板 | 结果 |
|---|---|---|---|---|---|
| 1760 | gutter | 57–1759（1702） | 524–1292（居中于 908 = 列中心） | 1451–1751 | 让位 0，两不相犯 |
| 1430 | shift | 57–1429（1372） | 205–973 | 1109–1409 | `padding-right: 308px`；正文左移后**居中于「左边界→面板左沿」**（左 148 / 右 136），不重叠 |
| 1180 | overlay | 57–1179（1122） | 234–1002 | 浮层 812–1112 | 无内联面；按钮 `aria-label` 从「钉住摘要」变「展开摘要」，点击开浮层 |

浮层与内联面**同宽（300）同内容**，跨档切换时面板只挪位置。

**两个只有看图才能发现的问题（都已修）**：

1. 内联卡片被 flex 默认的 `align-items: stretch` 拉满整列高度 —— 摘要只有两三行时下面全空。补 `items-start` 后卡片贴合内容（230px 高）。
2. 首帧量到 0 就永久停在 overlay 档：`useSummaryPanelLayout` 原来只靠「首次 layout effect + ResizeObserver 回调」。dev 下 CSS 由 JS 注入、首帧排版未落定时会量到 0；一旦那个宿主不派发 ResizeObserver（ZCode 内置浏览器实测：连主动改尺寸都不回调），档位就再也不会更新。现在补了**次帧补测**与 **window resize** 两条路径，实测首屏即落到正确档位。

**复现这张校验页**（临时文件，不入库）：根目录放一个 `harness/summary-panel.html`（`<div id="root">` + `<script type="module" src="/harness/main.tsx">`），`harness/main.tsx` 里 `import '../src/styles/globals.css'`，把 `useDaemonConnectionStore.setState({ hostForm: 'desktop' })`、`useSummaryPanelStore.setState({ isPinned: true })` 摆好，再用 `MainLayout`（带 `projectOpenPath` 与几条 `todos`）包一段 `mx-auto max-width: var(--content-width)` 的假正文即可。没有 daemon 时环境信息那段落到「取不到仓库」的兜底文案，不影响几何与档位。

内置浏览器里量几何要注意两件事：它的 ResizeObserver 回调**不投递**、CSS 过渡/入场动画**不推进**（值卡在起点），所以截图前要先 `el.style.transition='none'`，Playwright 的 click 也会因 stability 检查永远不过 —— 用元素中心坐标点。

## 代码评审修复

- `useSummaryPanelLayout` 对 `clientWidth <= 0` 直接返回：既避免 jsdom / 未上屏时多一轮渲染，也避免拉伸窗口中途把档位抖到 overlay。
- 浮层宽度从 `w-84` 改成 store 里的 `panelWidth`（300）：两张面同宽，跨档切换只挪位置。
- 卸载时清测量值（`clearMetrics`）但保留「钉住」：钉住是用户意图，不该跟着对话列卸载一起丢。
