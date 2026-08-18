import { ClientChannel } from '../e2ee';
import type { CompanionConnectionEntry } from '../types';
import { buildRelayWsUrl, createRelayConnectionId } from './url';

interface HttpTunnelRequest {
  type: 'http';
  id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

interface HttpTunnelResponse {
  type: 'http_res';
  id: string;
  status: number;
  body: string;
}

const RELAY_HANDSHAKE_TIMEOUT_MS = 5_000;

export class RelayTunnelClient {
  private socket: WebSocket | null = null;
  private channel = new ClientChannel();
  private readonly pending = new Map<string, {
    resolve: (value: HttpTunnelResponse) => void;
    reject: (error: Error) => void;
  }>();
  private connectPromise: Promise<void> | null = null;

  constructor(
    private readonly connection: Extract<CompanionConnectionEntry, { type: 'relay' }>,
    private readonly serverId: string,
  ) {}

  async connect(): Promise<void> {
    if (this.channel.isOpen() && this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const connectionId = createRelayConnectionId();
      const url = buildRelayWsUrl({
        endpoint: this.connection.endpoint,
        useTls: this.connection.useTls,
        serverId: this.serverId,
        role: 'client',
        connectionId,
      });
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.binaryType = 'arraybuffer';
      let settled = false;
      let handshakeTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

      const clearHandshakeTimer = () => {
        if (handshakeTimer !== undefined) {
          globalThis.clearTimeout(handshakeTimer);
          handshakeTimer = undefined;
        }
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearHandshakeTimer();
        try {
          socket.close();
        } catch {
          // Ignore close errors while failing the handshake.
        }
        reject(error);
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearHandshakeTimer();
        resolve();
      };

      handshakeTimer = globalThis.setTimeout(() => {
        fail(new Error('Relay handshake timed out'));
      }, RELAY_HANDSHAKE_TIMEOUT_MS);

      socket.onopen = () => {
        if (settled) return;
        try {
          socket.send(this.channel.createHello());
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };

      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            this.channel.handleReady(event.data, this.connection.desktopPublicKeyB64);
            succeed();
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) {
          return;
        }
        try {
          const response = this.channel.decryptJson<HttpTunnelResponse>(new Uint8Array(event.data));
          const waiter = this.pending.get(response.id);
          if (waiter) {
            this.pending.delete(response.id);
            waiter.resolve(response);
          }
        } catch {
          // ignore malformed frames
        }
      };

      socket.onerror = () => {
        fail(new Error('Relay connection failed'));
      };

      socket.onclose = () => {
        this.socket = null;
        if (!settled) {
          settled = true;
          clearHandshakeTimer();
          reject(new Error('Relay connection closed before handshake'));
        }
        for (const waiter of this.pending.values()) {
          waiter.reject(new Error('Relay connection closed'));
        }
        this.pending.clear();
      };
    });
  }

  async request(path: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Relay socket is not open');
    }

    const id = createRelayConnectionId();
    const headers: Record<string, string> = {};
    if (init.headers) {
      const headerEntries = init.headers instanceof Headers
        ? [...init.headers.entries()]
        : Object.entries(init.headers as Record<string, string>);
      for (const [key, value] of headerEntries) {
        headers[key] = value;
      }
    }

    const payload: HttpTunnelRequest = {
      type: 'http',
      id,
      method: (init.method ?? 'GET').toUpperCase(),
      path,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: typeof init.body === 'string' ? init.body : undefined,
    };

    const responsePromise = new Promise<HttpTunnelResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      window.setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('Relay request timed out'));
      }, 15_000);
    });

    socket.send(this.channel.encryptJson(payload));
    const response = await responsePromise;
    return { status: response.status, body: response.body };
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

const relayClients = new WeakMap<object, RelayTunnelClient>();

export function getRelayTunnelClient(
  profileKey: object,
  connection: Extract<CompanionConnectionEntry, { type: 'relay' }>,
  serverId: string,
): RelayTunnelClient {
  const existing = relayClients.get(profileKey);
  if (existing) {
    return existing;
  }
  const client = new RelayTunnelClient(connection, serverId);
  relayClients.set(profileKey, client);
  return client;
}
