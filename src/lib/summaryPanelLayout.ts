/**
 * 摘要面板的档位算法 —— 转写自 Codex app 的 `thread-summary-panel-layout` 模块
 * （`.../webview/assets/thread-summary-panel-layout-*.js`，全文只有三个函数）。
 *
 * Codex 的原逻辑（去混淆后逐字）：
 *
 * ```js
 * function resolveDisplayMode(mainContentWidth, panelWidth = 300) {
 *   const half = (mainContentWidth - 736) / 2;   // 正文两侧各自的空槽
 *   const extra = panelWidth - 300;
 *   if (half < 180 + extra / 2) return 'overlay';
 *   if (half < 400 + extra) return 'shift';
 *   return 'gutter';
 * }
 * function resolveSurface({ displayMode, isPinned, isPopoverOpen }) {
 *   const inline = isPinned && displayMode !== 'overlay';
 *   const visibleSurface = inline ? 'inline'
 *     : displayMode === 'overlay' && isPopoverOpen ? 'popover' : null;
 *   return {
 *     displayMode,
 *     shouldHideInlineImmediately: displayMode === 'overlay' && isPopoverOpen,
 *     shouldShow: inline,
 *     visibleSurface,
 *   };
 * }
 * function contentShift({ displayMode, isPinned, panelWidth = 300 }) {
 *   return isPinned && displayMode === 'shift' ? -(308 + panelWidth - 300) / 2 : 0;
 * }
 * ```
 *
 * 三个档位说的是同一件事的三种强度：**正文两侧的空槽够不够放这块面板**。
 *
 * - `overlay` —— 空槽太窄，面板放弃占位，改为挂在标题栏按钮上的浮层；
 * - `shift` —— 空槽放不下整块面板，面板压住右侧空槽的一部分，正文列相应左移，
 *   于是「正文 + 面板」这一组在新的可用宽度里重新居中；
 * - `gutter` —— 空槽装得下整块面板（还留有余量），面板落在空槽里，正文不动。
 *
 * 阈值里的三个魔数（736 / 180 / 400）都是 Codex 的实测值：736 = 46rem 是 Codex
 * 正文列宽，180 是「至少还得给正文留出这么多呼吸」的底线，400 是「面板落进空槽后
 * 右边还能剩出可读余量」的门槛。CodeMUX 的正文列宽可配（`--content-width`，默认
 * 48rem），所以基准宽度在这里是一个参数，默认值仍取 Codex 的 736。
 */

/** 摘要面板宽度：Codex 的默认值（`yt` 的 `width = 300`）。 */
export const SUMMARY_PANEL_WIDTH = 300;

/** 面板与正文之间的最小间隙：Codex 的 `--spacing * 2`（8px）。 */
export const SUMMARY_PANEL_GAP = 8;

/** 面板浮在对话区里的四周内缩：Codex 的 `--spacing * 5`（20px）。 */
export const SUMMARY_PANEL_EDGE_INSET = 20;

/** Codex 档位阈值所基于的正文列宽（46rem）。 */
export const CODEX_THREAD_CONTENT_WIDTH = 736;

export type SummaryPanelDisplayMode = 'overlay' | 'shift' | 'gutter';
export type SummaryPanelSurface = 'inline' | 'popover' | null;

/**
 * 把 `--content-width` 的取值解析成像素。
 *
 * 认三种写法：
 * - `px` / `rem` —— 定宽档；
 * - `calc(100% - <gutter>)` —— 流式档。**必须传 `availableWidth`**：这个 token
 *   的宽度依赖容器，光看字符串算不出来。
 *
 * 解析不出来时返回 `null`，由调用方决定退化。曾经流式档永远走到这条 `null` 路径：
 * `CONTENT_WIDTHS.stream` 是 `calc(...)`，而解析器只认 `px` / `rem` —— 于是
 * `useSummaryPanelLayout` 回落到「正文铺满对话列」，面板永远停在浮层档。
 * 结论碰巧和按真实宽度算出来的一样（两侧让出的边距远小于 180px 阈值），
 * 但**理由**是错的：改宽流式档的边距时，面板不会跟着响应。
 *
 * `gutter` 支持 `rem` 与 `clamp(<min>, <vw>, <max>)` —— 当前流式档就是后者，
 * 按 `vw` 在给定宽度下的实际取值算，不取上下限，否则宽屏会算窄、窄屏会算宽。
 */
export function parseContentWidthToken(
  token: string,
  rootFontSize = 16,
  availableWidth?: number,
): number | null {
  const value = token.trim();
  const px = /^([\d.]+)px$/.exec(value);
  if (px) return Number.parseFloat(px[1]);
  const rem = /^([\d.]+)rem$/.exec(value);
  if (rem) return Number.parseFloat(rem[1]) * rootFontSize;

  const percent = /^(100%|calc\(100%\s*-\s*(.+)\))$/.exec(value);
  if (percent) {
    if (availableWidth === undefined) return null;
    const gutter = percent[1] === '100%' ? 0 : parseGutter(percent[2], rootFontSize, availableWidth);
    return gutter === null ? null : Math.max(0, availableWidth - gutter);
  }

  return null;
}

/** 解析流式档让出的边距。`clamp()` 按 `vw` 在当前宽度下的实际值算。 */
function parseGutter(raw: string, rootFontSize: number, availableWidth: number): number | null {
  const token = raw.trim();
  const remMatch = /^([\d.]+)rem$/.exec(token);
  if (remMatch) return Number.parseFloat(remMatch[1]) * rootFontSize;

  const pxMatch = /^([\d.]+)px$/.exec(token);
  if (pxMatch) return Number.parseFloat(pxMatch[1]);

  const clampMatch = /^clamp\((.+)\)$/.exec(token);
  if (!clampMatch) return null;
  const parts = clampMatch[1].split(',').map((part) => part.trim());
  if (parts.length !== 3) return null;
  const min = parseGutter(parts[0], rootFontSize, availableWidth);
  const max = parseGutter(parts[2], rootFontSize, availableWidth);
  const vw = /^([\d.]+)vw$/.exec(parts[1]);
  if (min === null || max === null || !vw) return null;
  // 视口宽 ≈ 对话列宽 + 两侧边距；用列宽本身算 vw 会让边距偏大，
  // 但面板档位只关心量级，且列宽通常是视口的绝大部分。
  const preferred = (Number.parseFloat(vw[1]) / 100) * (availableWidth + 2 * min);
  return Math.min(max, Math.max(min, preferred));
}

export interface SummaryPanelSurfaceState {
  displayMode: SummaryPanelDisplayMode;
  /** 内联面板是否可见（只有非 overlay 档、且用户钉住了它才占位）。 */
  shouldShow: boolean;
  /** overlay 档里浮层展开时，内联面要立刻消失（不等退场动画）。 */
  shouldHideInlineImmediately: boolean;
  /** 当前实际呈现出来的那张面。 */
  visibleSurface: SummaryPanelSurface;
}

/**
 * 按可用宽度选档位。
 *
 * @param availableWidth 对话列自身的宽度（Codex 的 `mainContentTargetWidth`）。
 */
export function resolveSummaryPanelDisplayMode(
  availableWidth: number,
  {
    contentWidth = CODEX_THREAD_CONTENT_WIDTH,
    panelWidth = SUMMARY_PANEL_WIDTH,
  }: { contentWidth?: number; panelWidth?: number } = {},
): SummaryPanelDisplayMode {
  // 正文铺满对话列时没有空槽（contentWidth 取到列宽），这里自然退化成 overlay。
  const half = (availableWidth - contentWidth) / 2;
  const extra = panelWidth - SUMMARY_PANEL_WIDTH;
  if (half < 180 + extra / 2) return 'overlay';
  if (half < 400 + extra) return 'shift';
  return 'gutter';
}

export function resolveSummaryPanelSurface({
  displayMode,
  isPinned,
  isPopoverOpen,
}: {
  displayMode: SummaryPanelDisplayMode;
  isPinned: boolean;
  isPopoverOpen: boolean;
}): SummaryPanelSurfaceState {
  const inline = isPinned && displayMode !== 'overlay';
  let visibleSurface: SummaryPanelSurface = null;
  if (inline) visibleSurface = 'inline';
  else if (displayMode === 'overlay' && isPopoverOpen) visibleSurface = 'popover';

  return {
    displayMode,
    shouldHideInlineImmediately: displayMode === 'overlay' && isPopoverOpen,
    shouldShow: inline,
    visibleSurface,
  };
}

/**
 * shift 档下正文列要左移多少（负值，单位 px）—— Codex 的 `contentShift`。
 *
 * 落到渲染上是一个作用在**正文列自己**上的位移（见 `CodeMuxThread` 的
 * `thread-content-shell`：`position: relative` + `left: var(--summary-content-shift)`）。
 *
 * 早先 CodeMUX 把它换算成「给对话列加 `2 * |shift|` 的右侧内边距」表达 —— 正文列
 * `mx-auto` 居中，加内边距后确实左移 `|shift|`，读数没错。但内边距加在对话列上会
 * 把**滚动容器**一起挤窄，滚动条跟着离开窗口最右侧、漂到浮岛左边。位移必须只作用在
 * 正文列上，滚动容器保持满宽，滚动条才留在最右边。
 */
export function resolveSummaryPanelContentShift({
  displayMode,
  isPinned,
  panelWidth = SUMMARY_PANEL_WIDTH,
}: {
  displayMode: SummaryPanelDisplayMode;
  isPinned: boolean;
  panelWidth?: number;
}): number {
  return isPinned && displayMode === 'shift'
    ? -(SUMMARY_PANEL_WIDTH + SUMMARY_PANEL_GAP + panelWidth - SUMMARY_PANEL_WIDTH) / 2
    : 0;
}

export interface SummaryPanelView extends SummaryPanelSurfaceState {
  /** 正文列要左移多少（负值，px）—— 只作用在正文列上，见 `resolveSummaryPanelContentShift`。 */
  contentShift: number;
  /** 面板浮在对话区里时的宽度。 */
  panelWidth: number;
}

/**
 * 把「测量值 + 用户意图」一次算成渲染需要的全部读数。
 *
 * `availableWidth` 为 `null`（尚未测量／没有对话列）时按最窄处理：先给 overlay，
 * 免得面板在首帧闪一下再跳走。
 */
export function resolveSummaryPanelView({
  availableWidth,
  contentWidth = CODEX_THREAD_CONTENT_WIDTH,
  panelWidth = SUMMARY_PANEL_WIDTH,
  isPinned,
  isPopoverOpen,
}: {
  availableWidth: number | null;
  contentWidth?: number;
  panelWidth?: number;
  isPinned: boolean;
  isPopoverOpen: boolean;
}): SummaryPanelView {
  const displayMode = resolveSummaryPanelDisplayMode(
    availableWidth ?? 0,
    { contentWidth, panelWidth },
  );
  const surface = resolveSummaryPanelSurface({ displayMode, isPinned, isPopoverOpen });
  const shift = resolveSummaryPanelContentShift({ displayMode, isPinned, panelWidth });

  return {
    ...surface,
    contentShift: shift,
    panelWidth,
  };
}
