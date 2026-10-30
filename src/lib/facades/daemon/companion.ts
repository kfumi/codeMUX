import type { CompanionStatus } from '../../../types/companion';
import { ensureDaemonClient } from './lifecycle';

/**
 * Companion(移动伴侣配对):走 daemon client 的 /api/companion/* 管理面
 * (daemon 限回环来源 + Local Daemon Token)。
 */
export const companion = {
  decideLocalPairing: async (requestId: string, approve: boolean) => {
    await (await ensureDaemonClient()).decideLocalPairing(requestId, approve);
  },
  getStatus: async (): Promise<CompanionStatus> =>
    (await ensureDaemonClient()).companionGetStatus() as Promise<CompanionStatus>,
  setEnabled: async (enabled: boolean): Promise<CompanionStatus> =>
    (await ensureDaemonClient()).companionSetEnabled(enabled) as Promise<CompanionStatus>,
  refreshPairingCode: async (): Promise<CompanionStatus> =>
    (await ensureDaemonClient()).companionRefreshPairingCode() as Promise<CompanionStatus>,
  setRelayEnabled: async (enabled: boolean): Promise<CompanionStatus> =>
    (await ensureDaemonClient()).companionSetRelayEnabled(enabled) as Promise<CompanionStatus>,
  setRelayConfig: async (endpoint: string, useTls: boolean): Promise<CompanionStatus> =>
    (await ensureDaemonClient()).companionSetRelayConfig(endpoint, useTls) as Promise<CompanionStatus>,
};

export type CompanionDomain = typeof companion;
