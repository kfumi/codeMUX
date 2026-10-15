import { useMemo } from 'react';

import { summaryPanelViewOf, useSummaryPanelStore } from '../../../stores/summaryPanelStore';
import type { TodoItem } from '../../../types/agent';
import { SummaryPanelBody } from './GitEnvironmentPopover';

/**
 * 摘要面板的**内联面**：宽档下钉在对话右侧的那块浮岛。
 *
 * 位置与几何对着 Codex 抄（`thread-summary-panel-components` 的 `yt` 组件，
 * `placement='floating'` 分支）：面板是绝对定位浮在对话区里的，四周内缩
 * 20px（Codex 的 `--spacing * 5`），宽度 300px 起；正文列的让位由对话列自己的
 * 右内边距完成（见 `MainLayout` 与
 * [`summaryPanelLayout`](../../../lib/summaryPanelLayout.ts) 的 `paneReserve`），
 * 面板本身不参与 Flex 排版 —— 这就是 Codex 里「面板浮在对话上、正文挪开」的读法。
 *
 * 窄档（`overlay`）不渲染这张面：那时面板挂在标题栏按钮上，是
 * `GitEnvironmentPopover` 里的 Popover 负责的另一张面。
 */
export function SummaryPanelSurface({
  projectPath,
  todos = [],
}: {
  projectPath: string | null | undefined;
  todos?: TodoItem[];
}) {
  const availableWidth = useSummaryPanelStore((state) => state.availableWidth);
  const contentWidth = useSummaryPanelStore((state) => state.contentWidth);
  const panelWidth = useSummaryPanelStore((state) => state.panelWidth);
  const isPinned = useSummaryPanelStore((state) => state.isPinned);
  const isPopoverOpen = useSummaryPanelStore((state) => state.isPopoverOpen);

  const view = useMemo(
    () => summaryPanelViewOf({ availableWidth, contentWidth, panelWidth, isPinned, isPopoverOpen }),
    [availableWidth, contentWidth, panelWidth, isPinned, isPopoverOpen],
  );

  if (!projectPath || !view.shouldShow) return null;

  return (
    <div
      data-testid="summary-panel-surface"
      // inset-y-5 / right-5 = 20px，与码里的 SUMMARY_PANEL_EDGE_INSET 同值。
      // items-start 是必需的：不加的话 flex 默认 stretch，卡片会被拉满整列高度，
      // 摘要只有两三行时下面全是空的；Codex 的浮岛是**贴合内容**的。
      className="pointer-events-none absolute inset-y-5 right-5 z-30 flex max-w-[calc(100%-2.5rem)] items-start justify-end"
      style={{ width: view.panelWidth }}
    >
      <div className="pointer-events-auto flex w-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-popover/98 p-1.5 shadow-elevation animate-in fade-in slide-in-from-right-3 fill-mode-both duration-slow ease-motion-out">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SummaryPanelBody projectPath={projectPath} todos={todos} />
        </div>
      </div>
    </div>
  );
}
