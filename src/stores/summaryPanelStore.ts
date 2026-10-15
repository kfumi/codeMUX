/**
 * 摘要面板（标题栏那个「切换摘要」按钮 + 环境信息/任务/子智能体）的展示状态。
 *
 * 状态形状对着 Codex app 抄：Codex 在这个模块里只存两件事 ——
 * `{ displayMode, isPopoverOpen }`，加上一个「钉住」的布尔；按钮点下去到底是
 * 开浮层还是钉面板，完全由**当前档位**决定：
 *
 * ```js
 * function toggle(store) {
 *   const state = store.get(panelState);
 *   const pinned = isPinned(store);
 *   if (state.displayMode !== 'overlay') { store.set(pinKey, !pinned); return; }
 *   store.set(panelState, { ...state, isPopoverOpen: !state.isPopoverOpen });
 * }
 * ```
 *
 * 也就是说：**宽档下这个按钮是「钉住/取消钉住」，窄档下它才是「开/关浮层」。**
 * 档位由对话列宽度算出来（见 [`summaryPanelLayout`](../lib/summaryPanelLayout.ts)），
 * 不由用户选。这里存测量值而不是算好的档位，是为了让「档位是宽度的函数」这件事
 * 只有一个落点：宽度一变，档位与它派生的所有读数一起跟着变。
 */
import { create } from 'zustand';

import {
  CODEX_THREAD_CONTENT_WIDTH,
  resolveSummaryPanelView,
  SUMMARY_PANEL_WIDTH,
  type SummaryPanelView,
} from '../lib/summaryPanelLayout';

export interface SummaryPanelMetrics {
  /** 对话列宽度；`null` = 还没测到（首帧、当前没有对话列）。 */
  availableWidth: number | null;
  /** 正文列宽（`--content-width` 的解析值）。 */
  contentWidth: number;
}

interface SummaryPanelState extends SummaryPanelMetrics {
  panelWidth: number;
  /** 用户是否把面板钉在对话右侧（Codex 的 `isSummaryPanelPinned`）。 */
  isPinned: boolean;
  /** 窄档浮层是否展开（Codex 的 `isPopoverOpen`）。 */
  isPopoverOpen: boolean;
  setMetrics: (metrics: SummaryPanelMetrics) => void;
  /** 清掉测量值（对话列卸载时用）；用户意图（钉住）不动。 */
  clearMetrics: () => void;
  toggle: () => void;
  setPinned: (pinned: boolean) => void;
  setPopoverOpen: (open: boolean) => void;
  close: () => void;
  reset: () => void;
}

const INITIAL_METRICS: SummaryPanelMetrics = {
  availableWidth: null,
  contentWidth: CODEX_THREAD_CONTENT_WIDTH,
};

export const useSummaryPanelStore = create<SummaryPanelState>((set, get) => ({
  ...INITIAL_METRICS,
  panelWidth: SUMMARY_PANEL_WIDTH,
  isPinned: false,
  isPopoverOpen: false,

  setMetrics: (metrics) => {
    const state = get();
    // ResizeObserver 每次回调都调这里；值没变就整个跳过，免得拖窗口时刷爆订阅者。
    if (state.availableWidth === metrics.availableWidth && state.contentWidth === metrics.contentWidth) {
      return;
    }
    const displayMode = resolveSummaryPanelView({ ...state, ...metrics }).displayMode;
    // 离开 overlay 档时把浮层状态清掉：Codex 的 setDisplayMode 同样是
    // `isPopoverOpen = (next === 'overlay') && isPopoverOpen`，否则从宽档回到
    // 窄档时浮层会自己弹回来。
    set(displayMode === 'overlay' ? metrics : { ...metrics, isPopoverOpen: false });
  },

  toggle: () => set((state) => (
    resolveSummaryPanelView(state).displayMode !== 'overlay'
      ? { isPinned: !state.isPinned }
      : { isPopoverOpen: !state.isPopoverOpen }
  )),

  clearMetrics: () => set({ ...INITIAL_METRICS, isPopoverOpen: false }),

  setPinned: (pinned) => set({ isPinned: pinned }),
  setPopoverOpen: (open) => set({ isPopoverOpen: open }),

  close: () => set({ isPinned: false, isPopoverOpen: false }),

  reset: () => set({ ...INITIAL_METRICS, isPinned: false, isPopoverOpen: false }),
}));

/** 求值状态的渲染读数；store 自身与测试都用它，避免两处各算一遍。 */
export function summaryPanelViewOf(
  state: Pick<SummaryPanelState, 'availableWidth' | 'contentWidth' | 'panelWidth' | 'isPinned' | 'isPopoverOpen'>,
): SummaryPanelView {
  return resolveSummaryPanelView(state);
}
