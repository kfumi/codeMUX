import type { CompanionOfferV1, ParsedPairingInput } from './types';
import { CompanionConnectionError } from './types';

const OFFER_FRAGMENT_PREFIX = '#offer=';

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64UrlToUtf8(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCompanionOffer(value: unknown): CompanionOfferV1 {
  if (!isRecord(value) || value.v !== 1) {
    throw new CompanionConnectionError('Unsupported companion offer version');
  }
  if (typeof value.desktopId !== 'string' || !value.desktopId.trim()) {
    throw new CompanionConnectionError('Companion offer missing desktopId');
  }
  if (typeof value.pairingCode !== 'string' || !value.pairingCode.trim()) {
    throw new CompanionConnectionError('Companion offer missing pairingCode');
  }

  const offer: CompanionOfferV1 = {
    v: 1,
    desktopId: value.desktopId.trim(),
    pairingCode: value.pairingCode.trim(),
  };

  if (value.lan !== undefined) {
    if (!isRecord(value.lan) || typeof value.lan.host !== 'string' || typeof value.lan.port !== 'number') {
      throw new CompanionConnectionError('Companion offer has invalid lan');
    }
    offer.lan = { host: value.lan.host.trim(), port: value.lan.port };
  }

  if (value.relay !== undefined) {
    if (!isRecord(value.relay) || typeof value.relay.endpoint !== 'string') {
      throw new CompanionConnectionError('Companion offer has invalid relay');
    }
    offer.relay = {
      endpoint: value.relay.endpoint.trim(),
      useTls: typeof value.relay.useTls === 'boolean' ? value.relay.useTls : undefined,
    };
  }

  if (value.desktopPublicKeyB64 !== undefined) {
    if (typeof value.desktopPublicKeyB64 !== 'string' || !value.desktopPublicKeyB64.trim()) {
      throw new CompanionConnectionError('Companion offer has invalid desktopPublicKeyB64');
    }
    offer.desktopPublicKeyB64 = value.desktopPublicKeyB64.trim();
  }

  if (value.expiresAt !== undefined) {
    if (typeof value.expiresAt !== 'string' || Number.isNaN(Date.parse(value.expiresAt))) {
      throw new CompanionConnectionError('Companion offer has invalid expiresAt');
    }
    offer.expiresAt = value.expiresAt;
  }

  return offer;
}

export function encodeOfferFragment(offer: CompanionOfferV1): string {
  const json = JSON.stringify(offer);
  return encodeBase64Url(new TextEncoder().encode(json));
}

export function decodeOfferFragmentPayload(encoded: string): unknown {
  try {
    const json = decodeBase64UrlToUtf8(encoded.trim());
    return JSON.parse(json) as unknown;
  } catch {
    throw new CompanionConnectionError('Malformed companion offer payload');
  }
}

function extractOfferFragmentEncoded(input: string): string | null {
  const trimmed = input.trim();
  const fragmentIndex = trimmed.indexOf(OFFER_FRAGMENT_PREFIX);
  if (fragmentIndex === -1) return null;
  const encoded = trimmed.slice(fragmentIndex + OFFER_FRAGMENT_PREFIX.length).trim();
  return encoded.length > 0 ? encoded : null;
}

export function parseCompanionOfferFromUrl(input: string): CompanionOfferV1 | null {
  const encoded = extractOfferFragmentEncoded(input);
  if (!encoded) return null;
  return parseCompanionOffer(decodeOfferFragmentPayload(encoded));
}

export function buildCompanionOfferUrl(offer: CompanionOfferV1, appBaseUrl: string): string {
  const base = appBaseUrl.trim().replace(/\/$/, '');
  return `${base}/#offer=${encodeOfferFragment(offer)}`;
}

export function isCompanionOfferExpired(offer: CompanionOfferV1, now = Date.now()): boolean {
  if (!offer.expiresAt) return false;
  const expiresAt = Date.parse(offer.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function resolveBaseUrlFromOffer(offer: CompanionOfferV1, pageOrigin?: string): string {
  if (offer.lan?.host) {
    return `http://${offer.lan.host}:${offer.lan.port}`;
  }
  if (pageOrigin?.trim()) {
    return pageOrigin.trim().replace(/\/$/, '');
  }
  throw new CompanionConnectionError('Companion offer is missing lan host and page origin');
}

function parseLegacyQueryUrl(input: string, pageOrigin?: string): ParsedPairingInput | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  const code = url.searchParams.get('code')?.trim();
  if (!code) return null;

  const host = url.searchParams.get('host')?.trim();
  const port = url.searchParams.get('port')?.trim() ?? '9240';
  let baseUrl: string;
  if (host) {
    baseUrl = `http://${host}:${port}`;
  } else if (url.port || (pageOrigin && url.origin === new URL(pageOrigin).origin)) {
    baseUrl = `${url.protocol}//${url.host}`.replace(/\/$/, '');
  } else if (pageOrigin?.trim()) {
    baseUrl = pageOrigin.trim().replace(/\/$/, '');
  } else {
    baseUrl = `${url.protocol}//${url.host}`.replace(/\/$/, '');
  }

  return { baseUrl, pairingCode: code };
}

export function parsePairingInput(input: string, pageOrigin?: string): ParsedPairingInput {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new CompanionConnectionError('Pairing input is empty');
  }

  const offer = parseCompanionOfferFromUrl(trimmed);
  if (offer) {
    if (isCompanionOfferExpired(offer)) {
      throw new CompanionConnectionError('配对码无效或已过期，请让桌面刷新二维码');
    }
    return {
      baseUrl: resolveBaseUrlFromOffer(offer, pageOrigin),
      pairingCode: offer.pairingCode,
      desktopId: offer.desktopId,
      offer,
    };
  }

  const legacy = parseLegacyQueryUrl(trimmed, pageOrigin);
  if (legacy) {
    return legacy;
  }

  throw new CompanionConnectionError('无法识别的配对链接');
}
