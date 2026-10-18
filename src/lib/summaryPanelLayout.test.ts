import { describe, expect, it } from 'vitest';

import {
  CODEX_THREAD_CONTENT_WIDTH,
  parseContentWidthToken,
  resolveSummaryPanelContentShift,
  resolveSummaryPanelDisplayMode,
  resolveSummaryPanelSurface,
  resolveSummaryPanelView,
  SUMMARY_PANEL_WIDTH,
} from './summaryPanelLayout';

/**
 * 冻结表：阈值直接照 Codex 的 `thread-summary-panel-layout` 反推。
 *
 * 正文 736、面板 300 时：
 *   空槽 half = (W - 736) / 2
 *   half < 180        → overlay   （W < 1096）
 *   half < 400        → shift     （1096 ≤ W < 1536）
 *   否则               → gutter    （W ≥ 1536）
 */
describe('resolveSummaryPanelDisplayMode', () => {
  const at = (width: number) => resolveSummaryPanelDisplayMode(width, { contentWidth: 736 });

  it('keeps Codex 的 300px 面板基准', () => {
    expect(SUMMARY_PANEL_WIDTH).toBe(300);
    expect(CODEX_THREAD_CONTENT_WIDTH).toBe(736);
  });

  it.each([
    [600, 'overlay'],
    [1095, 'overlay'],
    [1096, 'shift'],
    [1280, 'shift'],
    [1535, 'shift'],
    [1536, 'gutter'],
    [1920, 'gutter'],
    [2560, 'gutter'],
  ])('%i px 的对话列落在 %s 档', (width, expected) => {
    expect(at(width)).toBe(expected);
  });

  it('正文铺满对话列（铺满档）时没有空槽，只能浮层', () => {
    // stream 档下 --content-width 解析不出来，调用方把正文列宽取成对话列宽。
    expect(resolveSummaryPanelDisplayMode(1600, { contentWidth: 1600 })).toBe('overlay');
  });

  it('面板越宽，三个阈值整体右移', () => {
    // extra = 100：overlay 直到 half < 230，shift 直到 half < 500
    expect(resolveSummaryPanelDisplayMode(1195, { contentWidth: 736, panelWidth: 400 })).toBe('overlay');
    expect(resolveSummaryPanelDisplayMode(1196, { contentWidth: 736, panelWidth: 400 })).toBe('shift');
    expect(resolveSummaryPanelDisplayMode(1735, { contentWidth: 736, panelWidth: 400 })).toBe('shift');
    expect(resolveSummaryPanelDisplayMode(1736, { contentWidth: 736, panelWidth: 400 })).toBe('gutter');
  });
});

describe('resolveSummaryPanelSurface', () => {
  it('只有非 overlay 档、且用户钉住了它，内联面才可见', () => {
    expect(resolveSummaryPanelSurface({ displayMode: 'gutter', isPinned: true, isPopoverOpen: false }))
      .toEqual({
        displayMode: 'gutter',
        shouldHideInlineImmediately: false,
        shouldShow: true,
        visibleSurface: 'inline',
      });
    expect(resolveSummaryPanelSurface({ displayMode: 'gutter', isPinned: false, isPopoverOpen: false }).visibleSurface).toBeNull();
    // overlay 档里「钉住」不成立：那时面板就是浮层。
    expect(resolveSummaryPanelSurface({ displayMode: 'overlay', isPinned: true, isPopoverOpen: false }).shouldShow).toBe(false);
  });

  it('overlay 档里浮层展开即代表可见面，并要求内联面立刻消失', () => {
    expect(resolveSummaryPanelSurface({ displayMode: 'overlay', isPinned: false, isPopoverOpen: true }))
      .toEqual({
        displayMode: 'overlay',
        shouldHideInlineImmediately: true,
        shouldShow: false,
        visibleSurface: 'popover',
      });
  });

  it('浮层收起后没有任何面', () => {
    expect(resolveSummaryPanelSurface({ displayMode: 'overlay', isPinned: false, isPopoverOpen: false }).visibleSurface).toBeNull();
  });
});

describe('resolveSummaryPanelContentShift', () => {
  it('只有 shift 档 + 钉住才让位，位移是面板占位的一半', () => {
    expect(resolveSummaryPanelContentShift({ displayMode: 'shift', isPinned: true })).toBe(-154);
    expect(resolveSummaryPanelContentShift({ displayMode: 'shift', isPinned: false })).toBe(0);
    expect(resolveSummaryPanelContentShift({ displayMode: 'gutter', isPinned: true })).toBe(0);
    expect(resolveSummaryPanelContentShift({ displayMode: 'overlay', isPinned: true })).toBe(0);
  });

  it('面板变宽时位移跟着变：-(300 + 8 + extra) / 2', () => {
    expect(resolveSummaryPanelContentShift({ displayMode: 'shift', isPinned: true, panelWidth: 400 })).toBe(-204);
  });
});

describe('resolveSummaryPanelView', () => {
  it('把测量值、档位、位移一次算齐', () => {
    expect(resolveSummaryPanelView({
      availableWidth: 1400,
      contentWidth: 768,
      isPinned: true,
      isPopoverOpen: false,
    })).toEqual({
      displayMode: 'shift',
      panelWidth: 300,
      contentShift: -154,
      shouldHideInlineImmediately: false,
      shouldShow: true,
      visibleSurface: 'inline',
    });
  });

  it('gutter 档不位移：面板落进空槽，正文不动', () => {
    expect(resolveSummaryPanelView({
      availableWidth: 1920,
      contentWidth: 768,
      isPinned: true,
      isPopoverOpen: false,
    })).toMatchObject({ displayMode: 'gutter', contentShift: 0 });
  });

  it('还没测到宽度时按最窄处理，先在 overlay 档待着', () => {
    expect(resolveSummaryPanelView({
      availableWidth: null,
      contentWidth: 768,
      isPinned: true,
      isPopoverOpen: true,
    })).toMatchObject({ displayMode: 'overlay', contentShift: 0, visibleSurface: 'popover' });
  });
});

describe('parseContentWidthToken', () => {
  it('认 px 与 rem', () => {
    expect(parseContentWidthToken('768px')).toBe(768);
    expect(parseContentWidthToken('48rem')).toBe(768);
    expect(parseContentWidthToken(' 48rem ', 10)).toBe(480);
  });

  it('铺满档、空值与垃圾值返回 null，由调用方退化', () => {
    expect(parseContentWidthToken('100%')).toBeNull();
    expect(parseContentWidthToken('')).toBeNull();
    expect(parseContentWidthToken('auto')).toBeNull();
    expect(parseContentWidthToken('calc(48rem + 1px)')).toBeNull();
  });
});
