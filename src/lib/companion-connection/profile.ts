import type {
  CompanionConnectionProfile,
  CompanionConnectionEntry,
  LegacyCompanionConnection,
  CompanionOfferV1,
} from './types';

export function connectionIdForLan(baseUrl: string): string {
  return `lan:${baseUrl.replace(/\/$/, '')}`;
}

export function connectionIdForRelay(desktopId: string): string {
  return `relay:${desktopId}`;
}

export function connectionIdForDirect(host: string, port: number, useTls: boolean): string {
  return `direct:${useTls ? 'https' : 'http'}://${host}:${port}`;
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

export function buildProfileFromOffer(args: {
  offer: CompanionOfferV1;
  baseUrl: string;
  deviceId: string;
  token: string;
  label?: string;
}): CompanionConnectionProfile {
  const connections: CompanionConnectionEntry[] = [];
  const normalizedBaseUrl = args.baseUrl.replace(/\/$/, '');

  if (args.offer.lan) {
    const lanBaseUrl = `http://${args.offer.lan.host}:${args.offer.lan.port}`;
    connections.push({
      id: connectionIdForLan(lanBaseUrl),
      type: 'lan',
      baseUrl: lanBaseUrl,
    });
  } else if (normalizedBaseUrl) {
    connections.push({
      id: connectionIdForLan(normalizedBaseUrl),
      type: 'lan',
      baseUrl: normalizedBaseUrl,
    });
  }

  if (args.offer.relay && args.offer.desktopPublicKeyB64) {
    connections.push({
      id: connectionIdForRelay(args.offer.desktopId),
      type: 'relay',
      endpoint: args.offer.relay.endpoint,
      useTls: args.offer.relay.useTls ?? false,
      desktopPublicKeyB64: args.offer.desktopPublicKeyB64,
    });
  }

  if (connections.length === 0) {
    throw new Error('Offer has no usable connections');
  }

  return {
    desktopId: args.offer.desktopId,
    deviceId: args.deviceId,
    token: args.token,
    label: args.label,
    connections,
    preferredConnectionId: connections[0]?.id,
  };
}

export function addDirectConnection(
  profile: CompanionConnectionProfile,
  args: { host: string; port: number; useTls: boolean },
): CompanionConnectionProfile {
  const id = connectionIdForDirect(args.host, args.port, args.useTls);
  if (profile.connections.some((connection) => connection.id === id)) {
    return profile;
  }
  return {
    ...profile,
    connections: [
      ...profile.connections,
      {
        id,
        type: 'direct',
        host: args.host.trim(),
        port: args.port,
        useTls: args.useTls,
      },
    ],
  };
}

export function removeConnection(
  profile: CompanionConnectionProfile,
  connectionId: string,
): CompanionConnectionProfile {
  const connections = profile.connections.filter((connection) => connection.id !== connectionId);
  if (connections.length === profile.connections.length) {
    return profile;
  }
  const preferredConnectionId = profile.preferredConnectionId === connectionId
    ? connections[0]?.id
    : profile.preferredConnectionId;
  return {
    ...profile,
    connections,
    preferredConnectionId,
  };
}
