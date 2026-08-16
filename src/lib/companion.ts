import { buildCompanionOfferUrl } from './companion-connection';
import type { CompanionOfferV1 } from './companion-connection';
import type { CompanionStatus, PairedDevice } from '../types/companion';

export type CompanionVisualState = 'idle' | 'waiting' | 'reconnecting' | 'paired';

const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const COMPANION_DEVICE_ONLINE_THRESHOLD_MS = 3 * 60_000;

export function isPairedDeviceOnline(device: PairedDevice, now = Date.now()): boolean {
  if (!device.last_seen_at) return false;
  const lastSeen = new Date(device.last_seen_at).getTime();
  if (Number.isNaN(lastSeen)) return false;
  return now - lastSeen <= COMPANION_DEVICE_ONLINE_THRESHOLD_MS;
}

export function getCompanionVisualState(status: CompanionStatus | null): CompanionVisualState {
  if (!status?.enabled) return 'idle';
  if (status.pairedDevices.length === 0) return 'waiting';
  if (status.pairedDevices.some((device) => isPairedDeviceOnline(device))) return 'paired';
  return 'reconnecting';
}

export function buildPairingOfferFromStatus(status: CompanionStatus): CompanionOfferV1 | null {
  if (!status.pairingCode || !status.desktopId) return null;

  const offer: CompanionOfferV1 = {
    v: 1,
    desktopId: status.desktopId,
    pairingCode: status.pairingCode,
    expiresAt: status.pairingCodeExpiresAt
      ?? new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString(),
  };

  if (status.lanIp) {
    offer.lan = { host: status.lanIp, port: status.port };
  }

  if (status.relay?.enabled) {
    offer.relay = {
      endpoint: status.relay.endpoint,
      useTls: status.relay.useTls,
    };
    if (status.relay.desktopPublicKeyB64) {
      offer.desktopPublicKeyB64 = status.relay.desktopPublicKeyB64;
    }
  }

  return offer;
}

export function buildPairingUrl(status: CompanionStatus): string | null {
  const offer = buildPairingOfferFromStatus(status);
  if (!offer) return null;

  if (status.lanIp) {
    const baseUrl = `http://${status.lanIp}:${status.port}`;
    return buildCompanionOfferUrl(offer, baseUrl);
  }

  if (status.relay?.enabled) {
    return buildCompanionOfferUrl(offer, `http://127.0.0.1:${status.port}`);
  }

  return null;
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
    online: isPairedDeviceOnline(device),
  };
}

export function relayStateLabel(state: CompanionStatus['relay']['connectionState']): string {
  switch (state) {
    case 'connected':
      return '已连接';
    case 'connecting':
      return '重连中';
    case 'error':
      return '连接失败';
    default:
      return '未启用';
  }
}

export function companionVisualStateLabel(state: CompanionVisualState): string {
  switch (state) {
    case 'paired':
      return '设备在线';
    case 'reconnecting':
      return '等待设备重连';
    case 'waiting':
      return '等待手机连接';
    default:
      return '未开启';
  }
}
