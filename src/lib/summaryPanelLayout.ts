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
 * 只认 `px` / `rem`；`%`（外观设置里的「铺满」档）与无法识别的取值返回 `null`，
 * 由调用方决定退化。铺满档没有侧边空槽，面板只能走浮层 —— 这不是特例分支，
 * 而是把正文列宽取成对话列宽后算法的自然结果。
 */
export function parseContentWidthToken(token: string, rootFontSize = 16): number | null {
  const value = token.trim();
  const px = /^([\d.]+)px$/.exec(value);
  if (px) return Number.parseFloat(px[1]);
  const rem = /^([\d.]+)rem$/.exec(value);
  if (rem) return Number.parseFloat(rem[1]) * rootFontSize;
  return null;
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
