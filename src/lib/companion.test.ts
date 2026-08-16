import { describe, expect, it } from 'vitest';

import { buildPairingUrl } from './companion';
import { parseCompanionOfferFromUrl } from './companion-connection';
import type { CompanionStatus } from '../types/companion';

describe('buildPairingUrl', () => {
  it('builds offer fragment URLs when desktop id is present', () => {
    const status: CompanionStatus = {
      enabled: true,
      port: 9240,
      desktopId: 'cmx_desktop_test',
      lanIp: '192.168.1.10',
      pairingCode: '123456',
      pairedDevices: [],
    };
    const url = buildPairingUrl(status);
    expect(url).toMatch(/^http:\/\/192\.168\.1\.10:9240\/#offer=/);
    const offer = parseCompanionOfferFromUrl(url!);
    expect(offer?.desktopId).toBe('cmx_desktop_test');
    expect(offer?.pairingCode).toBe('123456');
  });

  it('returns null without desktop id', () => {
    const status: CompanionStatus = {
      enabled: true,
      port: 9240,
      lanIp: '192.168.1.10',
      pairingCode: '123456',
      pairedDevices: [],
    };
    expect(buildPairingUrl(status)).toBeNull();
  });
});
