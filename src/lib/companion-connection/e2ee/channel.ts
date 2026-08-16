import {
  deriveSharedKey,
  encrypt,
  decrypt,
  exportPublicKeyB64,
  generateKeyPair,
  importPublicKeyB64,
  utf8Decode,
  utf8Encode,
  type E2eeKeyPair,
} from './crypto';

interface HelloMessage {
  type: 'e2ee_hello';
  key: string;
}

interface ReadyMessage {
  type: 'e2ee_ready';
}

export class ClientChannel {
  private readonly keyPair: E2eeKeyPair;
  private sharedKey: Uint8Array | null = null;
  private desktopPublicKey: Uint8Array | null = null;

  constructor(keyPair: E2eeKeyPair = generateKeyPair()) {
    this.keyPair = keyPair;
  }

  get publicKeyB64(): string {
    return this.keyPair.publicKeyB64;
  }

  createHello(): string {
    return JSON.stringify({
      type: 'e2ee_hello',
      key: this.keyPair.publicKeyB64,
    } satisfies HelloMessage);
  }

  handleReady(text: string, desktopPublicKeyB64: string): void {
    const parsed = JSON.parse(text) as ReadyMessage;
    if (parsed.type !== 'e2ee_ready') {
      throw new Error('Expected e2ee_ready');
    }
    const desktopPublic = importPublicKeyB64(desktopPublicKeyB64);
    if (this.desktopPublicKey && !bytesEqual(this.desktopPublicKey, desktopPublic)) {
      throw new Error('E2EE re-handshake key mismatch');
    }
    this.desktopPublicKey = desktopPublic;
    this.sharedKey = deriveSharedKey(this.keyPair.secretKey, desktopPublic);
  }

  isOpen(): boolean {
    return this.sharedKey !== null;
  }

  encryptOutbound(plaintext: Uint8Array): Uint8Array {
    if (!this.sharedKey) {
      throw new Error('E2EE channel not open');
    }
    return encrypt(this.sharedKey, plaintext);
  }

  decryptInbound(payload: Uint8Array): Uint8Array {
    if (!this.sharedKey) {
      throw new Error('E2EE channel not open');
    }
    return decrypt(this.sharedKey, payload);
  }

  encryptJson(value: unknown): Uint8Array {
    return this.encryptOutbound(utf8Encode(JSON.stringify(value)));
  }

  decryptJson<T>(payload: Uint8Array): T {
    return JSON.parse(utf8Decode(this.decryptInbound(payload))) as T;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export { exportPublicKeyB64, generateKeyPair };
