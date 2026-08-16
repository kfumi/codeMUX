export interface PairedDevice {
  id: string;
  name: string;
  paired_at: string;
  last_seen_at?: string | null;
}

export type CompanionRelayConnectionState = 'disabled' | 'connecting' | 'connected' | 'error';

export interface CompanionRelayStatus {
  enabled: boolean;
  endpoint: string;
  useTls: boolean;
  connectionState: CompanionRelayConnectionState;
  desktopPublicKeyB64?: string | null;
}

export interface CompanionStatus {
  enabled: boolean;
  port: number;
  desktopId?: string | null;
  lanIp?: string | null;
  pairingCode?: string | null;
  pairingCodeExpiresAt?: string | null;
  pairedDevices: PairedDevice[];
  relay: CompanionRelayStatus;
}
