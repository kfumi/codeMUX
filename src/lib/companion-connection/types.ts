export interface CompanionOfferV1 {
  v: 1;
  desktopId: string;
  pairingCode: string;
  lan?: { host: string; port: number };
  relay?: { endpoint: string; useTls?: boolean };
  desktopPublicKeyB64?: string;
  expiresAt?: string;
}

export type CompanionConnectionEntry =
  | { id: string; type: 'lan'; baseUrl: string }
  | { id: string; type: 'relay'; endpoint: string; useTls: boolean; desktopPublicKeyB64: string }
  | { id: string; type: 'direct'; host: string; port: number; useTls: boolean };

export interface CompanionConnectionProfile {
  desktopId: string;
  deviceId: string;
  token: string;
  label?: string;
  connections: CompanionConnectionEntry[];
  preferredConnectionId?: string;
}

/** Pre-profile mobile storage shape. */
export interface LegacyCompanionConnection {
  baseUrl: string;
  token: string;
  deviceId?: string;
  desktopId?: string;
}

export interface ParsedPairingInput {
  baseUrl: string;
  pairingCode: string;
  desktopId?: string;
  offer?: CompanionOfferV1;
}

export type ConnectionReachability = Record<string, boolean>;

export class CompanionConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanionConnectionError';
  }
}

export class CompanionTransportNotImplementedError extends CompanionConnectionError {
  readonly connectionType: 'relay' | 'direct';

  constructor(connectionType: 'relay' | 'direct') {
    super(`Transport for "${connectionType}" is not implemented yet`);
    this.connectionType = connectionType;
  }
}
