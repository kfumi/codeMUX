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
//   A step with `awaitResponse: true` pauses the sequence until the client
//   sends an `extension_ui_response` frame whose `id` matches the step
//   event's `id` (simulating a pending extension UI dialog).
// - `responseSequences[command]` is consumed one per request (last repeats).
// - Commands in `hang` never receive a response.
// - Default behavior without a scenario: answer every command with
//   `{ type: "response", success: true, data: {} }`.
//
// Frame provenance (companion note to the header of `piRpcTransport.test.ts`):
// every payload here is SYNTHETIC and hand-written for determinism — none of it
// is a byte-for-byte capture. What *is* taken from the real thing: the wire
// shapes, re-checked on 2026-09-28 against a real `pi --mode rpc` process at pi
// 0.87.1 (the managed Runtime under
// `%LOCALAPPDATA%/CodeMUX/runtimes/pi/0.87.1`) — request lines `{id, type}`,
// response lines `{id, type:"response", command, success, data}`, failure as
// `success:false` + `error`, and events as bare `{type:...}` lines on stdout.
//
// When bumping pi, re-check against the real process before trusting a green
// run: the response envelope fields, the `success`/`error` failure shape, the
// unknown-command wording the client matches (`Unknown command: <cmd>`, see
// `isUnknownPiRpcCommand`), `extension_ui_request`/`extension_ui_response`
// pairing, and stdout CRLF tolerance (`frameStyle: "crlf"` above).

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
/** extension_ui_request id → resolver（客户端回包后放行 awaitResponse 步骤）。 */
const awaitedResponses = new Map();
/** holdUntilAbort 缓存的事件（收到 abort 后放行）。 */
let heldEvents = null;

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
  const { thenEvents, thenExit, holdUntilAbort, ...responsePayload } = payload;
  send({ type: 'response', command: type, id, ...responsePayload });
  if (holdUntilAbort && Array.isArray(thenEvents)) {
    // 中断时序测试用：缓存事件，等客户端发来 abort 再放行，
    // 保证 agent_end 一定在 abort 之后到达（不依赖定时器竞争）。
    heldEvents = { steps: thenEvents, thenExit };
    return;
  }
  void runSteps(Array.isArray(thenEvents) ? thenEvents : []);
  if (thenExit && typeof thenExit === 'object') {
    const delay = typeof thenExit.delayMs === 'number' ? thenExit.delayMs : 0;
    setTimeout(() => {
      process.exit(typeof thenExit.code === 'number' ? thenExit.code : 0);
    }, delay);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 顺序执行 thenEvents；`awaitResponse` 步骤等客户端回包后再继续。 */
async function runSteps(steps) {
  for (const step of steps) {
    const delay = typeof step.delayMs === 'number' ? step.delayMs : 0;
    if (delay > 0) {
      await sleep(delay);
    }
    send(step.event);
    if (step.awaitResponse && step.event && step.event.id !== undefined) {
      await new Promise((resolve) => {
        awaitedResponses.set(String(step.event.id), resolve);
      });
    }
  }
}

function handleMessage(message) {
  log({ direction: 'received', message });

  if (message.type === 'extension_ui_response') {
    const key = String(message.id);
    const resolve = awaitedResponses.get(key);
    if (resolve) {
      awaitedResponses.delete(key);
      resolve();
    }
    return;
  }

  if (message.type === 'abort' && heldEvents) {
    const held = heldEvents;
    heldEvents = null;
    void runSteps(held.steps);
    if (held.thenExit && typeof held.thenExit === 'object') {
      const delay = typeof held.thenExit.delayMs === 'number' ? held.thenExit.delayMs : 0;
      setTimeout(() => {
        process.exit(typeof held.thenExit.code === 'number' ? held.thenExit.code : 0);
      }, delay);
    }
  }

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
