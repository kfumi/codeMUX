import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

// The relay bridge is deployed as standalone JavaScript and has no TypeScript declaration.
import {
  attachRelayPeer,
  closeRelayPeers,
} from '../../scripts/companion-relay-bridge.mjs';

function createSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    OPEN: number;
    CLOSED: number;
    readyState: number;
    sent: Array<{ data: unknown; options: unknown }>;
    send: (data: unknown, options: unknown) => void;
    close: () => void;
  };
  socket.OPEN = 1;
  socket.CLOSED = 3;
  socket.readyState = socket.OPEN;
  socket.sent = [];
  socket.send = (data, options) => {
    socket.sent.push({ data, options });
  };
  socket.close = () => {
    if (socket.readyState === socket.CLOSED) return;
    socket.readyState = socket.CLOSED;
    socket.emit('close');
  };
  return socket;
}

describe('companion relay data bridge', () => {
  it('buffers a client frame until the desktop peer connects', () => {
    const entry = {
      server: null,
      client: null,
      queuedForServer: [],
      queuedForClient: [],
    };
    const client = createSocket();
    const server = createSocket();

    attachRelayPeer(entry, 'client', client);
    client.emit('message', JSON.stringify({ type: 'e2ee_hello' }), false);

    expect(server.sent).toHaveLength(0);

    attachRelayPeer(entry, 'server', server);

    expect(server.sent).toEqual([{
      data: JSON.stringify({ type: 'e2ee_hello' }),
      options: { binary: false },
    }]);
  });

  it('forwards frames in both directions after both peers connect', () => {
    const entry = {
      server: null,
      client: null,
      queuedForServer: [],
      queuedForClient: [],
    };
    const client = createSocket();
    const server = createSocket();

    attachRelayPeer(entry, 'client', client);
    attachRelayPeer(entry, 'server', server);

    server.emit('message', JSON.stringify({ type: 'e2ee_ready' }), false);

    expect(client.sent).toEqual([{
      data: JSON.stringify({ type: 'e2ee_ready' }),
      options: { binary: false },
    }]);
  });

  it('closes the other peer when one data socket closes', () => {
    const entry = {
      server: null,
      client: null,
      queuedForServer: [],
      queuedForClient: [],
    };
    const client = createSocket();
    const server = createSocket();

    attachRelayPeer(entry, 'client', client);
    attachRelayPeer(entry, 'server', server);

    server.close();

    expect(client.readyState).toBe(client.CLOSED);
  });

  it('closes a lone client peer when the relay control socket disconnects', () => {
    const entry = {
      server: null,
      client: null,
      queuedForServer: [],
      queuedForClient: [],
    };
    const client = createSocket();

    attachRelayPeer(entry, 'client', client);
    closeRelayPeers(entry);

    expect(client.readyState).toBe(client.CLOSED);
  });
});
