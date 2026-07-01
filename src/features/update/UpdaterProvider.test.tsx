// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const useUpdaterMock = vi.fn(() => ({
  stage: 'idle' as const,
  version: undefined,
  progress: undefined,
  error: undefined,
  checkForUpdates: vi.fn(),
  startUpdate: vi.fn(),
  relaunch: vi.fn(),
  resetToIdle: vi.fn(),
}));

vi.mock('./hooks/useUpdater', () => ({
  useUpdater: useUpdaterMock,
}));

describe('UpdaterProvider', () => {
  it('向子组件提供 updater 上下文', async () => {
    const { UpdaterProvider, useUpdaterContext } = await import('./UpdaterProvider');

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
