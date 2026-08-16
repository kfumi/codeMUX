import { buildCompanionOfferUrl } from './companion-connection';
import type { CompanionStatus, PairedDevice } from '../types/companion';

export type CompanionVisualState = 'idle' | 'waiting' | 'paired';

const PAIRING_CODE_TTL_MS = 5 * 60_000;

export function getCompanionVisualState(status: CompanionStatus | null): CompanionVisualState {
  if (!status?.enabled) return 'idle';
  if (status.pairedDevices.length > 0) return 'paired';
  return 'waiting';
}

export function buildPairingUrl(status: CompanionStatus): string | null {
  if (!status.lanIp || !status.pairingCode || !status.desktopId) return null;
  const baseUrl = `http://${status.lanIp}:${status.port}`;
  return buildCompanionOfferUrl(
    {
      v: 1,
      desktopId: status.desktopId,
      pairingCode: status.pairingCode,
      lan: { host: status.lanIp, port: status.port },
      expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString(),
    },
    baseUrl,
  );
}

/** @deprecated Legacy query-param URL for backward compatibility during transition. */
export function buildLegacyPairingUrl(status: CompanionStatus): string | null {
  if (!status.lanIp || !status.pairingCode) return null;
  const url = new URL(`http://${status.lanIp}:${status.port}/`);
  url.searchParams.set('code', status.pairingCode);
  return url.toString();
}

export function formatRelativeTime(value: string): string {
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return '刚刚';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} 小时前`;
  return date.toLocaleString();
}

export function formatDeviceDetails(device: PairedDevice) {
  return {
    id: device.id,
    pairedAt: new Date(device.paired_at).toLocaleString(),
    lastSeen: device.last_seen_at ? formatRelativeTime(device.last_seen_at) : '尚未请求',
  };
}
