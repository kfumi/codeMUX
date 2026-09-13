// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDaemonConnectionStore } from '@/stores/daemonConnectionStore';

import { HostBootstrapGate } from './HostBootstrapGate';

const bootstrapDaemonConnection = vi.hoisted(() => vi.fn(async () => {}));
const pairingScreen = vi.hoisted(() => vi.fn(() => <div data-testid="pairing-screen" />));

vi.mock('@/lib/bootstrap', () => ({ bootstrapDaemonConnection }));
vi.mock('./PairingScreen', () => ({ PairingScreen: pairingScreen }));

beforeEach(() => {
  bootstrapDaemonConnection.mockClear();
  pairingScreen.mockClear();
});

afterEach(() => {
  cleanup();
  useDaemonConnectionStore.setState({
    hostForm: 'browser',
    status: 'idle',
    strategy: null,
    error: null,
    pairing: null,
  });
});

describe('HostBootstrapGate', () => {
  it('renders the app directly in the desktop shell and still boots in background', () => {
    useDaemonConnectionStore.setState({ hostForm: 'desktop', status: 'idle' });

    render(
      <HostBootstrapGate>
        <div data-testid="app" />
      </HostBootstrapGate>,
    );

    expect(screen.getByTestId('app')).toBeTruthy();
    expect(screen.queryByTestId('pairing-screen')).toBeNull();
    // 桌面形态不缺省拦截界面,但引导仍要跑(负责壳桥注入的连接)。
    expect(bootstrapDaemonConnection).toHaveBeenCalledTimes(1);
  });

  it('holds the browser host on a loading state while connecting', () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser', status: 'connecting' });

    render(
      <HostBootstrapGate>
        <div data-testid="app" />
      </HostBootstrapGate>,
    );

    expect(screen.queryByTestId('app')).toBeNull();
    expect(screen.getByText('正在连接 CodeMUX 后台服务…')).toBeTruthy();
  });

  it('releases the app once the browser host is connected', () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser', status: 'connected' });

    render(
      <HostBootstrapGate>
        <div data-testid="app" />
      </HostBootstrapGate>,
    );

    expect(screen.getByTestId('app')).toBeTruthy();
    expect(screen.queryByTestId('pairing-screen')).toBeNull();
  });

  it('shows the pairing screen instead of a broken shell when no connection exists', () => {
    useDaemonConnectionStore.setState({ hostForm: 'mobile', status: 'pairing' });

    render(
      <HostBootstrapGate>
        <div data-testid="app" />
      </HostBootstrapGate>,
    );

    expect(screen.getByTestId('pairing-screen')).toBeTruthy();
    expect(screen.queryByTestId('app')).toBeNull();
  });
});
