import { WebSocket } from 'ws';
import nacl from 'tweetnacl';

const [endpoint, serverId, desktopPubB64, pairingCode] = process.argv.slice(2);
const [host, port] = endpoint.split(':');
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const fromB64u = (v) => Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const connectionId = `flow-${Date.now()}`;
const ws = new WebSocket(`wss://${host}:${port}/ws?serverId=${encodeURIComponent(serverId)}&role=client&v=2&connectionId=${connectionId}`);
const kp = nacl.box.keyPair();
let shared = null;
let seq = 0;
const pending = new Map();

function sendHttp(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const id = `req-${++seq}`;
    pending.set(id, resolve);
    const payload = { type: 'http', id, method, path, headers, body };
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const cipher = nacl.box.after(Buffer.from(JSON.stringify(payload), 'utf8'), nonce, shared);
    ws.send(Buffer.concat([Buffer.from(nonce), Buffer.from(cipher)]));
  });
}

ws.on('message', async (data, isBinary) => {
  if (!isBinary) {
    if (data.toString().includes('e2ee_ready')) {
      shared = nacl.box.before(fromB64u(desktopPubB64), kp.secretKey);
      const claim = await sendHttp('POST', '/api/pair/claim', JSON.stringify({ code: pairingCode, name: 'flow-probe' }), { 'Content-Type': 'application/json' });
      console.log('claim', claim.status, claim.body.slice(0, 160));
      let token = '';
      try { token = JSON.parse(claim.body).token; } catch {}
      if (!token) { ws.close(); process.exit(1); }
      const boot = await sendHttp('GET', '/api/bootstrap', undefined, { Authorization: `Bearer ${token}` });
      console.log('bootstrap', boot.status, boot.body.slice(0, 120));
      const sessions = await sendHttp('GET', '/api/sessions', undefined, { Authorization: `Bearer ${token}` });
      console.log('sessions', sessions.status, sessions.body.slice(0, 120));
      ws.close();
      process.exit(boot.status === 200 ? 0 : 2);
    }
    return;
  }
  if (!shared) return;
  const buf = Buffer.from(data);
  const opened = nacl.box.open.after(buf.subarray(nacl.box.nonceLength), buf.subarray(0, nacl.box.nonceLength), shared);
  if (!opened) return;
  const res = JSON.parse(Buffer.from(opened).toString('utf8'));
  const waiter = pending.get(res.id);
  if (waiter) { pending.delete(res.id); waiter(res); }
});

ws.on('open', () => ws.send(JSON.stringify({ type: 'e2ee_hello', key: b64u(kp.publicKey) })));
ws.on('error', (e) => console.log('error', e.message));
ws.on('close', (c, r) => console.log('closed', c, r?.toString()));
setTimeout(() => { console.log('timeout'); process.exit(3); }, 20000);
