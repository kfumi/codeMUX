// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ReactNode } from 'react';

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
    return <div data-testid="title-bar">{props.leftContent as ReactNode}</div>;
  },
}));

vi.mock('./NavRail', () => ({
  NavRail: ({ activeTarget }: { activeTarget: string }) => (
    <nav data-testid="nav-rail" data-active={activeTarget} />
  ),
  NAV_RAIL_WIDTH: 56,
}));

vi.mock('../workspace/SidePanel', () => ({
  SidePanel: ({ isVisible }: { isVisible?: boolean }) => (
    <div data-testid="side-panel" data-visible={String(isVisible)} />
  ),
}));

/** 标题栏里那条控制条（收起侧栏 + 后退/前进 + 附件）的容器。 */
function controlsHost(): HTMLElement | null {
  return document.querySelector('[data-testid="title-bar"]');
}

describe('MainLayout', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 820 });
    // 默认代表「桌面壳 + 窗口化」:内容面浮起成立的那一种形态,其余形态各自覆盖。
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

  it('keeps the title bar at the shell root instead of sizing it from sidebar props', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>} headerContent={<span>header</span>}>
        <div>content</div>
      </MainLayout>,
    );

    expect(titleBarProps).toHaveLength(1);
    expect(titleBarProps[0]).not.toHaveProperty('sidebarWidth');
    expect(titleBarProps[0]).not.toHaveProperty('sidebarInstant');
    // 标题栏跨全宽：它必须是 app-shell 的直接子节点，而不是内容列里的一个。
    const shell = document.querySelector('.app-shell');
    expect(shell?.firstElementChild).toBe(document.querySelector('[data-testid="title-bar"]'));
  });

  it('puts the controls in the full-width title bar and drops the floating overlay', () => {
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
    // 控件在标题栏里，不再有浮在侧栏左上角的那份副本。
    expect(controlsHost()?.contains(toggle!)).toBe(true);
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

  it('renders the sidebar on the window surface without backdrop blur', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const sidebar = document.querySelector('aside');

    // 这是不变量，不是「少写了一个类」：桌面形态下侧栏是 `relative shrink-0`（MainLayout.tsx），
    // 背后只有 .app-shell 的 bg-background 与 body 的平整纯色。backdrop-filter 作用在纯色上是
    // 恒等变换，侧栏上挂 blur 只有开销没有观感收益 —— 与 PI-Desktop 一致，本仓库把
    // 「**常驻布局表面**（尤其大面积）不得使用 backdrop-filter」当作不变量；
    // 一次性短命浮层、以及滚动容器上的 sticky 头仍可保留（源码契约里列出了唯一豁免）。
    // 侧栏与导航栏共用**窗口表面**（Codex 的 rail/sidebar 同色），只有内容面浮起来。
    expect(sidebar?.className).toContain('bg-[hsl(var(--sidebar-bg))]');
    expect(sidebar?.className).not.toContain('backdrop-blur');
    // 圆角缺口已经由 clip-path 取代，分隔线改成侧栏自己的一条 border-r。
    expect(sidebar?.className).toContain('border-r');
    expect(sidebar?.className).toContain('border-[hsl(var(--layout-divider))]');
  });

  it('paints the content surface lighter than the window so it actually floats', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const shell = document.querySelector('.app-shell');
    const section = document.querySelector('section');

    // 这两层摆反的话（内容面比窗口暗）浮起观感会完全消失 —— 浅色下等于一个洞。
    expect(shell?.className).toContain('bg-background');
    expect(section?.className).toContain('bg-[hsl(var(--surface-1))]');
    expect(section?.className).not.toContain('bg-[hsl(var(--background))]');
  });

  // 有意的源码级契约：className 断言只覆盖渲染出来的那个值，只有钉住源码文本才能在评审前拦住
  // 「往常驻布局表面加回 backdrop-blur-*」。口径与 PI-Desktop 一致 —— 常驻大面积表面一律用
  // 不透明/半透明底色表达层次，禁止 backdrop-filter。
  // 唯一豁免：窄屏抽屉打开时的遮罩层那 1px 模糊（一次性短命浮层）。
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

  it('floats the content surface with clip-path while the desktop shell is windowed', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const section = document.querySelector('section');
    const clipped = section?.querySelector('.content-surface');

    expect(section?.dataset.contentSurface).toBe('true');
    expect(section?.dataset.floats).toBe('true');
    // 外层负责圆角形状 + elevation，内层负责 clip-path —— clip-path 会把阴影一起裁掉。
    expect(section?.className).toContain('content-surface-root');
    expect(section?.className).toContain('shadow-elevation-content');
    expect(clipped).toBeTruthy();
    // 旧的「圆角缺口 + 手写 SVG 弧线」整套已经删除，源码里不该再有那段 SVG。
    expect(section?.querySelectorAll('svg[aria-hidden="true"] path')).toHaveLength(0);
  });

  it('drops the content-surface radius in browser-host forms', () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser' });

    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    expect(document.querySelector('section')?.dataset.floats).toBe('false');
  });

  it('drops the content-surface radius on narrow viewports where the sidebar is a drawer', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });

    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    expect(document.querySelector('section')?.dataset.floats).toBe('false');
  });

  it('drops the content-surface radius once the shell window is maximized', () => {
    windowState.maximized = true;

    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    expect(document.querySelector('section')?.dataset.floats).toBe('false');
  });

  it('drops the content-surface radius once the sidebar is collapsed', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    expect(document.querySelector('section')?.dataset.floats).toBe('true');

    fireEvent.click(document.querySelector('button[aria-label="收起侧栏"]')!);

    expect(document.querySelector('section')?.dataset.floats).toBe('false');
  });

  it('pins the narrow-screen drawer below the title bar so the controls stay clickable', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });

    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const aside = document.querySelector('aside');
    expect(aside?.className).toContain('top-12');
    expect(aside?.className).toContain('bottom-0');
    // 控制条只有标题栏里那一份 —— 抽屉不再复制（原先是为了盖住标题栏才复制的）。
    expect(document.querySelectorAll('aside button[aria-label$="侧栏"]')).toHaveLength(0);
    expect(document.querySelectorAll('button[aria-label$="侧栏"]')).toHaveLength(1);
  });

  it('renders the nav rail only when the app supplies a target and a handler', () => {
    const { unmount } = render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );
    expect(document.querySelector('[data-testid="nav-rail"]')).toBeNull();
    unmount();

    render(
      <MainLayout sidebar={<div>sidebar</div>} navRailTarget="todo" onNavRailSelect={vi.fn()}>
        <div>content</div>
      </MainLayout>,
    );
    const rail = document.querySelector('[data-testid="nav-rail"]');
    expect(rail?.getAttribute('data-active')).toBe('todo');
    // 导航栏在侧栏之前 —— 它是最左边的顶层导航。
    expect(rail?.nextElementSibling?.tagName).toBe('ASIDE');
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

    expect(document.querySelector('[data-testid="side-panel"]')?.getAttribute('data-visible')).toBe('false');
  });
});
