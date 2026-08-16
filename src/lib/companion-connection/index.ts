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
  connectionIdForLan,
  migrateLegacyConnection,
  normalizeStoredConnection,
  profileToLegacyConnection,
} from './profile';

export {
  buildRestUrl,
  buildWsUrl,
  connectionBaseUrl,
  resolveActiveConnection,
  resolveProfileRestUrl,
  resolveProfileWsUrl,
} from './transport';
