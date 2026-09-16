// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 捕获 onDidUpdateDiff 回调与最新 props,供用例模拟「worker 算完 diff」并断言传参。
const mocks = vi.hoisted(() => ({
  diffUpdateListeners: [] as Array<() => void>,
  lastProps: null as Record<string, unknown> | null,
}));

// Monaco 在 jsdom 里跑不起来,替换 @monaco-editor/react 的 DiffEditor:
// 挂载时同步走一次 onMount,把编辑器实例的 diff 事件注册口交给用例驱动。
vi.mock('@monaco-editor/react', async () => {
  const { useEffect } = await import('react');
  return {
    loader: { config: vi.fn() },
    DiffEditor: (props: Record<string, unknown> & { onMount?: (editor: unknown, monaco: unknown) => void }) => {
      mocks.lastProps = props;
      useEffect(() => {
        props.onMount?.(
          {
            onDidUpdateDiff: (cb: () => void) => {
              mocks.diffUpdateListeners.push(cb);
              return { dispose: () => {} };
            },
          },
          { editor: { defineTheme: vi.fn(), setTheme: vi.fn(), remeasureFonts: vi.fn() } },
        );
      }, []);
      return <div data-testid="diff-editor-mock" />;
    },
  };
});

import MonacoDiffView from './MonacoDiffView';

function triggerDiffUpdated() {
  act(() => {
    for (const listener of [...mocks.diffUpdateListeners]) listener();
  });
}

function stubImmediateAnimationFrame() {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
}

describe('MonacoDiffView diff 就绪门控', () => {
  afterEach(() => {
    cleanup();
    mocks.diffUpdateListeners.length = 0;
    mocks.lastProps = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('diff 算完且两帧渲染后才露出编辑器', () => {
    const frameQueue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frameQueue.push(cb);
      return frameQueue.length;
    });
    render(<MonacoDiffView oldContent={'a\nb'} newContent={'a\nc'} filePath="/repo/app.ts" />);

    // 事件触发:事务里折叠已生效,但 Monaco 渲染在下一帧 —— 此刻必须仍是占位。
    triggerDiffUpdated();
    expect(screen.getByText('Diff 计算中')).toBeTruthy();

    act(() => { frameQueue.shift()!(0); });
    expect(screen.getByText('Diff 计算中')).toBeTruthy();

    act(() => { frameQueue.shift()!(0); });
    expect(screen.queryByText('Diff 计算中')).toBeNull();
    const shell = screen.getByTestId('diff-editor-mock').parentElement as HTMLElement;
    expect(shell.className).not.toContain('invisible');
  });

  it('事件不来时兜底定时器到点也会露出编辑器', () => {
    vi.useFakeTimers();
    render(<MonacoDiffView oldContent="a" newContent="b" />);

    expect(screen.getByText('Diff 计算中')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.queryByText('Diff 计算中')).toBeNull();
  });

  it('内容原位更新后重新进入计算态', () => {
    stubImmediateAnimationFrame();
    const { rerender } = render(<MonacoDiffView oldContent="a" newContent="b" />);

    triggerDiffUpdated();
    expect(screen.queryByText('Diff 计算中')).toBeNull();

    rerender(<MonacoDiffView oldContent="a" newContent="c" />);
    expect(screen.getByText('Diff 计算中')).toBeTruthy();

    triggerDiffUpdated();
    expect(screen.queryByText('Diff 计算中')).toBeNull();
  });

  it('viewMode 控制 renderSideBySide,默认并排,且不被窄容器降级', () => {
    stubImmediateAnimationFrame();
    const { rerender } = render(<MonacoDiffView oldContent="a" newContent="b" />);

    expect(mocks.lastProps?.options).toMatchObject({
      renderSideBySide: true,
      // 显式切换必须说了算:Monaco 默认在 ≤900px 时自动降级内联,必须关掉。
      useInlineViewWhenSpaceIsLimited: false,
    });

    rerender(<MonacoDiffView oldContent="a" newContent="b" viewMode="unified" />);
    expect((mocks.lastProps?.options as { renderSideBySide?: boolean }).renderSideBySide).toBe(false);

    rerender(<MonacoDiffView oldContent="a" newContent="b" viewMode="split" />);
    expect((mocks.lastProps?.options as { renderSideBySide?: boolean }).renderSideBySide).toBe(true);
  });
});
