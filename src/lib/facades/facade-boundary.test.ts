import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_MANIFEST,
  DAEMON_CAPABILITIES,
  FORBIDDEN_SHELL_METHODS,
  PROTOCOL_BACKED_DAEMON_METHODS,
  SHELL_CAPABILITIES,
} from './capability-manifest';
import {
  daemonFacade,
  forkClaudeViaDaemon,
  listArchivedSessionsViaDaemon,
  listProjectsViaDaemon,
  createProjectViaDaemon,
  deleteProjectViaDaemon,
  renameProjectViaDaemon,
  listSessionsViaDaemon,
} from './daemon-facade';
import { shellFacade } from './shell-facade';

describe('facade boundary', () => {
  it('classifies every spec capability as daemon or shell', () => {
    expect(CAPABILITY_MANIFEST.length).toBeGreaterThan(10);
    for (const entry of CAPABILITY_MANIFEST) {
      expect(['daemon', 'shell']).toContain(entry.owner);
    }
  });

  it('does not expose agent send/interrupt on shell facade', () => {
    for (const method of FORBIDDEN_SHELL_METHODS) {
      expect((shellFacade as Record<string, unknown>)[method]).toBeUndefined();
    }
  });

  it('maps daemon manifest entries to daemon facade methods or protocol helpers', () => {
    for (const entry of DAEMON_CAPABILITIES) {
      if (!entry.daemonMethod) continue;
      const method = entry.daemonMethod;
      const hasMethod =
        method in daemonFacade ||
        `${method}` in daemonFacade;
      expect(hasMethod).toBe(true);
    }
  });

  it('keeps browser host on shell facade only', () => {
    const shellIds = new Set(SHELL_CAPABILITIES.map((entry) => entry.id));
    expect(shellIds.has('browser.host')).toBe(true);
    expect(shellFacade.browser).toBeDefined();
  });

  it('binds protocol-backed daemon methods to HTTP client helpers (no invoke fallback)', () => {
    const protocolRefs: Record<string, unknown> = {
      listSessions: listSessionsViaDaemon,
      listArchivedSessions: listArchivedSessionsViaDaemon,
      listProjects: listProjectsViaDaemon,
      createProject: createProjectViaDaemon,
      deleteProject: deleteProjectViaDaemon,
      renameProject: renameProjectViaDaemon,
      forkClaudeViaDaemon,
      forkClaude: forkClaudeViaDaemon,
    };
    const nestedProtocolBacked = new Set(['mcp', 'skills', 'scheduledTasks', 'terminal', 'git', 'historyImport', 'usage', 'managedRuntime']);
    for (const method of PROTOCOL_BACKED_DAEMON_METHODS) {
      const facadeMethod = (daemonFacade as Record<string, unknown>)[method];
      expect(facadeMethod).toBeDefined();
      if (method in protocolRefs) {
        expect(facadeMethod).toBe(protocolRefs[method]);
      } else if (!nestedProtocolBacked.has(method)) {
        expect(typeof facadeMethod).toBe('function');
      }
    }
    for (const nested of nestedProtocolBacked) {
      expect((daemonFacade as Record<string, unknown>)[nested]).toBeDefined();
    }
  });

  it('does not keep invoke fallbacks on protocol-backed daemon facade methods', () => {
    const facadeSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'daemon-facade.ts'),
      'utf8',
    );
    const invokeBackedPattern =
      /\b(agentApi|sessionApi|configApi|historyImportApi|mcpApi|gitApi)\.[a-zA-Z_]+\(/;
    const protocolBacked = PROTOCOL_BACKED_DAEMON_METHODS.filter(
      (method) => !['mcp', 'skills', 'scheduledTasks', 'terminal', 'git', 'historyImport', 'usage', 'managedRuntime'].includes(method),
    );
    for (const method of protocolBacked) {
      const methodPattern = new RegExp(`\\b${method}(?:\\s*:|\\s*,)`);
      const match = facadeSource.match(methodPattern);
      expect(match?.index, `missing facade method ${method}`).toBeTypeOf('number');
      const start = match!.index!;
      const nextMethod = facadeSource.slice(start + 1).search(/\n  [a-zA-Z]/);
      const body = facadeSource.slice(
        start,
        nextMethod === -1 ? undefined : start + 1 + nextMethod,
      );
      expect(body, `protocol-backed ${method} must not invoke Tauri APIs`).not.toMatch(invokeBackedPattern);
    }
  });
});
