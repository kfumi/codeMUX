// Deterministic fake `pi --mode rpc` for transport tests.
//
// Driven by two environment variables:
// - PI_FAKE_SCENARIO: file path to a JSON scenario (see below).
// - PI_FAKE_LOG: file path where every wire message is appended
//   synchronously, so tests can assert on the full client/server exchange.
//
// Scenario shape:
// {
//   "responses": {
//     "get_state": { "data": { "sessionId": "s1" } },
//     "prompt": {
//       "data": {},
//       "thenEvents": [
//         { "delayMs": 0, "event": { "type": "agent_start" } },
//         { "delayMs": 5, "event": { "type": "message_update", "text": "hi" } }
//       ],
//       "thenExit": { "code": 1 }
//     }
//   },
//   "responseSequences": { "get_state": [ { "data": {} }, { "success": false, "error": "boom" } ] },
//   "hang": ["compact"],
//   "stderrLines": ["warn-one"],
//   "crashOnStart": { "code": 1 },
//   "exitAfterMs": 30,
//   "frameStyle": "crlf"
// }
//
// - `responses[command]` is spread into the pi response frame (`data`,
//   `success`, `error`). `thenEvents`: scripted event frames written after
//   the response (each with its own delayMs). `thenExit`: exit afterwards.
// - `responseSequences[command]` is consumed one per request (last repeats).
// - Commands in `hang` never receive a response.
// - Default behavior without a scenario: answer every command with
//   `{ type: "response", success: true, data: {} }`.

import * as fs from 'node:fs';
import * as path from 'node:path';

const scenarioPath = process.env.PI_FAKE_SCENARIO;
let scenario = {};
if (scenarioPath) {
  try {
    scenario = JSON.parse(fs.readFileSync(path.resolve(scenarioPath), 'utf8'));
  } catch {
    scenario = {};
  }
}

const logPath = process.env.PI_FAKE_LOG ? path.resolve(process.env.PI_FAKE_LOG) : null;

function log(entry) {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function send(message) {
  log({ direction: 'sent', message });
  const line = `${JSON.stringify(message)}\n`;
  if (scenario.frameStyle === 'crlf') {
    process.stdout.write(line.replace(/\n$/, '\r\n'));
  } else {
    process.stdout.write(line);
  }
}

if (scenario.crashOnStart) {
  setTimeout(() => {
    process.exit(typeof scenario.crashOnStart.code === 'number' ? scenario.crashOnStart.code : 1);
  }, 10);
}

if (typeof scenario.exitAfterMs === 'number') {
  setTimeout(() => {
    process.exit(1);
  }, scenario.exitAfterMs);
}

if (Array.isArray(scenario.stderrLines)) {
  for (const line of scenario.stderrLines) {
    process.stderr.write(`${line}\n`);
  }
}

const sequenceQueues = new Map();

function responseFor(type) {
  const sequence = scenario.responseSequences?.[type];
  if (Array.isArray(sequence)) {
    let queue = sequenceQueues.get(type);
    if (!queue) {
      queue = [...sequence];
      sequenceQueues.set(type, queue);
    }
    const next = queue.shift();
    if (next !== undefined) {
      return next;
    }
    // The last entry repeats once the queue drains.
    return sequence[sequence.length - 1];
  }
  const configured = scenario.responses?.[type];
  if (configured !== undefined) {
    return configured;
  }
  return { data: {} };
}

function respondTo(id, type, payload) {
  const { thenEvents, thenExit, ...responsePayload } = payload;
  send({ type: 'response', command: type, id, ...responsePayload });
  for (const step of Array.isArray(thenEvents) ? thenEvents : []) {
    const delay = typeof step.delayMs === 'number' ? step.delayMs : 0;
    setTimeout(() => {
      send(step.event);
    }, delay);
  }
  if (thenExit && typeof thenExit === 'object') {
    const delay = typeof thenExit.delayMs === 'number' ? thenExit.delayMs : 0;
    setTimeout(() => {
      process.exit(typeof thenExit.code === 'number' ? thenExit.code : 0);
    }, delay);
  }
}

function handleMessage(message) {
  log({ direction: 'received', message });

  if (typeof message.type === 'string' && message.type !== 'response') {
    // Client command.
    if (Array.isArray(scenario.hang) && scenario.hang.includes(message.type)) {
      return;
    }
    respondTo(
      message.id !== undefined && message.id !== null ? String(message.id) : undefined,
      message.type,
      responseFor(message.type),
    );
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
