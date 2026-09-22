// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MainLayout } from './MainLayout';
import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
import { useShellLayoutStore } from '../../stores/shellLayoutStore';

const titleBarProps: Record<string, unknown>[] = [];

const windowState = vi.hoisted(() => ({ maximized: false }));

vi.mock('../../hooks/useWindowMaximized', () => ({
  useWindowMaximized: () => windowState.maximized,
}));

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
    // 默认代表「桌面壳 + 窗口化」:圆角缺口成立的那一种形态,其余形态各自覆盖。
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
    // 侧栏收起/抽屉开合现在是布局 store 里的全局状态（可绑定命令要用），
    // 用例之间必须复位，否则前一个用例点过「收起侧栏」会漏给后面的用例。
    useShellLayoutStore.setState({ sidebarCollapsed: false, narrowSidebarOpen: false });
    windowState.maximized = false;
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

  it('renders the sidebar as a translucent solid surface without backdrop blur', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const sidebar = document.querySelector('aside');

    // 这是不变量，不是「少写了一个类」：桌面形态下侧栏是 `relative shrink-0`（MainLayout.tsx:226），
    // 背后只有 .app-shell 的 bg-background（MainLayout.tsx:196）与 body 的平整纯色
    // （globals.css:107 --color-background: hsl(var(--background))，--background 是不透明常量
    // 0 0% 100% / 0 0% 9.4%；globals.css:251-263 body background-image: none；
    // globals.css:318-321 .app-shell isolation: isolate）。backdrop-filter 作用在纯色上是恒等变换，
    // 侧栏上挂 blur 只有开销没有观感收益 —— 与 PI-Desktop 一致，本仓库把「**常驻布局表面**
    // （尤其大面积）不得使用 backdrop-filter」当作不变量；一次性短命浮层、以及滚动容器上的
    // sticky 头仍可保留（源码契约里列出了唯一豁免）。
    expect(sidebar?.className).toContain('bg-[hsl(var(--surface-2)/0.88)]');
    expect(sidebar?.className).not.toContain('backdrop-blur');
    expect(sidebar?.className).not.toContain('border-r');
  });

  // 有意的源码级契约：className 断言只覆盖渲染出来的那个值，只有钉住源码文本才能在评审前拦住
  // 「往常驻布局表面加回 backdrop-blur-*」。口径与 PI-Desktop 一致 —— 常驻大面积表面一律用
  // 不透明/半透明底色表达层次，禁止 backdrop-filter。
  // 唯一豁免：窄屏抽屉打开时的遮罩层那 1px 模糊（MainLayout.tsx:209，一次性短命浮层，不在本次范围）。
  it('keeps backdrop-blur off the resident surfaces in the MainLayout source', () => {
    // jsdom 下 import.meta.url 不是 file 地址（见 CodeMuxThread.navActiveSource.test.ts 的说明），
    // 测试根即仓库根，所以按 cwd 拼相对路径读源码，不引入新依赖。
    const source = readFileSync(
      join(process.cwd(), 'src', 'components', 'layout', 'MainLayout.tsx'),
      'utf8',
    );
    // 注释行不算违规（说明文字里允许提到这个 token）。豁免项用「先摘掉 token 再检查」，
    // 而不是「含它就整行免检」—— 否则把 `backdrop-blur-xl` 追加到同一个 className 上，
    // 这条契约就被绕过去了。
    const residentBlurLines = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .filter((line) => line.split('backdrop-blur-[1px]').join('').includes('backdrop-blur'));

    expect(residentBlurLines).toEqual([]);
  });

  it('keeps the workspace notch while the desktop shell is windowed', () => {
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

  it('drops the notch and the corner arcs in browser-host forms', () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser' });

    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const section = document.querySelector('section');
    const divider = section?.querySelector('div[aria-hidden="true"]');

    expect(section?.className).not.toContain('rounded-tl-2xl');
    expect(section?.className).not.toContain('rounded-bl-2xl');
    expect(section?.querySelectorAll('svg[aria-hidden="true"] path')).toHaveLength(0);
    // 侧栏仍然停靠,所以保留直线到底的分割线。
    expect(divider?.className).toContain('w-px');
    expect(divider?.className).toContain('inset-y-0');
  });

  it('drops the notch on narrow viewports where the sidebar is a drawer', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });

    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const section = document.querySelector('section');

    expect(section?.className).not.toContain('rounded-tl-2xl');
    expect(section?.querySelectorAll('svg[aria-hidden="true"] path')).toHaveLength(0);
    // 抽屉收起时面板左缘就是视口边缘,没有需要分隔的侧栏。
    expect(section?.querySelector('div[aria-hidden="true"]')).toBeNull();
  });

  it('drops the notch once the shell window is maximized', () => {
    windowState.maximized = true;

    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const section = document.querySelector('section');
    const divider = section?.querySelector('div[aria-hidden="true"]');

    expect(section?.className).not.toContain('rounded-tl-2xl');
    expect(section?.className).not.toContain('rounded-bl-2xl');
    expect(section?.querySelectorAll('svg[aria-hidden="true"] path')).toHaveLength(0);
    expect(divider?.className).toContain('inset-y-0');
  });

  it('drops the notch and its divider once the sidebar is collapsed', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    fireEvent.click(document.querySelector('button[aria-label="收起侧栏"]')!);

    const section = document.querySelector('section');

    expect(section?.className).not.toContain('rounded-tl-2xl');
    expect(section?.querySelectorAll('svg[aria-hidden="true"] path')).toHaveLength(0);
    expect(section?.querySelector('div[aria-hidden="true"]')).toBeNull();
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
