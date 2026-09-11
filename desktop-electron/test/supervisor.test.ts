// supervisor 契约测试(工单 05):驱动决策表的是 test/fake-daemon.mjs
// 扮演的独立 daemon(与工单 03 的 run-state 契约同形)。
// 覆盖:Attached / Spawned / Restarted 决策表、意外崩溃上报、只停 managed。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearRunState,
  createSupervisor,
  pidIsAlive,
  probeDaemonHealth,
  readRunState,
  type DaemonLifecycleEvent,
} from '../src/supervisor';

const FAKE_DAEMON = path.join(__dirname, 'fake-daemon.mjs');
const TIMEOUTS = { readyPollIntervalMs: 100, healthTimeoutMs: 1_500 } as const;

const externalProcesses: ChildProcess[] = [];
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codemux-supervisor-'));
  tempDirs.push(dir);
  return dir;
}

/** 启动一个「外部」假 daemon 并等待其 run-state 落盘。 */
async function startExternalDaemon(dir: string, extraArgs: string[] = []): Promise<ChildProcess> {
  const child = spawn(process.execPath, [FAKE_DAEMON, '--app-data-dir', dir, ...extraArgs], {
    stdio: 'ignore',
  });
  externalProcesses.push(child);
  await vi.waitFor(
    () => {
      expect(readRunState(dir)).not.toBeNull();
    },
    { timeout: 10_000, interval: 100 },
  );
  return child;
}

function makeSupervisor(dir: string, events: DaemonLifecycleEvent[], extra: Record<string, unknown> = {}) {
  return createSupervisor({
    appDataDir: dir,
    exePath: process.execPath,
    exeArgs: [FAKE_DAEMON],
    timeouts: TIMEOUTS,
    onEvent: (event) => events.push(event),
    ...extra,
  });
}

function lastEvent(events: DaemonLifecycleEvent[], status: string): DaemonLifecycleEvent {
  const found = [...events].reverse().find((event) => event.status === status);
  expect(found, `expected a ${status} event among ${JSON.stringify(events)}`).toBeTruthy();
  return found!;
}

afterAll(() => {
  for (const child of externalProcesses.splice(0)) {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('supervisor run-state contract', () => {
  it('treats a dead-pid run-state as stale (pid liveness semantics)', () => {
    const dir = makeTempDir();
    const stalePid = process.platform === 'win32' ? 4_000_000 : 2 ** 30;
    expect(pidIsAlive(process.pid)).toBe(true);
    expect(pidIsAlive(stalePid)).toBe(false);
  });

  it('probeDaemonHealth parses /api/health and fails closed', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, version: '9.9.9-test' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const health = await probeDaemonHealth(port, 1_000);
      expect(health).toEqual({ ok: true, version: '9.9.9-test' });
      // 找一个确定关闭的端口:先占用再释放。
      const closed = await new Promise<number>((resolve) => {
        const probe = http.createServer();
        probe.listen(0, '127.0.0.1', () => {
          const closedPort = (probe.address() as { port: number }).port;
          probe.close(() => resolve(closedPort));
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await probeDaemonHealth(closed, 500)).toBeNull();
      expect(await probeDaemonHealth(99_999, 200)).toBeNull();
    } finally {
      server.close();
    }
  });
});

describe('supervisor decision table', () => {
  afterEach(() => {
    // 每个用例自清 managed child;外部 daemon 由 afterAll 兜底。
  });

  it('Spawned: missing run-state → spawn new daemon and adopt the child', async () => {
    const dir = makeTempDir();
    const events: DaemonLifecycleEvent[] = [];
    const supervisor = makeSupervisor(dir, events);

    const decision = await supervisor.ensureDaemon();
    expect(decision).toBe('spawned');

    const runState = readRunState(dir);
    expect(runState).not.toBeNull();
    expect(runState!.managed_by).toBe('desktop');
    expect((await probeDaemonHealth(runState!.port, 1_500))?.ok).toBe(true);

    const status = await supervisor.daemonStatus();
    expect(status.running).toBe(true);
    expect(status.managed).toBe(true);
    expect(status.port).toBe(runState!.port);

    lastEvent(events, 'started');
    expect(events.at(-1)!.decision).toBe('spawned');

    await supervisor.stopManaged();
    expect(readRunState(dir)).toBeNull();
    const stopped = await supervisor.daemonStatus();
    expect(stopped.managed).toBe(false);
    supervisor.dispose();
  });

  it('Attached: healthy run-state → reuse external daemon without owning a child', async () => {
    const dir = makeTempDir();
    const external = await startExternalDaemon(dir);
    const externalPid = external.pid!;

    const events: DaemonLifecycleEvent[] = [];
    const supervisor = makeSupervisor(dir, events);
    const decision = await supervisor.ensureDaemon();
    expect(decision).toBe('attached');

    const status = await supervisor.daemonStatus();
    expect(status.managed).toBe(false);
    expect(status.running).toBe(true);
    expect(events.at(-1)!.decision).toBe('attached');

    // 只停 managed:attach 的外部 daemon 绝不动。
    await supervisor.stopManaged();
    expect(pidIsAlive(externalPid)).toBe(true);
    supervisor.dispose();

    try {
      external.kill();
    } catch {
      // ignore
    }
  });

  it('Restarted: version mismatch with expected daemon version → kill old + spawn new', async () => {
    const dir = makeTempDir();
    const external = await startExternalDaemon(dir, ['--version', '9.9.9-old']);
    const oldPid = external.pid!;
    expect(readRunState(dir)!.version).toBe('9.9.9-old');

    const events: DaemonLifecycleEvent[] = [];
    const supervisor = makeSupervisor(dir, events, { expectedDaemonVersion: '1.0.0' });
    const decision = await supervisor.ensureDaemon();
    expect(decision).toBe('restarted');

    // 旧 daemon 被强杀,run-state 换成新 child 的。
    await vi.waitFor(
      () => {
        expect(pidIsAlive(oldPid)).toBe(false);
      },
      { timeout: 10_000, interval: 100 },
    );
    const runState = readRunState(dir);
    expect(runState).not.toBeNull();
    expect(runState!.pid).not.toBe(oldPid);
    expect((await probeDaemonHealth(runState!.port, 1_500))?.ok).toBe(true);

    const status = await supervisor.daemonStatus();
    expect(status.managed).toBe(true);
    expect(events.at(-1)!.decision).toBe('restarted');

    await supervisor.stopManaged();
    supervisor.dispose();
  });

  it('Restarted: expected version falls back to CODEMUX_EXPECTED_DAEMON_VERSION env', async () => {
    const dir = makeTempDir();
    const external = await startExternalDaemon(dir, ['--version', '9.9.9-old']);
    const oldPid = external.pid!;

    const prev = process.env.CODEMUX_EXPECTED_DAEMON_VERSION;
    process.env.CODEMUX_EXPECTED_DAEMON_VERSION = '1.0.0';
    try {
      const events: DaemonLifecycleEvent[] = [];
      const supervisor = makeSupervisor(dir, events);
      expect(await supervisor.ensureDaemon()).toBe('restarted');
      await vi.waitFor(
        () => {
          expect(pidIsAlive(oldPid)).toBe(false);
        },
        { timeout: 10_000, interval: 100 },
      );
      await supervisor.stopManaged();
      supervisor.dispose();
    } finally {
      if (prev === undefined) {
        delete process.env.CODEMUX_EXPECTED_DAEMON_VERSION;
      } else {
        process.env.CODEMUX_EXPECTED_DAEMON_VERSION = prev;
      }
    }
  });

  it('Restarted: unhealthy run-state (live pid, dead port) → kill old + spawn new', async () => {
    const dir = makeTempDir();
    // 活着但端口不服务的进程 + 指向已关闭端口的 run-state。
    const placeholder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    externalProcesses.push(placeholder);
    const closedPort = await new Promise<number>((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });
    writeFileSync(
      path.join(dir, 'daemon-run-state.json'),
      JSON.stringify({
        port: closedPort,
        pid: placeholder.pid,
        version: '1.0.0',
        managed_by: 'desktop',
        started_at: new Date().toISOString(),
      }),
    );
    expect(readRunState(dir)).not.toBeNull();

    const events: DaemonLifecycleEvent[] = [];
    const supervisor = makeSupervisor(dir, events);
    const decision = await supervisor.ensureDaemon();
    expect(decision).toBe('restarted');
    expect(events.at(-1)!.decision).toBe('restarted');

    await supervisor.stopManaged();
    expect(readRunState(dir)).toBeNull();
    supervisor.dispose();
  });

  it('stale run-state (dead pid) is ignored → Spawned path', async () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, 'daemon-run-state.json'),
      JSON.stringify({
        port: 12345,
        pid: process.platform === 'win32' ? 4_000_000 : 2 ** 30,
        version: '1.0.0',
        managed_by: 'desktop',
        started_at: new Date().toISOString(),
      }),
    );

    const events: DaemonLifecycleEvent[] = [];
    const supervisor = makeSupervisor(dir, events);
    const decision = await supervisor.ensureDaemon();
    expect(decision).toBe('spawned');
    await supervisor.stopManaged();
    supervisor.dispose();
  });
});

describe('supervisor watch and stop contract', () => {
  it('unexpected daemon exit clears run-state and emits exited', async () => {
    const dir = makeTempDir();
    const events: DaemonLifecycleEvent[] = [];
    const supervisor = makeSupervisor(dir, events);

    await supervisor.ensureDaemon();
    expect(readRunState(dir)).not.toBeNull();

    // 托管 child 是 supervisor spawn 的 node fake-daemon;给它注入崩溃:
    // 直接杀掉 child 进程 —— 通过拿到底层 pid 不行(child 不外露),
    // 改用 stopManaged 之外的路径:杀掉 run-state 指到的进程。
    const runState = readRunState(dir)!;
    process.kill(runState.pid);

    await vi.waitFor(
      () => {
        const exited = events.find((event) => event.status === 'exited');
        expect(exited).toBeTruthy();
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(readRunState(dir)).toBeNull();
    supervisor.dispose();
  });

  it('start failure surfaces via rejected ensure (unspawnable exe)', async () => {
    const dir = makeTempDir();
    const events: DaemonLifecycleEvent[] = [];
    const supervisor = createSupervisor({
      appDataDir: dir,
      exePath: path.join(os.tmpdir(), 'codemux-no-such-daemon.bin'),
      timeouts: { ...TIMEOUTS, readyTimeoutMs: 3_000 },
      onEvent: (event) => events.push(event),
    });
    await expect(supervisor.ensureDaemon()).rejects.toThrow(/Failed to spawn daemon|did not become ready|exited during startup/);
    supervisor.dispose();
  });

  it('stopManaged is a no-op when nothing is managed', async () => {
    const dir = makeTempDir();
    const supervisor = makeSupervisor(dir, []);
    await expect(supervisor.stopManaged()).resolves.toBeUndefined();
    supervisor.dispose();
  });

  it('clearRunState removes the discovery file', () => {
    const dir = makeTempDir();
    const runStatePath = path.join(dir, 'daemon-run-state.json');
    writeFileSync(
      runStatePath,
      JSON.stringify({ port: 1, pid: process.pid, version: 'x', managed_by: 'desktop', started_at: '' }),
    );
    expect(existsSync(runStatePath)).toBe(true);
    clearRunState(dir);
    expect(existsSync(runStatePath)).toBe(false);
  });
});
