// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebPairingConfirmHost } from './WebPairingConfirmHost';

type ShellHandler = (payload: unknown) => void;

const shellSubscribe = vi.hoisted(() => vi.fn((_name: string, handler: ShellHandler) => {
  subscribers.push(handler);
  return () => {
    subscribers = subscribers.filter((item) => item !== handler);
  };
}));
let subscribers: ShellHandler[] = [];
const decideLocalPairing = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/bootstrap/shell-event-bridge', () => ({
  shellEventBridge: { available: true, subscribe: shellSubscribe },
}));
vi.mock('@/lib/facades/daemon-facade', () => ({ daemonFacade: { decideLocalPairing } }));
vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void;
    onOpenChange: (open: boolean) => void;
  }) => (open ? (
    <div>
      <p>{title}</p>
      <p>{description}</p>
      <button type="button" onClick={onConfirm}>confirm</button>
      <button type="button" onClick={() => onOpenChange(false)}>dismiss</button>
    </div>
  ) : null),
}));

function emit(payload: unknown): void {
  act(() => {
    for (const handler of subscribers) handler(payload);
  });
}

beforeEach(() => {
  subscribers = [];
  shellSubscribe.mockClear();
  decideLocalPairing.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('WebPairingConfirmHost', () => {
  it('subscribes to the shell event bridge', () => {
    render(<WebPairingConfirmHost />);
    expect(shellSubscribe).toHaveBeenCalledWith('web-pairing-request', expect.any(Function));
  });

  it('asks for confirmation and approves the pending loopback request', async () => {
    render(<WebPairingConfirmHost />);

    emit({
      requestId: 'req-1',
      code: '482913',
      name: 'Chrome · Windows',
      desktopId: 'desktop-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(screen.getByText('浏览器请求本机访问')).toBeTruthy();
    expect(screen.getByText(/Chrome · Windows/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    });
    expect(decideLocalPairing).toHaveBeenCalledWith('req-1', true);
    expect(screen.queryByText('浏览器请求本机访问')).toBeNull();
  });

  it('denies the request when the dialog is dismissed', async () => {
    render(<WebPairingConfirmHost />);

    emit({
      requestId: 'req-2',
      code: '111111',
      name: 'Safari',
      desktopId: 'desktop-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    });
    expect(decideLocalPairing).toHaveBeenCalledWith('req-2', false);
  });

  it('ignores malformed and already expired requests', () => {
    render(<WebPairingConfirmHost />);

    emit({ requestId: '', code: '482913' });
    emit({ requestId: 'stale', code: '482913', expiresAt: new Date(Date.now() - 1000).toISOString() });
    emit('not-an-object');

    expect(screen.queryByText('浏览器请求本机访问')).toBeNull();
    expect(decideLocalPairing).not.toHaveBeenCalled();
  });
});
