import { describe, expect, it } from 'vitest';

import {
  buildCompanionOfferUrl,
  decodeOfferFragmentPayload,
  encodeOfferFragment,
  isCompanionOfferExpired,
  parseCompanionOffer,
  parseCompanionOfferFromUrl,
  parsePairingInput,
} from './codec';
import {
  connectionIdForLan,
  migrateLegacyConnection,
  normalizeStoredConnection,
  profileToLegacyConnection,
} from './profile';
import {
  buildRestUrl,
  buildWsUrl,
  connectionBaseUrl,
  resolveActiveConnection,
} from './transport';
import type { CompanionConnectionProfile, CompanionOfferV1 } from './types';

const sampleOffer: CompanionOfferV1 = {
  v: 1,
  desktopId: 'cmx_desktop_abc123',
  pairingCode: '123456',
  lan: { host: '192.168.1.10', port: 9240 },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

describe('companion offer codec', () => {
  it('round-trips offer through fragment encoding', () => {
    const encoded = encodeOfferFragment(sampleOffer);
    const decoded = decodeOfferFragmentPayload(encoded);
    expect(parseCompanionOffer(decoded)).toEqual(sampleOffer);
  });

  it('builds offer URL with hash fragment', () => {
    const url = buildCompanionOfferUrl(sampleOffer, 'http://192.168.1.10:9240');
    expect(url).toMatch(/^http:\/\/192\.168\.1\.10:9240\/#offer=/);
    expect(parseCompanionOfferFromUrl(url)).toEqual(sampleOffer);
  });

  it('rejects malformed fragment payload', () => {
    expect(() => decodeOfferFragmentPayload('not-valid-base64!!!')).toThrow();
    expect(() => parseCompanionOffer({ v: 2 })).toThrow();
  });

  it('detects expired offers', () => {
    const expired: CompanionOfferV1 = {
      ...sampleOffer,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    expect(isCompanionOfferExpired(expired)).toBe(true);
    expect(isCompanionOfferExpired(sampleOffer)).toBe(false);
    expect(isCompanionOfferExpired({ ...sampleOffer, expiresAt: undefined })).toBe(false);
  });
});

describe('parsePairingInput', () => {
  it('parses new offer fragment URLs', () => {
    const url = buildCompanionOfferUrl(sampleOffer, 'http://192.168.1.10:9240');
    const parsed = parsePairingInput(url);
    expect(parsed).toEqual({
      baseUrl: 'http://192.168.1.10:9240',
      pairingCode: '123456',
      desktopId: 'cmx_desktop_abc123',
      offer: sampleOffer,
    });
  });

  it('parses legacy query URLs', () => {
    const parsed = parsePairingInput('http://192.168.1.20:9240/?code=654321');
    expect(parsed.baseUrl).toBe('http://192.168.1.20:9240');
    expect(parsed.pairingCode).toBe('654321');
    expect(parsed.offer).toBeUndefined();
  });

  it('uses page origin when offer omits lan host', () => {
    const offer: CompanionOfferV1 = {
      v: 1,
      desktopId: 'cmx_desktop_xyz',
      pairingCode: '111222',
    };
    const url = buildCompanionOfferUrl(offer, 'http://10.0.0.5:9240');
    const parsed = parsePairingInput(url, 'http://10.0.0.5:9240');
    expect(parsed.baseUrl).toBe('http://10.0.0.5:9240');
    expect(parsed.pairingCode).toBe('111222');
  });

  it('parses legacy host/port query params', () => {
    const parsed = parsePairingInput('http://localhost/?code=999888&host=192.168.1.30&port=9240');
    expect(parsed.baseUrl).toBe('http://192.168.1.30:9240');
    expect(parsed.pairingCode).toBe('999888');
  });
});

describe('profile migration', () => {
  it('migrates legacy connection to lan profile', () => {
    const profile = migrateLegacyConnection({
      baseUrl: 'http://192.168.1.10:9240',
      token: 'cmx_tok',
      deviceId: 'dev-1',
    });
    expect(profile.desktopId).toMatch(/^legacy:/);
    expect(profile.connections).toEqual([
      { id: connectionIdForLan('http://192.168.1.10:9240'), type: 'lan', baseUrl: 'http://192.168.1.10:9240' },
    ]);
    expect(profileToLegacyConnection(profile)).toEqual({
      baseUrl: 'http://192.168.1.10:9240',
      token: 'cmx_tok',
      deviceId: 'dev-1',
      desktopId: profile.desktopId,
    });
  });

  it('normalizes stored profile records', () => {
    const profile: CompanionConnectionProfile = {
      desktopId: 'cmx_desktop_abc',
      deviceId: 'd1',
      token: 't1',
      connections: [{ id: 'lan:1', type: 'lan', baseUrl: 'http://a:9240' }],
    };
    expect(normalizeStoredConnection(profile)).toEqual(profile);
  });
});

describe('transport resolution', () => {
  const profile: CompanionConnectionProfile = {
    desktopId: 'cmx_desktop_abc',
    deviceId: 'd1',
    token: 'tok',
    connections: [
      { id: 'direct:1', type: 'direct', host: '100.64.0.1', port: 9240, useTls: false },
      { id: 'lan:1', type: 'lan', baseUrl: 'http://192.168.1.10:9240' },
    ],
  };

  it('prefers reachable direct over lan', () => {
    const active = resolveActiveConnection(profile, {
      'direct:1': true,
      'lan:1': true,
    });
    expect(active.type).toBe('direct');
  });

  it('falls back to lan when direct is unreachable', () => {
    const active = resolveActiveConnection(profile, {
      'direct:1': false,
      'lan:1': true,
    });
    expect(active.type).toBe('lan');
  });

  it('builds REST and WS URLs for lan', () => {
    const lan = profile.connections[1];
    expect(buildRestUrl(lan, '/api/health')).toBe('http://192.168.1.10:9240/api/health');
    expect(buildWsUrl(lan, 'tok', 'sess-1')).toBe(
      'ws://192.168.1.10:9240/api/ws?token=tok&sessionId=sess-1',
    );
  });

  it('builds relay placeholder base URL', () => {
    const relay = {
      id: 'relay:1',
      type: 'relay' as const,
      endpoint: 'relay.example:443',
      useTls: true,
      desktopPublicKeyB64: 'abc',
    };
    expect(connectionBaseUrl(relay)).toBe('relay://relay.example:443');
  });
});
