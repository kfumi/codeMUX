#!/usr/bin/env node
/**
 * CodeMUX CLI — third Daemon Client (issue 11 MVP)
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PORT = 9240;

interface CliOptions {
  command: string;
  sessionId?: string;
  message?: string;
  port: number;
}

function parseArgs(argv: string[]): CliOptions {
  const [, , command, ...rest] = argv;
  let port = DEFAULT_PORT;
  let sessionId: string | undefined;
  let message: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--port' && rest[index + 1]) {
      port = Number(rest[index + 1]);
      index += 1;
    } else if (!sessionId) {
      sessionId = token;
    } else if (!message) {
      message = token;
    }
  }

  return { command: command ?? 'help', sessionId, message, port };
}

async function readLocalToken(): Promise<string> {
  const appData = process.env.CODEMUX_APP_DATA
    ?? join(homedir(), 'AppData', 'Local', 'com.codemux.app');
  const tokenPath = join(appData, 'local-daemon-token');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!token) throw new Error('Local daemon token missing');
  return token;
}

async function api(
  port: number,
  path: string,
  init?: RequestInit,
): Promise<Response> {
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

async function cmdStatus(port: number): Promise<void> {
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  const healthJson = await health.json();
  const statusResponse = await api(port, '/daemon/status');
  const statusJson = await statusResponse.json();
  console.log(JSON.stringify({ health: healthJson, daemon: statusJson }, null, 2));
}

async function cmdSessions(port: number): Promise<void> {
  const response = await api(port, '/sessions');
  const sessions = await response.json();
  console.log(JSON.stringify(sessions, null, 2));
}

async function cmdSend(port: number, sessionId: string, message: string): Promise<void> {
  const response = await api(port, `/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ prompt: message }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  console.log('accepted');
}

async function cmdInterrupt(port: number, sessionId: string): Promise<void> {
  const response = await api(port, `/sessions/${sessionId}/interrupt`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  console.log('interrupted');
}

function printHelp(): void {
  console.log(`CodeMUX CLI (daemon client)

Usage:
  codemux-cli status [--port 9240]
  codemux-cli sessions [--port 9240]
  codemux-cli send <sessionId> <message> [--port 9240]
  codemux-cli interrupt <sessionId> [--port 9240]
`);
}

async function main(): Promise<void> {
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
    default:
      printHelp();
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
