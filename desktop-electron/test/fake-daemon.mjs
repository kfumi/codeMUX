#!/usr/bin/env node
// 契约测试夹具:假 daemon(扮演工单 03 的 codemux-daemon)。
// 用法:
//   node fake-daemon.mjs --app-data-dir <dir> [--version <v>] [--managed-by <tag>]
//                        [--exit-after <ms>] [--port <fixed>]
// 行为:监听 127.0.0.1 空闲端口;向 app-data-dir 写 daemon-run-state.json
// (键与 Rust DaemonRunState 完全一致:port/pid/version/managed_by/started_at);
// GET /api/health 返回 {ok:true, version}。
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const readArg = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const appDataDir = readArg('--app-data-dir');
const version = readArg('--version') ?? '0.0.0-fake';
const managedBy = readArg('--managed-by') ?? 'desktop';
const exitAfter = readArg('--exit-after') ? Number(readArg('--exit-after')) : null;
const fixedPort = readArg('--port') ? Number(readArg('--port')) : 0;

if (!appDataDir) {
  console.error('--app-data-dir is required');
  process.exit(2);
}

const server = http.createServer((request, response) => {
  if (request.url === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, version }));
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(fixedPort, '127.0.0.1', () => {
  const port = server.address().port;
  mkdirSync(appDataDir, { recursive: true });
  writeFileSync(
    path.join(appDataDir, 'daemon-run-state.json'),
    JSON.stringify(
      {
        port,
        pid: process.pid,
        version,
        managed_by: managedBy,
        started_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  if (exitAfter !== null) {
    setTimeout(() => process.exit(0), exitAfter);
  }
});
