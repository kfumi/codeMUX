import { WebSocket } from 'ws';
import nacl from 'tweetnacl';

const endpoint = process.argv[2] ?? 'relay.fumi-blog.top:443';
const serverId = process.argv[3];
if (!serverId) {
  console.error('usage: node probe-relay.mjs <host:port> <serverId>');
  process.exit(1);
}
const [host, port] = endpoint.split(':');
const connectionId = `probe-${Date.now()}`;
const url = `wss://${host}:${port}/ws?serverId=${encodeURIComponent(serverId)}&role=client&v=2&connectionId=${connectionId}`;
console.log('connecting', url);

const kp = nacl.box.keyPair();
const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const ws = new WebSocket(url);
const started = Date.now();
const timer = setTimeout(() => {
  console.log(`TIMEOUT after ${Date.now() - started}ms (readyState=${ws.readyState})`);
  ws.close();
  process.exit(2);
}, 12000);

ws.on('open', () => {
  console.log('ws open, sending hello');
  ws.send(JSON.stringify({ type: 'e2ee_hello', key: b64u(kp.publicKey) }));
});
ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    console.log('text frame:', data.toString());
    if (data.toString().includes('e2ee_ready')) {
      clearTimeout(timer);
      console.log(`HANDSHAKE OK in ${Date.now() - started}ms`);
      ws.close();
      process.exit(0);
    }
    return;
  }
  console.log('binary frame', data.length);
});
ws.on('close', (code, reason) => {
  console.log('closed', code, reason?.toString());
  clearTimeout(timer);
  process.exit(3);
});
ws.on('error', (error) => {
  console.log('error', error.message);
});
