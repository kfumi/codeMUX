// Deterministic fake `codex app-server --stdio` for transport tests.
//
// Driven by two environment variables:
// - FAKE_APP_SERVER_SCENARIO: JSON scenario (see below).
// - FAKE_APP_SERVER_LOG: file path where every wire message is appended
//   synchronously, so tests can assert on the full client/server exchange.
//
// Scenario shape:
// {
//   "responses": {
//     "thread/start": { "result": { "thread": { "id": "thread_1" } } },
//     "turn/start": {
//       "result": {},
//       "thenNotifications": [
//         { "delayMs": 0, "method": "turn/started", "params": {} },
//         { "delayMs": 5, "method": "turn/completed", "params": {} }
//       ],
//       "thenExit": { "code": 1 }
//     }
//   },
//   "hang": ["thread/compact/start"],
//   "trigger": "test/trigger",
//   "afterInitialized": [
//     { "delayMs": 0, "notification": { "method": "turn/started", "params": {} } },
//     { "delayMs": 5, "serverRequest": { "method": "approval/x", "params": {} } },
//     { "delayMs": 5, "serverRequest": { "method": "approval/y", "params": {}, "thenNotify": { "method": "turn/completed", "params": {} } } },
//     { "delayMs": 5, "exit": { "code": 1 } }
//   ]
// }
//
// - `responses[method]` is spread into the JSON-RPC response (`result`/`error`).
// - `responseSequences[method]` is an array of response configs consumed one
//   per request (the last entry repeats); lets tests script different turns.
// - `responses[method].thenNotifications`: scripted steps sent after the
//   response is written (each with its own delayMs). A step may be a plain
//   notification (`{ delayMs, method, params }`) or a server-initiated request
//   (`{ delayMs, serverRequest: { method, params, thenNotify } }`) so approval
//   flows can be scripted mid-turn.
// - `responses[method].thenExit`: exit the fake server after responding.
// - Methods listed in `hang` never receive a response.
// - `trigger`: when set, the `afterInitialized` script does not start on the
//   `initialized` notification; it starts when the client sends a notification
//   with this method name. Lets tests register handlers before the script runs.
// - Default behavior without a scenario: respond to `initialize`, accept
//   `initialized`, and answer unknown methods with a JSON-RPC "method not
//   found" error.

import * as fs from 'node:fs';
import * as path from 'node:path';

const scenarioEnv = process.env.FAKE_APP_SERVER_SCENARIO ?? '{}';
let scenario;
try {
  scenario = JSON.parse(scenarioEnv);
} catch {
  scenario = {};
}

const logPath = process.env.FAKE_APP_SERVER_LOG
  ? path.resolve(process.env.FAKE_APP_SERVER_LOG)
  : null;

function log(entry) {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function send(message) {
  log({ direction: 'sent', message });
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respondTo(id, payload) {
  send({ id, ...payload });
}

const DEFAULT_INITIALIZE_RESPONSE = {
  result: {
    serverInfo: { name: 'fake-codex', version: '0.0.0' },
    capabilities: { experimentalApi: true },
  },
};

const sequenceQueues = new Map();

function responseFor(method) {
  const sequence = scenario.responseSequences?.[method];
  if (Array.isArray(sequence)) {
    let queue = sequenceQueues.get(method);
    if (!queue) {
      queue = [...sequence];
      sequenceQueues.set(method, queue);
    }
    const next = queue.shift();
    if (next !== undefined) {
      return next;
    }
    // The last entry repeats once the queue drains.
    return sequence[sequence.length - 1];
  }
  const configured = scenario.responses?.[method];
  if (configured !== undefined) {
    return configured;
  }
  if (method === 'initialize') {
    return DEFAULT_INITIALIZE_RESPONSE;
  }
  return { error: { code: -32601, message: `Method not found: ${method}` } };
}

const pendingServerRequests = new Map();
let nextServerRequestId = 0;

function sendServerRequest(request) {
  const id = `s${++nextServerRequestId}`;
  pendingServerRequests.set(id, request);
  send({
    method: request.method,
    id,
    params: request.params ?? {},
  });
}

function runAfterInitialized() {
  const script = scenario.afterInitialized ?? [];
  for (const step of script) {
    const delay = typeof step.delayMs === 'number' ? step.delayMs : 0;
    setTimeout(() => {
      if (step.notification) {
        send({
          method: step.notification.method,
          params: step.notification.params ?? {},
        });
      }
      if (step.serverRequest) {
        sendServerRequest(step.serverRequest);
      }
      if (step.exit) {
        process.exit(typeof step.exit.code === 'number' ? step.exit.code : 0);
      }
    }, delay);
  }
}

function handleMessage(message) {
  log({ direction: 'received', message });

  const hasId = message.id !== undefined && message.id !== null;

  if (typeof message.method === 'string' && hasId) {
    // Client request. Hanging methods intentionally never respond.
    if (!Array.isArray(scenario.hang) || !scenario.hang.includes(message.method)) {
      const configured = responseFor(message.method);
      const { thenNotifications, thenExit, ...responsePayload } = configured;
      respondTo(String(message.id), responsePayload);
      for (const step of Array.isArray(thenNotifications) ? thenNotifications : []) {
        const delay = typeof step.delayMs === 'number' ? step.delayMs : 0;
        setTimeout(() => {
          if (step.method) {
            send({
              method: step.method,
              params: step.params ?? {},
            });
          }
          if (step.serverRequest) {
            sendServerRequest(step.serverRequest);
          }
        }, delay);
      }
      if (thenExit && typeof thenExit === 'object') {
        const delay = typeof thenExit.delayMs === 'number' ? thenExit.delayMs : 0;
        setTimeout(() => {
          process.exit(typeof thenExit.code === 'number' ? thenExit.code : 0);
        }, delay);
      }
    }
    return;
  }

  if (typeof message.method === 'string') {
    // Client notification.
    const triggerMethod = typeof scenario.trigger === 'string' ? scenario.trigger : null;
    if (triggerMethod) {
      if (message.method === triggerMethod) {
        runAfterInitialized();
      }
    } else if (message.method === 'initialized') {
      runAfterInitialized();
    }
    return;
  }

  if (hasId) {
    // Response to a server-initiated request.
    const request = pendingServerRequests.get(String(message.id));
    pendingServerRequests.delete(String(message.id));
    log({
      direction: 'response',
      id: String(message.id),
      method: request?.method ?? null,
      message,
    });
    if (request?.thenNotify) {
      send({
        method: request.thenNotify.method,
        params: request.thenNotify.params ?? {},
      });
    }
    return;
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {
      log({ direction: 'parse-error', line });
    }
  }
});
process.stdin.on('end', () => {
  process.exit(0);
});
