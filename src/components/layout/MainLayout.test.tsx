// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ReactNode } from 'react';

import { MainLayout } from './MainLayout';
import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
import { useShellLayoutStore } from '../../stores/shellLayoutStore';
import { useSummaryPanelStore } from '../../stores/summaryPanelStore';

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
  NavRail: ({ activeTarget, accessory }: { activeTarget: string; accessory?: ReactNode }) => (
    <nav data-testid="nav-rail" data-active={activeTarget}>{accessory}</nav>
  ),
  NAV_RAIL_WIDTH: 56,
}));

// 窄屏下图标轨整条隐藏，顶层导航收进抽屉（顶部分段行 + 底部页脚三行）。
vi.mock('./NarrowNavSwitcher', () => ({
  NarrowNavSwitcher: ({ activeTarget }: { activeTarget: string }) => (
    <div data-testid="narrow-nav-switcher" data-active={activeTarget} />
  ),
}));

vi.mock('./NarrowNavFooter', () => ({
  NarrowNavFooter: ({ activeTarget, accessory }: { activeTarget: string; accessory?: ReactNode }) => (
    <div data-testid="narrow-nav-footer" data-active={activeTarget}>{accessory}</div>
  ),
}));

vi.mock('../workspace/SidePanel', () => ({
  SidePanel: ({ isVisible }: { isVisible?: boolean }) => (
    <div data-testid="side-panel" data-visible={String(isVisible)} />
  ),
}));

// 摘要面板的内联面浮在对话列里；这里只关心它挂没挂上、对话列让没让位，
// 面板自身的渲染归 SummaryPanelSurface.test.tsx。
vi.mock('../workspace/review/SummaryPanelSurface', () => ({
  SummaryPanelSurface: ({ projectPath }: { projectPath?: string | null }) => (
    <div data-testid="summary-panel-surface" data-project={String(projectPath)} />
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
    // 摘要面板的档位来自测量值：测试里没有排版，得手动给一份，
    // 否则永远停在 overlay（面板挂标题栏浮层）。
    useSummaryPanelStore.getState().reset();
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

  it('宽档钉住摘要时把「正文列左移」写成 CSS 变量，并把内联面挂进对话列', () => {
    useSummaryPanelStore.getState().setMetrics({ availableWidth: 1400, contentWidth: 768 });
    useSummaryPanelStore.getState().setPinned(true);

    render(
      <MainLayout sidebar={<div>sidebar</div>} projectOpenPath="D:/project/app">
        <div>content</div>
      </MainLayout>,
    );

    const pane = document.querySelector('[data-conversation-pane]') as HTMLElement;
    // shift 档：正文列左移 -154px。位移交给正文列自己施加（滚动容器保持满宽，
    // 滚动条因此留在最右侧），对话列本身不加内边距、不缩窄。
    expect(pane.style.getPropertyValue('--summary-content-shift')).toBe('-154px');
    expect(pane.style.paddingRight).toBe('');

    const surface = document.querySelector('[data-testid="summary-panel-surface"]');
    // 面板浮在**对话列里面**：它跟正文是同一层的邻居，不能跑到内容面之外。
    expect(surface).toBeTruthy();
    expect(pane.contains(surface)).toBe(true);
  });

  it('空槽够宽（gutter 档）时面板落进空槽，正文不位移', () => {
    useSummaryPanelStore.getState().setMetrics({ availableWidth: 1920, contentWidth: 768 });
    useSummaryPanelStore.getState().setPinned(true);

    render(
      <MainLayout sidebar={<div>sidebar</div>} projectOpenPath="D:/project/app">
        <div>content</div>
      </MainLayout>,
    );

    const pane = document.querySelector('[data-conversation-pane]') as HTMLElement;
    expect(pane.style.getPropertyValue('--summary-content-shift')).toBe('0px');
    expect(document.querySelector('[data-testid="summary-panel-surface"]')).toBeTruthy();
  });

  it('routes the sidebar accessory into the bottom of the nav rail, not the title bar', () => {
    render(
      <MainLayout
        sidebar={<div>sidebar</div>}
        navRailTarget="app"
        onNavRailSelect={vi.fn()}
        sidebarAccessory={<button>更新</button>}
      >
        <div>content</div>
      </MainLayout>,
    );

    const toggle = document.querySelector('button[aria-label="收起侧栏"]');
    const rail = document.querySelector('[data-testid="nav-rail"]');
    const update = rail?.querySelector('button');

    // 更新入口落在图标轨里（Codex 的左下角），标题栏里不再有那份副本。
    expect(toggle).toBeTruthy();
    expect(update?.textContent).toBe('更新');
    expect(controlsHost()?.contains(update!)).toBe(false);
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

  it('renders the sidebar as its own panel on the chrome, without backdrop blur', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const sidebar = document.querySelector('aside');

    // 这是不变量，不是「少写了一个类」：桌面形态下侧栏是 `relative shrink-0`（MainLayout.tsx），
    // 背后只有 .app-shell 的窗口面与 body 的平整纯色。backdrop-filter 作用在纯色上是
    // 恒等变换，侧栏上挂 blur 只有开销没有观感收益 —— 与 PI-Desktop 一致，本仓库把
    // 「**常驻布局表面**（尤其大面积）不得使用 backdrop-filter」当作不变量；
    // 一次性短命浮层、以及滚动容器上的 sticky 头仍可保留（源码契约里列出了唯一豁免）。
    // 侧栏是窗口面之上的第一层浮起面板（Codex 同构：窗口面是「窗框」，侧栏与内容面
    // 依次更亮），窗口面只从左侧圆角缺口里露出来。
    expect(sidebar?.className).toContain('bg-[hsl(var(--sidebar-bg))]');
    expect(sidebar?.className).not.toContain('backdrop-blur');
    expect(sidebar?.className).toContain('rounded-l-xl');
    // 圆角缺口已经由 clip-path 取代，分隔线改成侧栏自己的一条 border-r。
    expect(sidebar?.className).toContain('border-r');
    expect(sidebar?.className).toContain('border-[hsl(var(--layout-divider))]');
  });

  it('三道平面各就各位：窗框(窗口面) < 侧栏 ≈ 内容面 < 抬高档', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const shell = document.querySelector('.app-shell');
    const section = document.querySelector('section');
    // 内容面外面那层「空气」：圆角缺口与四边留白露出来的就是它。
    const gutter = section?.parentElement;

    // 窗框最深，侧栏与内容面同属「面板」那一档 —— Codex 实测（深色）窗框 14 /
    // 侧栏 16 / 内容 17，面板之间只差 1 级，差出十几级就会读成「侧栏是个洞」。
    // 内容面因此取**表面种子**（`--background`），抬高的 `--surface-1` 留给
    // composer 这类真正浮在内容面之上的控件。
    expect(shell?.className).toContain('bg-[hsl(var(--chrome-bg))]');
    expect(gutter?.className).toContain('bg-[hsl(var(--chrome-bg))]');
    expect(section?.className).toContain('bg-[hsl(var(--background))]');
    expect(section?.className).not.toContain('bg-[hsl(var(--surface-1))]');
    expect(section?.className).not.toContain('bg-[hsl(var(--chrome-bg))]');
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

  it('内容面切角只看左边挨着谁：侧栏展开时直角贴边', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const section = document.querySelector('section');
    const clipped = section?.querySelector('.content-surface');

    expect(section?.dataset.contentSurface).toBe('true');
    // 侧栏展开 → 内容面贴着一块同样是面板的侧栏，直角贴边（Codex 实测：内容面
    // 左上角是直角，白色从侧栏分隔线那一列直接开始）。这里切圆角会在分隔线旁
    // 咬出一个露出窗口面的口子，看着像磕坏的一角。
    expect(section?.dataset.floats).toBe('false');
    // 外层负责圆角形状 + elevation，内层负责 clip-path —— clip-path 会把阴影一起裁掉。
    expect(section?.className).toContain('content-surface-root');
    expect(section?.className).toContain('shadow-elevation-content');
    expect(clipped).toBeTruthy();
    // 旧的「圆角缺口 + 手写 SVG 弧线」整套已经删除，源码里不该再有那段 SVG。
    expect(section?.querySelectorAll('svg[aria-hidden="true"] path')).toHaveLength(0);
  });

  it('侧栏收起后内容面左边是窗口面，这时才切左角', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    expect(document.querySelector('section')?.dataset.floats).toBe('false');

    fireEvent.click(document.querySelector('button[aria-label="收起侧栏"]')!);

    // 左边换成图标轨（窗口面）→ 圆角缺口里露出的窗口面与顶栏连成一片。
    expect(document.querySelector('section')?.dataset.floats).toBe('true');
  });

  it('浏览器形态不切角（内容面贴满视口）', () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser' });

    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    fireEvent.click(document.querySelector('button[aria-label="收起侧栏"]')!);

    expect(document.querySelector('section')?.dataset.floats).toBe('false');
  });

  it('窄屏抽屉形态不切角', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });

    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    expect(document.querySelector('section')?.dataset.floats).toBe('false');
  });

  it('窗口最大化后不切角', () => {
    windowState.maximized = true;

    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

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

  it('hides the rail on narrow and moves its entries into the drawer', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });

    render(
      <MainLayout sidebar={<div>sidebar</div>} navRailTarget="todo" onNavRailSelect={vi.fn()}>
        <div>content</div>
      </MainLayout>,
    );

    // 图标轨是桌面解法：它常驻的 56px 在窄屏上是纯损耗 —— 390px 的手机只剩 334px
    // 给内容。窄屏下整条轨不渲染，顶层视图切换与页脚三项改由抽屉承载。
    expect(document.querySelector('[data-testid="nav-rail"]')).toBeNull();

    const aside = document.querySelector('aside');
    expect(aside?.querySelector('[data-testid="narrow-nav-switcher"]')?.getAttribute('data-active')).toBe('todo');
    expect(aside?.querySelector('[data-testid="narrow-nav-footer"]')?.getAttribute('data-active')).toBe('todo');
    // 抽屉内三段：分段切换器在最上、上下文侧栏居中、页脚钉在最下。
    expect(aside?.firstElementChild?.getAttribute('data-testid')).toBe('narrow-nav-switcher');
    expect(aside?.lastElementChild?.getAttribute('data-testid')).toBe('narrow-nav-footer');
  });

  it('keeps the narrow drawer chrome-free when the app supplies no nav target', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });

    render(
      <MainLayout sidebar={<div>sidebar</div>}>
        <div>content</div>
      </MainLayout>,
    );

    const aside = document.querySelector('aside');
    expect(aside?.querySelector('[data-testid="narrow-nav-switcher"]')).toBeNull();
    expect(aside?.querySelector('[data-testid="narrow-nav-footer"]')).toBeNull();
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
