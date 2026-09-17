// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import { UpdaterProvider, useUpdaterContext } from './UpdaterProvider';

const { useUpdaterMock } = vi.hoisted(() => ({
  useUpdaterMock: vi.fn(() => ({
    stage: 'idle' as const,
    version: undefined,
    progress: undefined,
    error: undefined,
    checkForUpdates: vi.fn(),
    startUpdate: vi.fn(),
    relaunch: vi.fn(),
    resetToIdle: vi.fn(),
  })),
}));

vi.mock('./hooks/useUpdater', () => ({
  useUpdater: useUpdaterMock,
}));

describe('UpdaterProvider', () => {
  it('向子组件提供 updater 上下文', async () => {

    function Probe() {
      const updater = useUpdaterContext();
      return <div>阶段：{updater.stage}</div>;
    }

    render(
      <UpdaterProvider>
        <Probe />
      </UpdaterProvider>,
    );

    expect(screen.getByText('阶段：idle')).toBeTruthy();
    expect(useUpdaterMock).toHaveBeenCalledTimes(1);
  });
});
