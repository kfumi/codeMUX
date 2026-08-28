// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MainLayout } from './MainLayout';

const titleBarProps: Record<string, unknown>[] = [];

vi.mock('./TitleBar', () => ({
  TitleBar: (props: Record<string, unknown>) => {
    titleBarProps.push(props);
    return <div data-testid="title-bar" />;
  },
}));

vi.mock('../workspace/SidePanel', () => ({
  SidePanel: ({ isVisible }: { isVisible?: boolean }) => (
    <div data-testid="side-panel" data-visible={String(isVisible)} />
  ),
}));

describe('MainLayout', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 820 });
  });

  afterEach(() => {
    titleBarProps.length = 0;
    cleanup();
  });

  it('keeps the title bar inside the workspace instead of sizing it from sidebar props', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>} headerContent={<span>header</span>}>
        <div>content</div>
      </MainLayout>,
    );

    expect(titleBarProps).toHaveLength(1);
    expect(titleBarProps[0]).not.toHaveProperty('sidebarWidth');
    expect(titleBarProps[0]).not.toHaveProperty('sidebarInstant');
  });

  it('renders sidebar accessory next to the expanded sidebar toggle', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>} sidebarAccessory={<button>更新</button>}>
        <div>content</div>
      </MainLayout>,
    );

    const toggle = document.querySelector('button[aria-label="收起侧栏"]');
    const update = document.querySelector('button:not([aria-label])');

    expect(toggle).toBeTruthy();
    expect(update?.textContent).toBe('更新');
    expect(toggle?.parentElement).toBe(update?.parentElement);
  });

  it('renders navigation controls beside the sidebar toggle', () => {
    const onBack = vi.fn();
    const onForward = vi.fn();

    render(
      <MainLayout
        sidebar={<div>sidebar</div>}
        titleBarNavigation={{
          canGoBack: true,
          canGoForward: false,
          onBack,
          onForward,
        }}
      >
        <div>content</div>
      </MainLayout>,
    );

    const toggle = document.querySelector('button[aria-label="收起侧栏"]');
    const back = document.querySelector('button[aria-label="后退"]') as HTMLButtonElement | null;
    const forward = document.querySelector('button[aria-label="前进"]') as HTMLButtonElement | null;

    expect(toggle).toBeTruthy();
    expect(back).toBeTruthy();
    expect(forward?.disabled).toBe(true);
    expect(back?.parentElement?.parentElement).toBe(toggle?.parentElement);

    fireEvent.click(back!);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onForward).not.toHaveBeenCalled();
  });

  it('renders the sidebar as a distinct translucent surface without a straight right divider', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const sidebar = document.querySelector('aside');

    expect(sidebar?.className).toContain('bg-[hsl(var(--surface-2)/0.88)]');
    expect(sidebar?.className).toContain('backdrop-blur-xl');
    expect(sidebar?.className).not.toContain('border-r');
  });

  it('rounds the whole workspace section over a notch background matching the sidebar', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const section = document.querySelector('section');
    const notchBackdrop = section?.parentElement;

    expect(section?.className).toContain('rounded-tl-2xl');
    expect(section?.className).toContain('rounded-bl-2xl');
    expect(section?.className).toContain('overflow-hidden');
    expect(section?.className).not.toContain('border-l');
    expect(notchBackdrop?.className).toContain('bg-[hsl(var(--surface-2)/0.88)]');
  });

  it('draws the workspace divider as a crisp straight run plus corner arcs that follow the radius', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const section = document.querySelector('section');
    const divider = section?.querySelector('div[aria-hidden="true"]');

    expect(divider?.className).toContain('w-px');
    expect(divider?.className).toContain('bg-[hsl(var(--layout-divider))]');
    expect(divider?.className).toContain('top-[var(--radius-2xl)]');
    expect(divider?.className).toContain('bottom-[var(--radius-2xl)]');
    expect(divider?.className).toContain('pointer-events-none');

    const cornerArcs = Array.from(section?.querySelectorAll('svg[aria-hidden="true"] path') ?? []);
    expect(cornerArcs).toHaveLength(2);
    for (const arc of cornerArcs) {
      expect(arc.getAttribute('d')).toMatch(/^M0\.5 (0|12) A11\.5 11\.5 0 0 [01] 12 (11\.5|0\.5)$/);
      expect(arc.getAttribute('stroke')).toBe('hsl(var(--layout-divider))');
      expect(arc.getAttribute('stroke-width')).toBe('1.5');
      expect(arc.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    }
  });

  it('keeps the sidebar width fixed when the window is maximized or restored', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    const { unmount } = render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const sidebar = document.querySelector('aside') as HTMLElement;
    const initialWidth = sidebar.style.width;
    expect(initialWidth).toBe('300px');

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
    window.dispatchEvent(new Event('resize'));
    expect(sidebar.style.width).toBe(initialWidth);

    unmount();
  });

  it('keeps the side panel mounted while settings only hide it', () => {
    render(
      <MainLayout sidePanelAvailable={false}>
        <div>content</div>
      </MainLayout>,
    );

    expect(screen.getByTestId('side-panel').getAttribute('data-visible')).toBe('false');
  });
});
