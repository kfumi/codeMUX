import nacl from 'tweetnacl';

const NONCE_BYTES = nacl.box.nonceLength;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export interface E2eeKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  publicKeyB64: string;
}

export function generateKeyPair(): E2eeKeyPair {
  const pair = nacl.box.keyPair();
  return {
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
    publicKeyB64: toBase64Url(pair.publicKey),
  };
}

export function importPublicKeyB64(value: string): Uint8Array {
  return fromBase64Url(value.trim());
}

export function exportPublicKeyB64(publicKey: Uint8Array): string {
  return toBase64Url(publicKey);
}

export function deriveSharedKey(ourSecret: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  return nacl.box.before(theirPublic, ourSecret);
}

export function encrypt(sharedKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(NONCE_BYTES);
  const ciphertext = nacl.box.after(plaintext, nonce, sharedKey);
  const out = new Uint8Array(NONCE_BYTES + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, NONCE_BYTES);
  return out;
}

export function decrypt(sharedKey: Uint8Array, payload: Uint8Array): Uint8Array {
  if (payload.length < NONCE_BYTES) {
    throw new Error('Ciphertext bundle too short');
  }
  const nonce = payload.subarray(0, NONCE_BYTES);
  const ciphertext = payload.subarray(NONCE_BYTES);
  const opened = nacl.box.open.after(ciphertext, nonce, sharedKey);
  if (!opened) {
    throw new Error('Decryption failed');
  }
  return opened;
}

export function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function utf8Decode(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}
