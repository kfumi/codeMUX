import { describe, expect, it, vi } from 'vitest';
import type { SidecarRuntime } from './runtimePort.js';
import type { EnsureSessionCommand, RuntimeFlavor } from './types.js';
import { SidecarRuntimePool, type RuntimeRegistrations } from './runtimePool.js';

function runtime(flavor: RuntimeFlavor, overrides: Partial<SidecarRuntime> = {}): SidecarRuntime {
  return {
    flavor,
    ensure: vi.fn().mockResolvedValue(undefined),
    updatePermissions: vi.fn(),
    emitSessionMapping: vi.fn(),
    sendInput: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function registrations(input: {
  claude: SidecarRuntime;
  codex: SidecarRuntime;
  createOpencode?: (cmd: EnsureSessionCommand) => SidecarRuntime;
  createPi?: (cmd: EnsureSessionCommand) => SidecarRuntime;
}): RuntimeRegistrations {
  return {
    claude: { kind: 'singleton', runtime: input.claude },
    codex: { kind: 'singleton', runtime: input.codex },
    opencode: { kind: 'managed', create: input.createOpencode ?? (() => runtime('opencode')) },
    pi: { kind: 'managed', create: input.createPi ?? (() => runtime('pi')) },
  };
}

const ensureCmd = (agentKind: string, sessionId = 'session-1') => ({
  type: 'ensure_session' as const,
  agentKind,
  cwd: 'D:\\workspace',
  sessionId,
});

describe('SidecarRuntimePool', () => {
  it('selects the registered singleton for claude and codex', async () => {
    const claude = runtime('claude');
    const codex = runtime('codex');
    const pool = new SidecarRuntimePool(registrations({ claude, codex }));

    await pool.ensure(ensureCmd('claude_code'));
    expect(pool.current()).toBe(claude);
    expect(claude.ensure).toHaveBeenCalledTimes(1);

    await pool.ensure(ensureCmd('codex'));
    expect(pool.current()).toBe(codex);
    expect(codex.ensure).toHaveBeenCalledTimes(1);
  });

  it('shuts down the managed runtime before starting a singleton', async () => {
    const opencode = runtime('opencode');
    const claude = runtime('claude');
    const pool = new SidecarRuntimePool(registrations({ claude, codex: runtime('codex'), createOpencode: () => opencode }));

    await pool.ensure(ensureCmd('opencode'));
    await pool.ensure(ensureCmd('claude_code'));

    expect(opencode.shutdown).toHaveBeenCalledTimes(1);
    expect((opencode.shutdown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((claude.ensure as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    expect(pool.current()).toBe(claude);
  });

  it('reuses a managed runtime when canReuse accepts the command', async () => {
    const opencode = runtime('opencode', { canReuse: vi.fn().mockReturnValue(true) });
    const create = vi.fn(() => opencode);
    const pool = new SidecarRuntimePool(registrations({ claude: runtime('claude'), codex: runtime('codex'), createOpencode: create }));

    await pool.ensure(ensureCmd('opencode'));
    await pool.ensure(ensureCmd('opencode', 'session-2'));

    expect(create).toHaveBeenCalledTimes(1);
    expect(opencode.shutdown).not.toHaveBeenCalled();
    expect(opencode.updatePermissions).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update_permissions',
      sessionId: 'session-2',
    }));
    expect(opencode.emitSessionMapping).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-2' }));
  });

  it('replaces a managed runtime when canReuse rejects the command', async () => {
    const first = runtime('opencode', { canReuse: vi.fn().mockReturnValue(false) });
    const second = runtime('opencode');
    const create = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const pool = new SidecarRuntimePool(registrations({ claude: runtime('claude'), codex: runtime('codex'), createOpencode: create }));

    await pool.ensure(ensureCmd('opencode'));
    await pool.ensure(ensureCmd('opencode', 'session-2'));

    expect(create).toHaveBeenCalledTimes(2);
    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(second.ensure).toHaveBeenCalledTimes(1);
    expect(pool.current()).toBe(second);
    expect((first.shutdown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((second.ensure as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });

  it('cleans up a managed runtime whose ensure failed and rethrows the failure', async () => {
    const failing = runtime('opencode', { ensure: vi.fn().mockRejectedValue(new Error('boot failed')) });
    const pool = new SidecarRuntimePool(registrations({
      claude: runtime('claude'),
      codex: runtime('codex'),
      createOpencode: () => failing,
    }));

    await expect(pool.ensure(ensureCmd('opencode'))).rejects.toThrow('boot failed');
    expect(failing.shutdown).toHaveBeenCalledTimes(1);
    expect(pool.current()).toBeUndefined();
  });

  it('returns no current runtime for a managed flavor that is not active', async () => {
    const pool = new SidecarRuntimePool(registrations({ claude: runtime('claude'), codex: runtime('codex') }));

    await pool.ensure(ensureCmd('pi'));

    expect(pool.current()?.flavor).toBe('pi');
    pool.setActiveKind('opencode');
    expect(pool.current()).toBeUndefined();
    pool.setActiveKind(undefined);
    expect(pool.flavor).toBe('opencode');
  });

  it('shuts down the active managed runtime on shutdown without touching singletons', async () => {
    const opencode = runtime('opencode');
    const claude = runtime('claude');
    const codex = runtime('codex');
    const pool = new SidecarRuntimePool(registrations({ claude, codex, createOpencode: () => opencode }));

    await pool.ensure(ensureCmd('opencode'));
    await pool.shutdown();

    expect(opencode.shutdown).toHaveBeenCalledTimes(1);
    expect(claude.shutdown).not.toHaveBeenCalled();
    expect(codex.shutdown).not.toHaveBeenCalled();
  });

  it('shuts down the active singleton on shutdown', async () => {
    const claude = runtime('claude');
    const codex = runtime('codex');
    const pool = new SidecarRuntimePool(registrations({ claude, codex }));

    await pool.ensure(ensureCmd('codex'));
    await pool.shutdown();

    expect(codex.shutdown).toHaveBeenCalledTimes(1);
    expect(claude.shutdown).not.toHaveBeenCalled();
  });

  it('reports a managed runtime shutdown failure', async () => {
    const opencode = runtime('opencode', { shutdown: vi.fn().mockRejectedValue(new Error('opencode stuck')) });
    const pool = new SidecarRuntimePool(registrations({
      claude: runtime('claude'),
      codex: runtime('codex'),
      createOpencode: () => opencode,
    }));

    await pool.ensure(ensureCmd('opencode'));

    await expect(pool.shutdown()).rejects.toThrow(/Sidecar runtime shutdown failed/);
    expect(opencode.shutdown).toHaveBeenCalledTimes(1);
  });

  it('reports an active singleton shutdown failure', async () => {
    const claude = runtime('claude', { shutdown: vi.fn().mockRejectedValue(new Error('claude stuck')) });
    const pool = new SidecarRuntimePool(registrations({ claude, codex: runtime('codex') }));

    await pool.ensure(ensureCmd('claude_code'));

    await expect(pool.shutdown()).rejects.toThrow(/Sidecar runtime shutdown failed/);
    expect(claude.shutdown).toHaveBeenCalledTimes(1);
  });
});
