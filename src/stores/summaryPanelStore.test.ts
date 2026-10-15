import { beforeEach, describe, expect, it } from 'vitest';

import { summaryPanelViewOf, useSummaryPanelStore } from './summaryPanelStore';

const store = () => useSummaryPanelStore.getState();
const view = () => summaryPanelViewOf(useSummaryPanelStore.getState());

describe('summaryPanelStore', () => {
  beforeEach(() => {
    useSummaryPanelStore.getState().reset();
  });

  it('窄档下按钮开合浮层', () => {
    store().setMetrics({ availableWidth: 900, contentWidth: 768 });
    expect(view().displayMode).toBe('overlay');

    store().toggle();
    expect(store().isPopoverOpen).toBe(true);
    expect(view().visibleSurface).toBe('popover');

    store().toggle();
    expect(store().isPopoverOpen).toBe(false);
    expect(view().visibleSurface).toBeNull();
  });

  it('宽档下按钮变成「钉住/取消钉住」，且不碰浮层状态', () => {
    store().setMetrics({ availableWidth: 1600, contentWidth: 768 });
    expect(view().displayMode).toBe('gutter');

    store().toggle();
    expect(store().isPinned).toBe(true);
    expect(store().isPopoverOpen).toBe(false);
    expect(view().visibleSurface).toBe('inline');

    store().toggle();
    expect(store().isPinned).toBe(false);
    expect(view().shouldShow).toBe(false);
  });

  it('离开 overlay 档时清掉浮层：宽窄来回切不会让浮层自己弹回来', () => {
    store().setMetrics({ availableWidth: 900, contentWidth: 768 });
    store().toggle();
    expect(store().isPopoverOpen).toBe(true);

    store().setMetrics({ availableWidth: 1600, contentWidth: 768 });
    expect(store().isPopoverOpen).toBe(false);

    store().setMetrics({ availableWidth: 900, contentWidth: 768 });
    expect(store().isPopoverOpen).toBe(false);
  });

  it('钉住状态跨档位保留：拉窄时面板只是不显示，拉宽回到宽档它自己回来', () => {
    store().setMetrics({ availableWidth: 1600, contentWidth: 768 });
    store().toggle();
    expect(view().shouldShow).toBe(true);

    store().setMetrics({ availableWidth: 900, contentWidth: 768 });
    expect(store().isPinned).toBe(true);
    expect(view().shouldShow).toBe(false);
    // 窄档下按钮管的是浮层，钉住状态原样留着
    store().toggle();
    expect(store().isPopoverOpen).toBe(true);
    expect(store().isPinned).toBe(true);

    store().setMetrics({ availableWidth: 1600, contentWidth: 768 });
    expect(view().shouldShow).toBe(true);
    expect(store().isPopoverOpen).toBe(false);
  });

  it('测量值没变就整条不写，拖窗口不会刷爆订阅者', () => {
    const before = useSummaryPanelStore.getState();
    store().setMetrics({ availableWidth: 1400, contentWidth: 768 });
    const afterFirst = useSummaryPanelStore.getState();
    expect(afterFirst).not.toBe(before);

    store().setMetrics({ availableWidth: 1400, contentWidth: 768 });
    expect(useSummaryPanelStore.getState()).toBe(afterFirst);
  });

  it('close 两张面一起收', () => {
    store().setMetrics({ availableWidth: 1600, contentWidth: 768 });
    store().toggle();
    store().close();
    expect(store().isPinned).toBe(false);
    expect(store().isPopoverOpen).toBe(false);
    expect(store().availableWidth).toBe(1600);
  });
});
