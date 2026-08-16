#!/usr/bin/env node
/**
 * Minimal Companion relay for local development and self-hosting.
 * Protocol-compatible subset: control channel + per-client data sockets.
 *
 * Usage: node scripts/companion-relay.mjs [--port 8787]
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { port: { type: 'string', default: '8787' } },
});

const port = Number(values.port);
const servers = new Map(); // serverId -> { control: ws, data: Map<connectionId, { server?: ws, client?: ws }> }

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function parseControlMessage(raw) {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('CodeMUX companion relay\n');
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const serverId = url.searchParams.get('serverId')?.trim();
  const role = url.searchParams.get('role')?.trim();
  const connectionId = url.searchParams.get('connectionId')?.trim();

  if (!serverId || (role !== 'server' && role !== 'client')) {
    socket.close(1008, 'Invalid relay handshake');
    return;
  }

  let entry = servers.get(serverId);
  if (!entry) {
    entry = { control: null, data: new Map() };
    servers.set(serverId, entry);
  }

  if (!connectionId) {
    if (role !== 'server') {
      socket.close(1008, 'Control channel requires server role');
      return;
    }
    entry.control = socket;
    sendJson(socket, { type: 'sync', connectionIds: [...entry.data.keys()] });

    socket.on('message', (raw) => {
      const msg = parseControlMessage(raw);
      if (!msg) return;
      if (msg.type === 'ping') sendJson(socket, { type: 'pong' });
    });

    socket.on('close', () => {
      if (entry.control === socket) entry.control = null;
      if (!entry.control && entry.data.size === 0) servers.delete(serverId);
    });
    return;
  }

  let dataEntry = entry.data.get(connectionId);
  if (!dataEntry) {
    dataEntry = {};
    entry.data.set(connectionId, dataEntry);
    if (entry.control) {
      sendJson(entry.control, { type: 'connected', connectionId });
    }
  }

  if (role === 'server') dataEntry.server = socket;
  if (role === 'client') dataEntry.client = socket;

  const bridge = (from, to) => {
    from.on('message', (data, isBinary) => {
      if (to.readyState === to.OPEN) to.send(data, { binary: isBinary });
    });
  };

  if (dataEntry.server && dataEntry.client) {
    bridge(dataEntry.server, dataEntry.client);
    bridge(dataEntry.client, dataEntry.server);
  }

  socket.on('close', () => {
    const current = entry.data.get(connectionId);
    if (!current) return;
    if (role === 'server') delete current.server;
    if (role === 'client') delete current.client;
    if (!current.server && !current.client) {
      entry.data.delete(connectionId);
      if (entry.control) sendJson(entry.control, { type: 'disconnected', connectionId });
    }
    if (!entry.control && entry.data.size === 0) servers.delete(serverId);
  });
});

httpServer.listen(port, () => {
  console.log(`Companion relay listening on http://localhost:${port} (ws path /ws)`);
});
