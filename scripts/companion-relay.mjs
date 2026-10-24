#!/usr/bin/env node
/**
 * Minimal Companion relay for local development and self-hosting.
 * Protocol-compatible subset: control channel + per-client data sockets.
 *
 * Usage: node scripts/companion-relay.mjs [--port 8787]
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import {
  attachRelayPeer,
  closeRelayPeers,
  isSocketOpen,
} from './companion-relay-bridge.mjs';

function sendJson(socket, payload) {
  if (isSocketOpen(socket)) {
    socket.send(JSON.stringify(payload));
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

async function startRelayServer() {
  const { WebSocketServer } = await import('ws');
  const { values } = parseArgs({
    options: { port: { type: 'string', default: '8787' } },
  });
  const port = Number(values.port);
  const servers = new Map();

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
      socket.isAlive = true;
      socket.on('pong', () => {
        socket.isAlive = true;
      });
      sendJson(socket, { type: 'sync', connectionIds: [...entry.data.keys()] });

      socket.on('message', (raw) => {
        socket.isAlive = true;
        const msg = parseControlMessage(raw);
        if (!msg) return;
        if (msg.type === 'ping') sendJson(socket, { type: 'pong' });
      });

      socket.on('close', () => {
        if (entry.control === socket) {
          entry.control = null;
          for (const dataEntry of entry.data.values()) {
            closeRelayPeers(dataEntry);
          }
          entry.data.clear();
        }
        if (!entry.control && entry.data.size === 0) servers.delete(serverId);
      });
      return;
    }

    if (!isSocketOpen(entry.control)) {
      socket.close(1013, 'Desktop relay unavailable');
      if (entry.data.size === 0) servers.delete(serverId);
      return;
    }

    let dataEntry = entry.data.get(connectionId);
    if (!dataEntry) {
      dataEntry = {
        server: null,
        client: null,
        queuedForServer: [],
        queuedForClient: [],
      };
      entry.data.set(connectionId, dataEntry);
      if (entry.control) {
        sendJson(entry.control, { type: 'connected', connectionId });
      }
    }

    attachRelayPeer(dataEntry, role, socket);

    socket.on('close', () => {
      const current = entry.data.get(connectionId);
      if (!current) return;
      const peerKey = role === 'server' ? 'server' : 'client';
      if (current[peerKey] === socket) {
        current[peerKey] = null;
      }
      if (role === 'server') current.queuedForServer = [];
      if (role === 'client') current.queuedForClient = [];
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

  // 控制通道半开检测:TCP 静默断开时服务端不会立刻感知,僵尸控制通道会让
  // 手机的数据连接被误判为「桌面不在线」。用协议级 ping 清理,未回 pong 的
  // 直接 terminate,其 close 回调会关闭该 serverId 下挂起的数据连接。
  const heartbeat = setInterval(() => {
    for (const entry of servers.values()) {
      const control = entry.control;
      if (!isSocketOpen(control)) continue;
      if (control.isAlive === false) {
        control.terminate();
        continue;
      }
      control.isAlive = false;
      try {
        control.ping();
      } catch {
        control.terminate();
      }
    }
  }, 30000);
  heartbeat.unref?.();
}

startRelayServer().catch((error) => {
  console.error('Failed to start companion relay:', error);
  process.exitCode = 1;
});
