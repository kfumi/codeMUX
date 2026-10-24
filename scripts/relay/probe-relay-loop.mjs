import { WebSocket } from 'ws';
import nacl from 'tweetnacl';

const endpoint = process.argv[2] ?? 'relay.fumi-blog.top:443';
const serverId = process.argv[3];
const rounds = Number(process.argv[4] ?? 15);
const intervalMs = Number(process.argv[5] ?? 4000);
const [host, port] = endpoint.split(':');
const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

function probe() {
  return new Promise((resolve) => {
    const connectionId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const url = `wss://${host}:${port}/ws?serverId=${encodeURIComponent(serverId)}&role=client&v=2&connectionId=${connectionId}`;
    const kp = nacl.box.keyPair();
    const ws = new WebSocket(url);
    const started = Date.now();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(`${result} (${Date.now() - started}ms)`);
    };
    const timer = setTimeout(() => finish('TIMEOUT'), 10000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'e2ee_hello', key: b64u(kp.publicKey) })));
    ws.on('message', (data, isBinary) => {
      if (!isBinary && data.toString().includes('e2ee_ready')) finish('OK');
    });
    ws.on('close', (code, reason) => finish(`CLOSED ${code} ${reason?.toString() ?? ''}`));
    ws.on('error', (error) => finish(`ERROR ${error.message}`));
  });
}

const t0 = Date.now();
for (let i = 0; i < rounds; i += 1) {
  const result = await probe();
  console.log(`t+${((Date.now() - t0) / 1000).toFixed(1)}s ${result}`);
  if (i < rounds - 1) await new Promise((r) => setTimeout(r, intervalMs));
}
