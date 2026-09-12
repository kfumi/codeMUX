#!/usr/bin/env node
/**
 * CodeMUX CLI — third Daemon Client (issue 11 MVP)
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PORT = 9240;

function parseArgs(argv) {
  const [, , command, ...rest] = argv;
  let port = DEFAULT_PORT;
  let sessionId;
  let message;
  let requestId;
  let decision;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--port' && rest[index + 1]) {
      port = Number(rest[index + 1]);
      index += 1;
    } else if (!sessionId) {
      sessionId = token;
    } else if (!message) {
      message = token;
    } else if (!requestId) {
      requestId = token;
    } else if (!decision) {
      decision = token;
    }
  }

  return { command: command ?? 'help', sessionId, message, requestId, decision, port };
}

// 与 daemon 默认 app-data-dir 对齐:dirs::data_dir() + "com.codemux.desktop"。
// Windows 为 Roaming %APPDATA%,macOS 为 ~/Library/Application Support,
// Linux 为 $XDG_DATA_HOME(~/.local/share)。
function defaultAppDataDir() {
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'com.codemux.desktop');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'com.codemux.desktop');
  }
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'com.codemux.desktop');
}

async function readLocalToken() {
  const appData = process.env.CODEMUX_APP_DATA ?? defaultAppDataDir();
  const tokenPath = join(appData, 'local-daemon-token');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!token) throw new Error('Local daemon token missing');
  return token;
}

async function api(port, path, init) {
  const token = await readLocalToken();
  return fetch(`http://127.0.0.1:${port}/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

async function cmdStatus(port) {
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  const healthJson = await health.json();
  const statusResponse = await api(port, '/daemon/status');
  const statusJson = await statusResponse.json();
  console.log(JSON.stringify({ health: healthJson, daemon: statusJson }, null, 2));
}

async function cmdSessions(port) {
  const response = await api(port, '/sessions');
  const sessions = await response.json();
  console.log(JSON.stringify(sessions, null, 2));
}

async function cmdSend(port, sessionId, message) {
  const response = await api(port, `/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ prompt: message }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  console.log('accepted');
}

async function cmdInterrupt(port, sessionId) {
  const response = await api(port, `/sessions/${sessionId}/interrupt`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  console.log('interrupted');
}

async function cmdRespond(port, sessionId, requestId, decision) {
  const response = await api(port, '/permissions/respond', {
    method: 'POST',
    body: JSON.stringify({
      sessionId,
      requestId,
      response: { decision },
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  console.log('responded');
}

function printHelp() {
  console.log(`CodeMUX CLI (daemon client)

Usage:
  codemux-cli status [--port 9240]
  codemux-cli sessions [--port 9240]
  codemux-cli send <sessionId> <message> [--port 9240]
  codemux-cli interrupt <sessionId> [--port 9240]
  codemux-cli respond <sessionId> <requestId> <decision> [--port 9240]
`);
}

async function main() {
  const options = parseArgs(process.argv);
  switch (options.command) {
    case 'status':
      await cmdStatus(options.port);
      break;
    case 'sessions':
    case 'list':
      await cmdSessions(options.port);
      break;
    case 'send':
      if (!options.sessionId || !options.message) throw new Error('send requires sessionId and message');
      await cmdSend(options.port, options.sessionId, options.message);
      break;
    case 'interrupt':
      if (!options.sessionId) throw new Error('interrupt requires sessionId');
      await cmdInterrupt(options.port, options.sessionId);
      break;
    case 'respond':
      if (!options.sessionId || !options.requestId || !options.decision) {
        throw new Error('respond requires sessionId, requestId, and decision');
      }
      await cmdRespond(options.port, options.sessionId, options.requestId, options.decision);
      break;
    default:
      printHelp();
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
