import { WebSocket } from 'ws';
import nacl from 'tweetnacl';

const endpoint = process.argv[2] ?? 'relay.fumi-blog.top:443';
const serverId = process.argv[3];
const desktopPubB64 = process.argv[4];
const pairingCode = process.argv[5];
const [host, port] = endpoint.split(':');
const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const fromB64u = (value) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const connectionId = `claimprobe-${Date.now()}`;
const url = `wss://${host}:${port}/ws?serverId=${encodeURIComponent(serverId)}&role=client&v=2&connectionId=${connectionId}`;
console.log('connect', url);

const kp = nacl.box.keyPair();
const ws = new WebSocket(url);
let shared = null;

const timer = setTimeout(() => {
  console.log('TIMEOUT');
  process.exit(2);
}, 15000);

ws.on('open', () => ws.send(JSON.stringify({ type: 'e2ee_hello', key: b64u(kp.publicKey) })));

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const text = data.toString();
    console.log('text', text);
    if (text.includes('e2ee_ready')) {
      shared = nacl.box.before(fromB64u(desktopPubB64), kp.secretKey);
      const payload = {
        type: 'http',
        id: 'claim-1',
        method: 'POST',
        path: '/api/pair/claim',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pairingCode, name: 'relay-probe' }),
      };
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const cipher = nacl.box.after(Buffer.from(JSON.stringify(payload), 'utf8'), nonce, shared);
      ws.send(Buffer.concat([Buffer.from(nonce), Buffer.from(cipher)]));
      console.log('sent claim');
    }
    return;
  }
  if (!shared) return;
  const buf = Buffer.from(data);
  const nonce = buf.subarray(0, nacl.box.nonceLength);
  const cipher = buf.subarray(nacl.box.nonceLength);
  const opened = nacl.box.open.after(cipher, nonce, shared);
  if (!opened) {
    console.log('decrypt failed');
    return;
  }
  const text = Buffer.from(opened).toString('utf8');
  console.log('response', text.slice(0, 300));
  clearTimeout(timer);
  ws.close();
  process.exit(text.includes('"token"') ? 0 : 1);
});

ws.on('close', (code, reason) => {
  console.log('closed', code, reason?.toString());
  clearTimeout(timer);
  process.exit(3);
});
ws.on('error', (error) => console.log('error', error.message));
