// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDaemonConnectionStore } from '@/stores/daemonConnectionStore';

import { PairingScreen } from './PairingScreen';

const startLoopbackPairing = vi.hoisted(() => vi.fn(async () => {}));
const submitRemotePairing = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/bootstrap', () => ({ startLoopbackPairing, submitRemotePairing }));

beforeEach(() => {
  startLoopbackPairing.mockClear();
  submitRemotePairing.mockClear();
});

afterEach(() => {
  cleanup();
  useDaemonConnectionStore.getState().reset();
});

describe('PairingScreen', () => {
  it('explains the same-machine shortcut and triggers the confirmation request', () => {
    useDaemonConnectionStore.getState().setPairingMode('loopback');

    render(<PairingScreen />);

    expect(screen.getByText('本机浏览器需要一次确认即可使用，无需复制令牌。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /在本机浏览器使用/ }));
    expect(startLoopbackPairing).toHaveBeenCalledTimes(1);
  });

  it('shows the confirmation code and stops offering a fresh request while waiting', () => {
    useDaemonConnectionStore.getState().setPairingMode('loopback');
    useDaemonConnectionStore.getState().setPairingWaiting({
      requestId: 'req-1',
      code: '482913',
      expiresAt: '2026-09-13T00:03:00.000Z',
      desktopId: 'desktop-1',
    });

    render(<PairingScreen />);

    expect(screen.getByText('482913')).toBeTruthy();
    expect(screen.getByRole('button', { name: /重新发起/ })).toBeTruthy();
    expect(startLoopbackPairing).not.toHaveBeenCalled();
  });

  it('surfaces the denial reason from the desktop side', () => {
    useDaemonConnectionStore.getState().setPairingMode('loopback');
    useDaemonConnectionStore.getState().setPairingFailure('桌面端拒绝了本次配对');

    render(<PairingScreen />);

    expect(screen.getAllByText('桌面端拒绝了本次配对').length).toBeGreaterThan(0);
  });

  it('claims a remote pairing code with the typed desktop address', () => {
    useDaemonConnectionStore.getState().setPairingMode('remote');

    render(<PairingScreen />);

    fireEvent.change(screen.getByLabelText('配对码'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('桌面端地址（可选）'), {
      target: { value: '192.168.1.8:9240' },
    });
    fireEvent.click(screen.getByRole('button', { name: /配对$/ }));

    expect(submitRemotePairing).toHaveBeenCalledWith({
      code: '123456',
      baseUrl: '192.168.1.8:9240',
      link: '',
    });
  });

  it('keeps the claim button disabled until pairing input exists', () => {
    useDaemonConnectionStore.getState().setPairingMode('remote');

    render(<PairingScreen />);

    const button = screen.getByRole('button', { name: /配对$/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(submitRemotePairing).not.toHaveBeenCalled();
  });
});
