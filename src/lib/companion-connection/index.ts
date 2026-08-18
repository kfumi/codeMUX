export type {
  CompanionConnectionEntry,
  CompanionConnectionProfile,
  CompanionOfferV1,
  ConnectionReachability,
  LegacyCompanionConnection,
  ParsedPairingInput,
} from './types';
export {
  CompanionConnectionError,
  CompanionTransportNotImplementedError,
} from './types';

export {
  buildCompanionOfferUrl,
  decodeOfferFragmentPayload,
  encodeOfferFragment,
  isCompanionOfferExpired,
  parseCompanionOffer,
  parseCompanionOfferFromUrl,
  parsePairingInput,
} from './codec';

export {
  buildProfileFromPairing,
  buildProfileFromOffer,
  addDirectConnection,
  removeConnection,
  connectionIdForLan,
  connectionIdForRelay,
  connectionIdForDirect,
  migrateLegacyConnection,
  normalizeStoredConnection,
  profileToLegacyConnection,
} from './profile';

export {
  buildRestUrl,
  buildWsUrl,
  connectionBaseUrl,
  isHttpUrlBlockedBySecurePage,
  resolveActiveConnection,
  resolveProfileRestUrl,
  resolveProfileWsUrl,
} from './transport';

export { companionHttpRequest, isRelayConnection } from './client';
export type { CompanionHttpResponse } from './client';

export {
  buildReachabilityMap,
  probeConnectionReachability,
  summarizeActiveConnection,
} from './reachability';

export { ClientChannel, generateKeyPair } from './e2ee';
export { RelayTunnelClient, buildRelayWsUrl } from './relay';
