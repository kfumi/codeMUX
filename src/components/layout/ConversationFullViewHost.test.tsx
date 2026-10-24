// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationFullViewHost } from './ConversationFullViewHost';

/**
 * 几何是 DOM 布局投影（实测 slot rect），不进 React state —— 测试只断言
 * 「形态切换 + 写入的 rect 值 + 跟随变化」，不做像素排版断言。
 */

type ObserverCallback = (entries: unknown[]) => void;

function hostElement(): HTMLElement {
  return document.querySelector('[data-conversation-full-view-host]') as HTMLElement;
}

describe('ConversationFullViewHost', () => {
  let observerInstances: { callback: ObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];

  beforeEach(() => {
    observerInstances = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ObserverCallback) {
        observerInstances.push({ callback, observe: vi.fn(), disconnect: vi.fn() });
      }

      observe(target: Element) {
        observerInstances.at(-1)?.observe(target);
      }

      disconnect() {
        observerInstances.at(-1)?.disconnect();
      }
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function fakeSlot(getRect: () => { left: number; top: number; width: number; height: number }) {
    const element = document.createElement('div');
    element.getBoundingClientRect = () => {
      const rect = getRect();
      return {
        ...rect,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        x: rect.left,
        y: rect.top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    return element;
  }

  const staticSlot = (rect: { left: number; top: number; width: number; height: number }) =>
    fakeSlot(() => rect);

  it('普通形态是常规 flex 容器,不写任何几何', () => {
    render(
      <ConversationFullViewHost active={false} slotElement={staticSlot({ left: 0, top: 0, width: 800, height: 600 })}>
        <div data-testid="conversation-body" />
      </ConversationFullViewHost>,
    );

    const host = hostElement();
    expect(host.dataset.conversationFullViewHost).toBe('idle');
    expect(host.className).not.toContain('fixed');
    expect(host.querySelector('[data-testid="conversation-body"]')).toBeTruthy();
    expect(host.style.left).toBe('');
  });

  it('slot 未就绪时即使 surface 激活也保持普通布局', () => {
    render(
      <ConversationFullViewHost active slotElement={null}>
        <div />
      </ConversationFullViewHost>,
    );

    expect(hostElement().dataset.conversationFullViewHost).toBe('idle');
    expect(hostElement().className).not.toContain('fixed');
  });

  it('激活时 fixed 盖住 slot 投影,并观察 slot 尺寸变化', () => {
    const slot = staticSlot({ left: 560, top: 88, width: 800, height: 640 });
    render(
      <ConversationFullViewHost active slotElement={slot}>
        <div />
      </ConversationFullViewHost>,
    );

    const host = hostElement();
    expect(host.dataset.conversationFullViewHost).toBe('active');
    expect(host.className).toContain('fixed');
    expect(host.style.left).toBe('560px');
    expect(host.style.top).toBe('88px');
    expect(host.style.width).toBe('800px');
    expect(host.style.height).toBe('640px');
    expect(observerInstances).toHaveLength(1);
    expect(observerInstances[0].observe).toHaveBeenCalledWith(slot);
  });

  it('slot 尺寸或窗口变化时几何跟随更新', () => {
    let rect = { left: 0, top: 40, width: 400, height: 300 };
    const slot = fakeSlot(() => rect);

    render(
      <ConversationFullViewHost active slotElement={slot}>
        <div />
      </ConversationFullViewHost>,
    );

    rect = { left: 10, top: 52, width: 900, height: 700 };
    observerInstances[0].callback([]);
    let host = hostElement();
    expect(host.style.width).toBe('900px');

    rect = { left: 0, top: 52, width: 960, height: 700 };
    window.dispatchEvent(new Event('resize'));
    host = hostElement();
    expect(host.style.width).toBe('960px');
  });

  it('退出对话 surface 时清掉几何并断开观察', () => {
    const slot = staticSlot({ left: 0, top: 0, width: 400, height: 300 });
    const { rerender } = render(
      <ConversationFullViewHost active slotElement={slot}>
        <div />
      </ConversationFullViewHost>,
    );

    rerender(
      <ConversationFullViewHost active={false} slotElement={slot}>
        <div />
      </ConversationFullViewHost>,
    );

    const host = hostElement();
    expect(host.dataset.conversationFullViewHost).toBe('idle');
    expect(host.className).not.toContain('fixed');
    ['left', 'top', 'width', 'height'].forEach((property) => {
      expect(host.style.getPropertyValue(property)).toBe('');
    });
    expect(observerInstances[0].disconnect).toHaveBeenCalled();
  });

  it('切换 slot 元素时旧观察断开、按新 slot 重新定位', () => {
    const firstSlot = staticSlot({ left: 0, top: 0, width: 400, height: 300 });
    const { rerender } = render(
      <ConversationFullViewHost active slotElement={firstSlot}>
        <div />
      </ConversationFullViewHost>,
    );

    const secondSlot = staticSlot({ left: 100, top: 200, width: 300, height: 200 });
    rerender(
      <ConversationFullViewHost active slotElement={secondSlot}>
        <div />
      </ConversationFullViewHost>,
    );

    expect(observerInstances[0].disconnect).toHaveBeenCalled();
    expect(observerInstances[1].observe).toHaveBeenCalledWith(secondSlot);
    expect(hostElement().style.left).toBe('100px');
  });
});
