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
import { CONTENT_WIDTHS } from './appearance';

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

  it('正文铺满对话列（百分比取值）时没有空槽，只能浮层', () => {
    // --content-width 解析不出来时，调用方把正文列宽取成对话列宽。
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

  it('百分比、空值与垃圾值返回 null，由调用方退化', () => {
    expect(parseContentWidthToken('')).toBeNull();
    expect(parseContentWidthToken('auto')).toBeNull();
    expect(parseContentWidthToken('calc(48rem + 1px)')).toBeNull();
    // 百分比依赖容器宽度：不给 availableWidth 就无从算起。
    expect(parseContentWidthToken('100%')).toBeNull();
  });

  it('流式档的 calc(100% - gutter) 按容器宽度算，不是恒返回 null', () => {
    // 回归用例：CONTENT_WIDTHS.stream 就是这种写法，而解析器曾经只认 px/rem，
    // 于是流式档永远走「解析失败 → 正文铺满对话列」那条路，面板永远停在浮层。
    expect(parseContentWidthToken('calc(100% - 48px)', 16, 800)).toBe(752);
    expect(parseContentWidthToken('calc(100% - 3rem)', 16, 800)).toBe(752);
    expect(parseContentWidthToken('100%', 16, 800)).toBe(800);
  });

  it('流式档的边距按 clamp(rem, vw, rem) 的当前取值算，不取上下限', () => {
    // 下限 2rem=32；中段按 10vw 放大；极宽时被上限 12rem=192 夹住。
    expect(parseContentWidthToken(CONTENT_WIDTHS.stream, 16, 200)).toBe(200 - 32);
    expect(parseContentWidthToken(CONTENT_WIDTHS.stream, 16, 1600)).toBeCloseTo(1600 - 166.4);
    expect(parseContentWidthToken(CONTENT_WIDTHS.stream, 16, 2560)).toBe(2560 - 192);
  });
});

describe('CONTENT_WIDTHS 与 parseContentWidthToken 之间的契约', () => {
  // 这两个 module 之间曾经没有一条测试连着：CONTENT_WIDTHS 是字符串字面量，
  // 解析器在另一个文件，改任何一边都不会让另一边变红。这组断言就是那条连接。
  it('每个真实档位在常见宽度下都能解析出非 null', () => {
    for (const [key, token] of Object.entries(CONTENT_WIDTHS)) {
      for (const availableWidth of [320, 400, 600, 800, 1024, 1600, 2560]) {
        const parsed = parseContentWidthToken(token, 16, availableWidth);
        expect(parsed, `${key} @ ${availableWidth}`).not.toBeNull();
        expect(parsed as number, `${key} @ ${availableWidth}`).toBeGreaterThan(0);
        // 只有流式档的宽度依赖容器；定宽档是绝对值，容器比它窄时仍然返回 768
        // （CSS 视觉上会收窄，但 token 本身不变）。
        if (key === 'stream') {
          expect(parsed as number, `${key} @ ${availableWidth}`).toBeLessThanOrEqual(availableWidth);
        }
      }
    }
  });

  it('流式档随容器单调铺开，定宽档恒定', () => {
    const widths = [400, 800, 1200, 1600];
    const stream = widths.map((w) => parseContentWidthToken(CONTENT_WIDTHS.stream, 16, w) as number);
    for (let i = 1; i < stream.length; i += 1) {
      expect(stream[i]).toBeGreaterThan(stream[i - 1]);
    }
    for (const w of widths) {
      expect(parseContentWidthToken(CONTENT_WIDTHS.fixed, 16, w)).toBe(768);
    }
  });

  it('流式档的正文列宽严格小于对话列宽 —— 两侧确实让出了边距', () => {
    // 「让出边距」正是面板档位算法的前提：half = (avail - contentWidth) / 2 > 0。
    // 若流式档改成真正的 100%，这条会失败，提示人重新审视面板档位阈值。
    const parsed = parseContentWidthToken(CONTENT_WIDTHS.stream, 16, 1200) as number;
    expect(parsed).toBeLessThan(1200);
  });
});
