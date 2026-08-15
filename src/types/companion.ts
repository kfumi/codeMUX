export interface PairedDevice {
  id: string;
  name: string;
  paired_at: string;
  last_seen_at?: string | null;
}

export interface CompanionStatus {
  enabled: boolean;
  port: number;
  lanIp?: string | null;
  pairingCode?: string | null;
  pairedDevices: PairedDevice[];
}
