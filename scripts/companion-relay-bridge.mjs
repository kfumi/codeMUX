export function isSocketOpen(socket) {
  const openState = typeof socket?.OPEN === 'number' ? socket.OPEN : 1;
  return socket?.readyState === openState;
}

function sendFrame(socket, data, isBinary) {
  if (!isSocketOpen(socket)) return false;
  socket.send(data, { binary: isBinary });
  return true;
}

function closeSocket(socket) {
  if (!socket) return;
  const closedState = typeof socket.CLOSED === 'number' ? socket.CLOSED : 3;
  if (socket.readyState !== closedState) {
    socket.close();
  }
}

function flushQueuedFrames(entry, role, socket) {
  const queueKey = role === 'server' ? 'queuedForServer' : 'queuedForClient';
  const queue = entry[queueKey];
  if (!queue?.length) return;

  const remaining = [];
  for (const frame of queue) {
    if (!sendFrame(socket, frame.data, frame.isBinary)) {
      remaining.push(frame);
    }
  }
  entry[queueKey] = remaining;
}

/**
 * Attach one side of a relay data connection.
 *
 * The desktop data socket is opened in response to the relay control
 * notification, so the mobile peer can send its first E2EE frame before the
 * desktop peer exists. Queue frames until the target socket is available.
 */
export function attachRelayPeer(entry, role, socket) {
  const peerKey = role === 'server' ? 'server' : 'client';
  const targetKey = role === 'server' ? 'client' : 'server';
  const queueKey = role === 'server' ? 'queuedForClient' : 'queuedForServer';

  entry[peerKey] = socket;
  flushQueuedFrames(entry, role, socket);

  socket.on('message', (data, isBinary) => {
    const target = entry[targetKey];
    if (!sendFrame(target, data, isBinary)) {
      entry[queueKey].push({ data, isBinary });
    }
  });

  socket.on('close', () => {
    closeSocket(entry[targetKey]);
  });
}

export function closeRelayPeers(entry) {
  closeSocket(entry.server);
  closeSocket(entry.client);
  entry.server = null;
  entry.client = null;
  entry.queuedForServer = [];
  entry.queuedForClient = [];
}
