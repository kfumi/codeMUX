// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ImportCandidate } from '../../types/historyImport';
import { ImportSessionsDialog } from './ImportSessionsDialog';

const { discoverMock, fetchSessionsMock, fetchArchivedSessionsMock } = vi.hoisted(() => ({
  discoverMock: vi.fn(),
  fetchSessionsMock: vi.fn(),
  fetchArchivedSessionsMock: vi.fn(),
}));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    historyImport: {
      discover: discoverMock,
      import: vi.fn(),
    },
  },
}));

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: (state: {
    fetchSessions: typeof fetchSessionsMock;
    fetchArchivedSessions: typeof fetchArchivedSessionsMock;
  }) => unknown) => selector({
    fetchSessions: fetchSessionsMock,
    fetchArchivedSessions: fetchArchivedSessionsMock,
  }),
}));

const candidate: ImportCandidate = {
  key: 'old-scan-candidate',
  agentKind: 'claude_code',
  agentSessionId: 'old-session',
  title: '旧扫描结果',
  cwd: 'C:\\work\\project',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sourceLocator: 'old-session',
  sourceFingerprint: 'old-fingerprint',
  eventCount: 1,
  alreadyImported: false,
  warnings: [],
};

const props = {
  projectId: 'project-1',
  projectPath: 'C:\\work\\project',
  projectName: '测试项目',
  onOpenChange: vi.fn(),
};

describe('ImportSessionsDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('关闭并重开后忽略旧扫描响应', async () => {
    let resolveScan!: (items: ImportCandidate[]) => void;
    const pendingScan = new Promise<ImportCandidate[]>((resolve) => {
      resolveScan = resolve;
    });
    discoverMock.mockReturnValue(pendingScan);

    const { rerender } = render(<ImportSessionsDialog {...props} open />);
    fireEvent.click(screen.getByRole('button', { name: '扫描 Claude Code' }));
    expect(discoverMock).toHaveBeenCalledWith('claude_code');

    rerender(<ImportSessionsDialog {...props} open={false} />);
    rerender(<ImportSessionsDialog {...props} open />);

    await act(async () => {
      resolveScan([candidate]);
      await pendingScan;
    });

    await waitFor(() => {
      expect(screen.getByText('准备扫描 Claude Code')).toBeTruthy();
      expect(screen.queryByText('旧扫描结果')).toBeNull();
      expect((screen.getByRole('button', { name: '扫描 Claude Code' }) as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
