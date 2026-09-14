import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCompanionOfferUrl, type CompanionConnectionProfile } from '../companion-connection';
import {
  bootstrapDaemonConnection,
  classifyBootstrapTarget,
  describeBrowserDevice,
  hasPairingInput,
  profileToConnectionConfig,
  resolveDaemonConnectionConfig,
  resolveRemotePairingInput,
  stripPairingInputFromUrl,
} from './index';
import { CONNECTION_STORAGE_KEY, loadStoredProfile, saveStoredProfile } from './connection-storage';
import { isWebPairingRequestFresh, parseWebPairingRequest } from './pairing-requests';
import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bootstrap target classification', () => {
  it('keeps the shell bridge on the desktop path', () => {
    expect(classifyBootstrapTarget({
      hasShellBridge: true,
      isLoopbackOrigin: true,
      hasStoredProfile: true,
      hasPairingInput: true,
    })).toBe('shell');
  });

  it('prefers an existing pairing profile over pairing again', () => {
    expect(classifyBootstrapTarget({
      hasShellBridge: false,
      isLoopbackOrigin: true,
      hasStoredProfile: true,
      hasPairingInput: false,
    })).toBe('paired');
  });

  it('uses the loopback shortcut only for same-machine first visits', () => {
    expect(classifyBootstrapTarget({
      hasShellBridge: false,
      isLoopbackOrigin: true,
      hasStoredProfile: false,
      hasPairingInput: false,
    })).toBe('loopback-pairing');

    expect(classifyBootstrapTarget({
      hasShellBridge: false,
      isLoopbackOrigin: false,
      hasStoredProfile: false,
      hasPairingInput: false,
    })).toBe('remote-pairing');
  });

  it('treats a pairing link as a remote pairing attempt', () => {
    expect(classifyBootstrapTarget({
      hasShellBridge: false,
      isLoopbackOrigin: false,
      hasStoredProfile: false,
      hasPairingInput: true,
    })).toBe('remote-pairing');
  });
});

describe('pairing input detection', () => {
  it('detects offer fragments and legacy code queries', () => {
    const offer = {
      v: 1 as const,
      desktopId: 'cmx_desktop_abc',
      pairingCode: '123456',
      lan: { host: '192.168.1.10', port: 9240 },
    };
    expect(hasPairingInput(buildCompanionOfferUrl(offer, 'http://192.168.1.10:9240'))).toBe(true);
    expect(hasPairingInput('http://192.168.1.10:9240/?code=123456')).toBe(true);
    expect(hasPairingInput('http://192.168.1.10:9240/')).toBe(false);
  });

  it('strips the pairing fragment and query so a refresh does not re-claim', () => {
    expect(stripPairingInputFromUrl('http://192.168.1.10:9240/#offer=abc&keep=1'))
      .toBe('http://192.168.1.10:9240/');
    expect(stripPairingInputFromUrl('http://192.168.1.10:9240/?code=123456&tab=settings'))
      .toBe('http://192.168.1.10:9240/?tab=settings');
    expect(stripPairingInputFromUrl('http://127.0.0.1:9240/')).toBe('http://127.0.0.1:9240/');
  });
});

describe('describeBrowserDevice', () => {
  it('names the browser and platform for the paired-device list', () => {
    expect(describeBrowserDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0'))
      .toBe('Chrome · Windows');
    expect(describeBrowserDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1'))
      .toBe('Safari · iOS');
    expect(describeBrowserDevice('Mozilla/5.0 (Windows NT 10.0) Edg/124.0')).toBe('Edge · Windows');
    expect(describeBrowserDevice('')).toBe('浏览器');
  });
});

describe('resolveRemotePairingInput', () => {
  it('parses pasted pairing links', () => {
    const parsed = resolveRemotePairingInput({ link: 'http://192.168.1.20:9240/?code=654321' });
    expect(parsed.baseUrl).toBe('http://192.168.1.20:9240');
    expect(parsed.pairingCode).toBe('654321');
  });

  it('normalizes a manually typed code and host', () => {
    expect(resolveRemotePairingInput({ code: ' 123456 ', baseUrl: '192.168.1.30:9240' }))
      .toEqual({ baseUrl: 'http://192.168.1.30:9240', pairingCode: '123456' });

    expect(resolveRemotePairingInput({ code: '123456', pageOrigin: 'http://10.0.0.9:9240/' }))
      .toEqual({ baseUrl: 'http://10.0.0.9:9240', pairingCode: '123456' });
  });

  it('rejects incomplete manual input', () => {
    expect(() => resolveRemotePairingInput({})).toThrow(/配对码/);
    expect(() => resolveRemotePairingInput({ code: '123456' })).toThrow(/桌面端地址/);
  });
});

describe('profileToConnectionConfig', () => {
  const base: CompanionConnectionProfile = {
    desktopId: 'cmx_desktop_abc',
    deviceId: 'device-1',
    token: 'cmx_tok',
    connections: [{ id: 'lan:1', type: 'lan', baseUrl: 'http://192.168.1.10:9240' }],
  };

  it('uses the direct/lan base url without a transport override', () => {
    const config = profileToConnectionConfig(base);
    expect(config.baseUrl).toBe('http://192.168.1.10:9240');
    expect(config.token).toBe('cmx_tok');
    expect(config.transport).toBeUndefined();
    expect(config.polling).toBeUndefined();
  });

  it('routes relay-only profiles through the shared transport with polling', () => {
    const relayProfile: CompanionConnectionProfile = {
      ...base,
      connections: [{
        id: 'relay:1',
        type: 'relay',
        endpoint: 'relay.example:443',
        useTls: true,
        desktopPublicKeyB64: 'abc',
      }],
    };
    const config = profileToConnectionConfig(relayProfile);
    expect(config.baseUrl).toBe('relay://relay.example:443');
    expect(config.polling).toBe(true);
    expect(config.transport).toBeDefined();
  });

  it('falls back to relay/polling when the direct connection is unreachable (user story 7)', () => {
    const hybridProfile: CompanionConnectionProfile = {
      ...base,
      connections: [
        { id: 'direct:1', type: 'direct', host: '192.168.1.10', port: 9240, useTls: false },
        {
          id: 'relay:1',
          type: 'relay',
          endpoint: 'relay.example:443',
          useTls: true,
          desktopPublicKeyB64: 'abc',
        },
      ],
    };

    // 直连探测失败 → resolveActiveConnection 跳过它选中继 → 轮询回退。
    const config = profileToConnectionConfig(hybridProfile, { 'direct:1': false });
    expect(config.baseUrl).toBe('relay://relay.example:443');
    expect(config.polling).toBe(true);
    expect(config.transport).toBeDefined();

    // 直连可达 → 维持直连,不开轮询。
    const direct = profileToConnectionConfig(hybridProfile, { 'direct:1': true });
    expect(direct.baseUrl).toBe('http://192.168.1.10:9240');
    expect(direct.polling).toBeUndefined();
  });

  it('resolveDaemonConnectionConfig probes reachability for multi-connection profiles', async () => {
    const hybridProfile: CompanionConnectionProfile = {
      desktopId: 'cmx_desktop_abc',
      deviceId: 'device-1',
      token: 'cmx_tok',
      connections: [
        { id: 'direct:1', type: 'direct', host: '192.168.1.10', port: 9240, useTls: false },
        {
          id: 'relay:1',
          type: 'relay',
          endpoint: 'relay.example:443',
          useTls: true,
          desktopPublicKeyB64: 'abc',
        },
      ],
    };
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      location: { protocol: 'http:' },
      setTimeout,
      clearTimeout,
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
    saveStoredProfile(hybridProfile);
    // 探测:direct 失败(/api/health 探不通),relay 恒可达。
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down');
    }));

    const config = await resolveDaemonConnectionConfig();
    expect(config.baseUrl).toBe('relay://relay.example:443');
    expect(config.polling).toBe(true);
  });

  it('resolveDaemonConnectionConfig skips probing for single-connection profiles', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      location: { protocol: 'http:' },
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
    saveStoredProfile(base);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const config = await resolveDaemonConnectionConfig();
    expect(config.baseUrl).toBe('http://192.168.1.10:9240');
    expect(config.polling).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('connection storage', () => {
  function stubStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
    return store;
  }

  it('round-trips a profile and migrates legacy records', () => {
    const store = stubStorage();
    const profile: CompanionConnectionProfile = {
      desktopId: 'cmx_desktop_abc',
      deviceId: 'device-1',
      token: 'cmx_tok',
      connections: [{ id: 'lan:1', type: 'lan', baseUrl: 'http://127.0.0.1:9240' }],
    };
    saveStoredProfile(profile);
    expect(loadStoredProfile()).toEqual(profile);

    store.set(CONNECTION_STORAGE_KEY, JSON.stringify({
      baseUrl: 'http://127.0.0.1:9240',
      token: 'legacy_tok',
    }));
    const migrated = loadStoredProfile();
    expect(migrated?.token).toBe('legacy_tok');
    expect(migrated?.desktopId).toMatch(/^legacy:/);
  });

  it('returns null for corrupt or missing storage', () => {
    const store = stubStorage();
    expect(loadStoredProfile()).toBeNull();
    store.set(CONNECTION_STORAGE_KEY, '{not json');
    expect(loadStoredProfile()).toBeNull();
  });
});

describe('web pairing request payload', () => {
  it('parses the daemon ui-event payload', () => {
    const request = parseWebPairingRequest({
      requestId: 'req-1',
      code: '123456',
      name: 'Chrome',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      desktopId: 'cmx_desktop_abc',
    });
    expect(request).not.toBeNull();
    expect(request?.name).toBe('Chrome');
    expect(isWebPairingRequestFresh(request!)).toBe(true);
  });

  it('rejects malformed payloads and expired requests', () => {
    expect(parseWebPairingRequest(null)).toBeNull();
    expect(parseWebPairingRequest({ code: '' })).toBeNull();

    const expired = {
      requestId: 'req-2',
      code: '123456',
      name: 'Chrome',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      desktopId: '',
    };
    expect(isWebPairingRequestFresh(expired)).toBe(false);
  });
});

describe('bootstrapDaemonConnection', () => {
  function stubBrowserWindow(input: { origin: string; href: string }) {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
      navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' },
      innerWidth: 1280,
      location: { origin: input.origin, href: input.href },
    });
  }

  afterEach(() => {
    useDaemonConnectionStore.getState().reset();
  });

  it('shows the simplified pairing prompt instead of crashing when the shell bridge is missing', async () => {
    stubBrowserWindow({ origin: 'http://127.0.0.1:9240', href: 'http://127.0.0.1:9240/' });

    await bootstrapDaemonConnection();

    const state = useDaemonConnectionStore.getState();
    expect(state.status).toBe('pairing');
    expect(state.pairing?.mode).toBe('loopback');
    expect(state.error).toBeNull();
  });

  it('asks for a LAN pairing code when the page is not on loopback', async () => {
    stubBrowserWindow({ origin: 'http://192.168.1.9:9240', href: 'http://192.168.1.9:9240/' });

    await bootstrapDaemonConnection();

    const state = useDaemonConnectionStore.getState();
    expect(state.status).toBe('pairing');
    expect(state.pairing?.mode).toBe('remote');
  });

  it('shares one run between concurrent callers (StrictMode double-mount)', async () => {
    stubBrowserWindow({ origin: 'http://127.0.0.1:9240', href: 'http://127.0.0.1:9240/' });

    const first = bootstrapDaemonConnection();
    const second = bootstrapDaemonConnection();
    expect(second).toBe(first);
    await first;

    // 跑完即释放,失败重试/手工重跑仍能再次引导。
    const third = bootstrapDaemonConnection();
    expect(third).not.toBe(first);
    await third;
  });
});
