import { describe, expect, it } from 'vitest';

import {
  buildPairingUrl,
  getCompanionVisualState,
  isPairedDeviceOnline,
} from './companion';
import { parseCompanionOfferFromUrl } from './companion-connection';
import type { CompanionStatus } from '../types/companion';

const baseStatus: CompanionStatus = {
  enabled: true,
  port: 9240,
  desktopId: 'cmx_desktop_test',
  lanIp: '192.168.1.10',
  pairingCode: '123456',
  pairingCodeExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  pairedDevices: [],
  relay: {
    enabled: false,
    endpoint: '',
    useTls: false,
    connectionState: 'disabled',
  },
};

describe('buildPairingUrl', () => {
  it('builds offer fragment URLs when desktop id is present', () => {
    const url = buildPairingUrl(baseStatus);
    expect(url).toMatch(/^http:\/\/192\.168\.1\.10:9240\/#offer=/);
    const offer = parseCompanionOfferFromUrl(url!);
    expect(offer?.desktopId).toBe('cmx_desktop_test');
    expect(offer?.pairingCode).toBe('123456');
  });

  it('returns null without desktop id', () => {
    const status: CompanionStatus = {
      ...baseStatus,
      desktopId: undefined,
    };
    expect(buildPairingUrl(status)).toBeNull();
  });

  it('uses relay base url when relay is enabled', () => {
    const status: CompanionStatus = {
      ...baseStatus,
      relay: {
        enabled: true,
        endpoint: 'relay.fumi-blog.top:443',
        useTls: true,
        connectionState: 'connected',
      },
    };
    const url = buildPairingUrl(status);
    expect(url).toMatch(/^https:\/\/relay\.fumi-blog\.top:443\/#offer=/);
    const offer = parseCompanionOfferFromUrl(url!);
    expect(offer?.lan?.host).toBe('192.168.1.10');
    expect(offer?.relay?.endpoint).toBe('relay.fumi-blog.top:443');
  });
});

describe('getCompanionVisualState', () => {
  it('shows reconnecting when devices exist but are offline', () => {
    const status: CompanionStatus = {
      ...baseStatus,
      pairedDevices: [{
        id: 'dev-1',
        name: 'Phone',
        paired_at: new Date().toISOString(),
        last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      }],
    };
    expect(getCompanionVisualState(status)).toBe('reconnecting');
  });

  it('shows paired when a device was seen recently', () => {
    const status: CompanionStatus = {
      ...baseStatus,
      pairedDevices: [{
        id: 'dev-1',
        name: 'Phone',
        paired_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      }],
    };
    expect(getCompanionVisualState(status)).toBe('paired');
    expect(isPairedDeviceOnline(status.pairedDevices[0]!)).toBe(true);
  });
});
