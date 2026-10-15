import { useLayoutEffect, type RefObject } from 'react';

import { parseContentWidthToken } from '../lib/summaryPanelLayout';
import { useSummaryPanelStore } from '../stores/summaryPanelStore';

function rootFontSize(): number {
  if (typeof window === 'undefined') return 16;
  const value = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(value) && value > 0 ? value : 16;
}

/**
 * 量对话列宽度，写进 [`summaryPanelStore`](../stores/summaryPanelStore.ts)。
 *
 * 只把「宽度」这一个事实送进 store，档位在 store 里派生 —— 于是窗口拉伸、
 * 侧栏拖宽、右侧面板开合，走的都是同一条路径。
 *
 * 正文列宽从对话列上读 `--content-width`（`applyAppearance` 把它写在 `:root`，
 * 这里继承下来即可）。`clientWidth` 含内边距，而 shift 档给对话列加的正是右侧
 * 内边距，所以「加内边距」不会反过来改变测量值，不存在观察者回环。
 *
 * 三条触发路径都留着，是因为**首帧那一拍很可能量不准**（dev 下 CSS 由 JS 注入、
 * 字体与网络资源都会推后一次重排，那一刻量到 0）：次帧补一拍、窗口尺寸变化补一拍、
 * ResizeObserver 管元素自身的后续变化。任何一条单独都够用，但少了它们就可能在
 * 某个宿主里永远停在 overlay 档。
 */
export function useSummaryPanelLayout(paneRef: RefObject<HTMLElement | null>) {
  const setMetrics = useSummaryPanelStore((state) => state.setMetrics);

  useLayoutEffect(() => {
    let measured = false;

    const measure = () => {
      const pane = paneRef.current;
      if (!pane) return;
      const availableWidth = pane.clientWidth;
      // 还没上屏（display:none、测试环境没有排版）时保持现状：把 0 当成真宽度会
      // 平白多一轮渲染，还会在拉伸窗口的中途把档位抖到 overlay。
      if (availableWidth <= 0) return;
      const token = window.getComputedStyle(pane).getPropertyValue('--content-width');
      // 解析不出来（铺满档的 `100%`、变量缺失）就按「正文铺满这一列」算：
      // 没有侧边空槽，面板只能走浮层 —— 算法自己的结论，不是特例分支。
      const contentWidth = parseContentWidthToken(token, rootFontSize()) ?? availableWidth;
      measured = true;
      setMetrics({ availableWidth, contentWidth });
    };

    measure();
    const frame = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);

    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measure);
    observer?.observe(paneRef.current as HTMLElement);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      // 对话列没了就把测量值清掉：留着上一次的宽度会让下次进来先按旧档位渲染一帧，
      // 看着像面板闪了一下。只清测量值 —— 「钉住」是用户的意图，不跟着卸载一起丢。
      if (measured) useSummaryPanelStore.getState().clearMetrics();
    };
  }, [paneRef, setMetrics]);
}
