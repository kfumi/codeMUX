// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompanionStatus } from '../types/companion';
import { companionViaDaemon } from '../lib/facades/daemon-facade';
import { useCompanionStatus } from './useCompanionStatus';

vi.mock('../lib/facades/daemon-facade', () => ({
  companionViaDaemon: {
    getStatus: vi.fn(),
    setEnabled: vi.fn(),
    refreshPairingCode: vi.fn(),
    setRelayEnabled: vi.fn(),
    setRelayConfig: vi.fn(),
  },
}));

function companionStatus(partial: Partial<CompanionStatus> = {}): CompanionStatus {
  return {
    enabled: false,
    daemonReady: true,
    daemonError: null,
    port: 9240,
    desktopId: 'cmx_desktop_test',
    lanIp: '192.168.1.3',
    pairingCode: null,
    pairingCodeExpiresAt: null,
    pairedDevices: [],
    relay: {
      enabled: false,
      endpoint: '',
      useTls: false,
      connectionState: 'disabled',
      desktopPublicKeyB64: null,
    },
    ...partial,
  };
}

describe('useCompanionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('展示错误时去掉 Error: 前缀', async () => {
    vi.mocked(companionViaDaemon.getStatus).mockRejectedValue(
      new Error('Daemon request failed: 405'),
    );

    const { result } = renderHook(() => useCompanionStatus({ polling: false }));

    await waitFor(() => expect(result.current.error).toBe('Daemon request failed: 405'));
  });

  it('开关响应直接成为新状态', async () => {
    vi.mocked(companionViaDaemon.getStatus).mockResolvedValue(companionStatus());
    vi.mocked(companionViaDaemon.setEnabled).mockResolvedValue(
      companionStatus({ enabled: true, pairingCode: '123456' }),
    );

    const { result } = renderHook(() => useCompanionStatus({ polling: false }));
    await waitFor(() => expect(result.current.status?.enabled).toBe(false));

    await act(async () => {
      await result.current.setEnabled(true);
    });

    expect(companionViaDaemon.setEnabled).toHaveBeenCalledWith(true);
    expect(result.current.status?.enabled).toBe(true);
    expect(result.current.status?.pairingCode).toBe('123456');
    expect(result.current.busy).toBe(false);
  });
});
