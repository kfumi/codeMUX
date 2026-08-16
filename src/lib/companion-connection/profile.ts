import type {
  CompanionConnectionProfile,
  CompanionConnectionEntry,
  LegacyCompanionConnection,
} from './types';

export function connectionIdForLan(baseUrl: string): string {
  return `lan:${baseUrl.replace(/\/$/, '')}`;
}

function legacyDesktopId(baseUrl: string): string {
  return `legacy:${baseUrl.replace(/\/$/, '')}`;
}

export function migrateLegacyConnection(legacy: LegacyCompanionConnection): CompanionConnectionProfile {
  const baseUrl = legacy.baseUrl.replace(/\/$/, '');
  const desktopId = legacy.desktopId?.trim() || legacyDesktopId(baseUrl);
  const deviceId = legacy.deviceId?.trim() || '';
  return {
    desktopId,
    deviceId,
    token: legacy.token,
    connections: [
      {
        id: connectionIdForLan(baseUrl),
        type: 'lan',
        baseUrl,
      },
    ],
  };
}

function isProfile(value: unknown): value is CompanionConnectionProfile {
  if (!value || typeof value !== 'object') return false;
  const record = value as CompanionConnectionProfile;
  return (
    typeof record.desktopId === 'string'
    && typeof record.token === 'string'
    && Array.isArray(record.connections)
  );
}

export function normalizeStoredConnection(
  stored: LegacyCompanionConnection | CompanionConnectionProfile,
): CompanionConnectionProfile {
  if (isProfile(stored)) {
    return {
      ...stored,
      connections: stored.connections.map((connection) => ({ ...connection })),
    };
  }
  return migrateLegacyConnection(stored);
}

export function profileToLegacyConnection(profile: CompanionConnectionProfile): LegacyCompanionConnection {
  const lan = profile.connections.find((connection): connection is Extract<CompanionConnectionEntry, { type: 'lan' }> => (
    connection.type === 'lan'
  ));
  if (!lan) {
    throw new Error('Profile has no LAN connection');
  }
  return {
    baseUrl: lan.baseUrl,
    token: profile.token,
    deviceId: profile.deviceId || undefined,
    desktopId: profile.desktopId,
  };
}

export function buildProfileFromPairing(args: {
  desktopId: string;
  deviceId: string;
  token: string;
  baseUrl: string;
  label?: string;
}): CompanionConnectionProfile {
  const baseUrl = args.baseUrl.replace(/\/$/, '');
  return {
    desktopId: args.desktopId,
    deviceId: args.deviceId,
    token: args.token,
    label: args.label,
    connections: [
      {
        id: connectionIdForLan(baseUrl),
        type: 'lan',
        baseUrl,
      },
    ],
    preferredConnectionId: connectionIdForLan(baseUrl),
  };
}
