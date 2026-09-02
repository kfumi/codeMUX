// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserApiMock = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  navigate: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  reload: vi.fn(),
  setBounds: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  evaluate: vi.fn(),
  openDevtools: vi.fn(),
  clearData: vi.fn(),
  setZoom: vi.fn(),
}));

const openMock = vi.hoisted(() => vi.fn());
const popupViewportMenuMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/tauri', () => ({
  browserApi: browserApiMock,
}));

vi.mock('../../lib/browserViewportMenu', () => ({
  popupViewportMenu: popupViewportMenuMock,
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: openMock,
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../ui/tooltip', () => ({
  TooltipHint: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

import { useBrowserElementStore } from '../../stores/browserElementStore';
import { useBrowserStore } from '../../stores/browserStore';
import { BrowserPanel } from './BrowserPanel';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('BrowserPanel toolbar', () => {
  beforeEach(() => {
    useBrowserStore.getState().reset();
    for (const fn of Object.values(browserApiMock)) {
      fn.mockReset();
      fn.mockResolvedValue(undefined);
    }
    openMock.mockReset();
    popupViewportMenuMock.mockReset();
    popupViewportMenuMock.mockResolvedValue(null);
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  });

  afterEach(() => {
    cleanup();
    useBrowserStore.getState().reset();
    useBrowserElementStore.getState().reset();
    vi.unstubAllGlobals();
  });

  it('keeps both slashes while typing an http URL and disables ligatures', () => {
    const tabId = 'session-a:browser';
    useBrowserStore.getState().ensureBlankPage(tabId);
    render(<BrowserPanel tabId={tabId} sessionId="session-a" isActive />);

    const input = screen.getByRole('textbox', { name: '网址' });
    fireEvent.change(input, { target: { value: 'http://w' } });

    expect((input as HTMLInputElement).value).toBe('http://w');
    expect(input.className).toContain('font-liga-none');
  });

  it('orders the trailing actions as size, element picker, then more', () => {
    const tabId = 'session-a:browser';
    useBrowserStore.getState().ensureBlankPage(tabId);
    render(<BrowserPanel tabId={tabId} sessionId="session-a" isActive />);

    expect(screen.getByRole('button', { name: '自由尺寸' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择网页元素加入聊天' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '更多浏览器操作' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '复制链接' })).toBeNull();
    expect(screen.getByRole('button', { name: '在默认浏览器中打开' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开调试工具' })).toBeTruthy();
  });

  it('shows the reference viewport chrome after clicking 自由尺寸', async () => {
    const tabId = 'session-a:browser';
    useBrowserStore.getState().ensureBlankPage(tabId);
    render(<BrowserPanel tabId={tabId} sessionId="session-a" isActive />);

    expect(screen.queryByText('393 × 852')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '自由尺寸' }));

    expect(screen.getByText('393 × 852')).toBeTruthy();
    expect(screen.getByText('393 × 852').className).toContain('text-ui-meta');
    expect(screen.getByText('393 × 852').className).not.toContain('font-mono');
    expect(screen.queryByRole('combobox')).toBeNull();
    const scaleTrigger = screen.getByRole('button', { name: '调整预览尺寸' });
    expect(scaleTrigger.textContent).toContain('适应窗口');
    expect(scaleTrigger.className).toContain('text-ui-meta');
    expect(useBrowserStore.getState().previewByPanel[tabId]).toBe(true);

    popupViewportMenuMock.mockResolvedValueOnce(50);
    fireEvent.click(scaleTrigger);
    await waitFor(() => {
      expect(popupViewportMenuMock).toHaveBeenCalled();
      expect(useBrowserStore.getState().viewportModeByPanel[tabId]).toBe(50);
    });
    expect(popupViewportMenuMock.mock.calls[0]?.[0]).toBe('fit');

    fireEvent.click(screen.getByRole('button', { name: '自由尺寸' }));
    expect(screen.queryByText('393 × 852')).toBeNull();
    expect(useBrowserStore.getState().previewByPanel[tabId]).toBe(false);
  });

  it('ends inspect mode after a captured element is polled', async () => {
    const tabId = 'session-a:browser';
    const pageId = useBrowserStore.getState().ensureBlankPage(tabId);
    useBrowserStore.getState().startInspect(pageId);
    useBrowserStore.getState().applyHostPatch({
      browserId: pageId,
      url: 'https://example.com/',
      isLoading: false,
    });
    useBrowserStore.setState((state) => ({
      pages: {
        ...state.pages,
        [pageId]: { ...state.pages[pageId], hostAttached: true, isLoading: false },
      },
    }));

    browserApiMock.evaluate
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(JSON.stringify({
        captured: {
          tag: 'div',
          text: 'hello',
          url: 'https://example.com/',
        },
      }));

    render(<BrowserPanel tabId={tabId} sessionId="session-a" isActive />);
    await vi.waitFor(() => {
      expect(useBrowserStore.getState().inspectingPageId).toBeNull();
    });
    expect(useBrowserElementStore.getState().elementsBySession['session-a']).toHaveLength(1);
  });
});
