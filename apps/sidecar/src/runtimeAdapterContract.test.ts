import { afterAll, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import { SessionRuntime } from './claudeRuntime.js';
import { CodexAppServerRuntime } from './codexAppServerRuntime.js';
import { createOpenCodeSidecarRuntime } from './opencodeSidecarRuntime.js';
import { createPiSidecarRuntime } from './piSidecarRuntime.js';
import {
  normalizeToolResponseAnswers,
  runtimeDisplayName,
  type SidecarRuntime,
} from './runtimePort.js';
import type { EnsureSessionCommand } from './types.js';

const ensureCmd: EnsureSessionCommand = {
  type: 'ensure_session',
  cwd: os.tmpdir(),
  sessionId: 'runtime-contract',
};

describe('runtime adapter contract', () => {
  const claude = new SessionRuntime();
  const codex = new CodexAppServerRuntime();
  const opencode = createOpenCodeSidecarRuntime(ensureCmd);
  const pi = createPiSidecarRuntime(ensureCmd);
  const adapters: SidecarRuntime[] = [claude, codex, opencode, pi];

  afterAll(async () => {
    await Promise.all([opencode.shutdown(), pi.shutdown()]);
  });

  it('declares a flavor on every adapter', () => {
    expect(adapters.map((adapter) => adapter.flavor)).toEqual(['claude', 'codex', 'opencode', 'pi']);
  });

  it('exposes the shared verbs on every adapter', () => {
    for (const adapter of adapters) {
      expect(typeof adapter.ensure).toBe('function');
      expect(typeof adapter.sendInput).toBe('function');
      expect(typeof adapter.updatePermissions).toBe('function');
      expect(typeof adapter.resetSession).toBe('function');
      expect(typeof adapter.interrupt).toBe('function');
      expect(typeof adapter.shutdown).toBe('function');
      expect(typeof adapter.forkSession).toBe('function');
      expect(typeof adapter.respondToToolUse).toBe('function');
    }
  });

  it('declares file rewind only for Claude', () => {
    expect(typeof claude.rewindFiles).toBe('function');
    expect(adapters[1].rewindFiles).toBeUndefined();
    expect(adapters[2].rewindFiles).toBeUndefined();
    expect(adapters[3].rewindFiles).toBeUndefined();
  });

  it('maps each flavor to its user-facing label', () => {
    expect(runtimeDisplayName('claude')).toBe('Claude');
    expect(runtimeDisplayName('codex')).toBe('Codex');
    expect(runtimeDisplayName('opencode')).toBe('OpenCode');
    expect(runtimeDisplayName('pi')).toBe('pi');
  });

  it('normalizes tool_response answers to string[][]', () => {
    expect(normalizeToolResponseAnswers([['是'], 'ok', 3])).toEqual([['是'], ['ok'], ['3']]);
    expect(normalizeToolResponseAnswers(undefined)).toEqual([]);
    expect(normalizeToolResponseAnswers('not-an-array')).toEqual([]);
  });
});
