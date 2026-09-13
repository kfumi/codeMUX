import { readFileSync, readdirSync, statSync } from 'node:fs';
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
import { BROWSER_HOST_METHODS } from '../browserHost';
import { electronBrowserHost } from '../browser/electronBrowserHost';
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

/** 已退役的 Tauri JS 集成包名(拼接构造,避免守卫文件自身命中全仓 grep 门)。 */
const RETIRED_TAURI_PKG = `@${'tauri-apps'}`;
const RETIRED_INVOKE_HELPER = ['invoke', 'Logged'].join('');

/** 递归收集 src 下全部 ts/tsx 源文件(守卫用,与 store-double-write 同法)。 */
function listSrcSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listSrcSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(full)) continue;
    files.push(full);
  }
  return files;
}

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

  it('binds shell manifest entries to real renderer-facing methods (工单 09 终态)', () => {
    const shellIds = new Set(SHELL_CAPABILITIES.map((entry) => entry.id));
    const facade = shellFacade as unknown as Record<string, unknown>;

    expect(shellIds.has('browser.host')).toBe(true);
    expect(facade.browser).toBeDefined();

    // window.manage:窗口命令全量在壳门面上(自绘标题栏走这组方法)。
    for (const method of ['minimizeWindow', 'toggleMaximizeWindow', 'closeWindow', 'isWindowMaximized']) {
      expect(typeof facade[method]).toBe('function');
    }

    // open.external:外链统一走壳门面。
    expect(typeof facade.openExternal).toBe('function');

    // 其余 shell 归属(tray 等)在 main 进程,无渲染层方法面,仅要求条目在册。
    expect(shellIds.has('tray.manage')).toBe(true);
    expect(shellIds.has('updater')).toBe(true);
    expect(shellIds.has('dialog.file')).toBe(true);
    expect(shellIds.has('dialog.directory')).toBe(true);
  });

  it('keeps browser control config on the daemon side', () => {
    const entry = CAPABILITY_MANIFEST.find((item) => item.id === 'browser.control');
    expect(entry?.owner).toBe('daemon');
    expect(entry?.companionRoute).toBe('PATCH /api/config');
  });

  it('keeps browser host on shell facade only', () => {
    const shellIds = new Set(SHELL_CAPABILITIES.map((entry) => entry.id));
    expect(shellIds.has('browser.host')).toBe(true);
    expect(shellFacade.browser).toBeDefined();
  });

  it('covers the full BrowserHost contract on shell facade and the Electron host (工单 07)', () => {
    const shell = shellFacade.browser as unknown as Record<string, unknown>;
    const electron = electronBrowserHost as unknown as Record<string, unknown>;
    expect(BROWSER_HOST_METHODS).toHaveLength(13);
    for (const method of BROWSER_HOST_METHODS) {
      expect(typeof shell[method]).toBe(`function`);
      expect(typeof electron[method]).toBe(`function`);
    }
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

describe('no invoke backend (工单 09:Tauri 壳退役终态)', () => {
  const FACADE_DIR = dirname(fileURLToPath(import.meta.url));

  it('facade layer sources carry no Tauri backend remnants', () => {
    const guarded = ['shell-facade.ts', 'daemon-facade.ts', 'capability-manifest.ts', '../desktop-bridge.ts', '../desktopDialogs.ts'];
    for (const relative of guarded) {
      const content = readFileSync(join(FACADE_DIR, relative), 'utf8');
      expect(content, `${relative} must not reference ${RETIRED_TAURI_PKG}`).not.toMatch(new RegExp(RETIRED_TAURI_PKG));
      expect(content, `${relative} must not reference ${RETIRED_INVOKE_HELPER}`).not.toMatch(new RegExp(`\\b${RETIRED_INVOKE_HELPER}\\b`));
      expect(content, `${relative} must not call invoke(`).not.toMatch(/[^a-zA-Z]invoke\s*\(/);
    }
  });

  it('shell facade routes every shell command through the bridge guard (no platform branching)', () => {
    const content = readFileSync(join(FACADE_DIR, 'shell-facade.ts'), 'utf8');
    expect(content).not.toMatch(/\bisElectronDesktop\b/);
    expect(content).not.toMatch(/__TAURI_INTERNALS__/);
    // 桥缺失检查统一收在 bridgeCall 里(工单 02:同步抛出会冒到 React 错误边界)。
    expect(content).toMatch(/function bridgeCall</);
    expect(content).toMatch(/DESKTOP_BRIDGE_UNAVAILABLE_MESSAGE/);
  });

  it('shell facade methods never throw synchronously without the bridge (工单 02 回归)', async () => {
    // 浏览器形态(无 preload 桥)下,壳门面必须把失败表达成 rejection:
    // 同步抛出会越过调用方的 .catch,把整块界面渲染成「渲染错误」。
    const facade = shellFacade as unknown as Record<string, (...args: unknown[]) => unknown>;
    // browser 是宿主对象本身;openExternal 有意的降级分支(外链开新标签页)。
    const exempt = new Set(['browser', 'openExternal']);

    const invoked: string[] = [];
    for (const [name, member] of Object.entries(facade)) {
      if (exempt.has(name) || typeof member !== 'function') continue;
      invoked.push(name);

      let outcome: unknown;
      expect(() => {
        outcome = member.call(facade, 'x');
      }, `${name} 不应同步抛出`).not.toThrow();
      await expect(outcome, `${name} 应以 rejection 报错`).rejects.toThrow('codemuxDesktop 桥不可用');
    }

    expect(invoked.length).toBeGreaterThanOrEqual(17);
  });

  it('src tree imports no deleted tauri backend module anywhere', () => {
    const srcDir = join(FACADE_DIR, '..', '..');
    const violations: string[] = [];
    for (const file of listSrcSourceFiles(srcDir)) {
      const content = readFileSync(file, 'utf8');
      if (new RegExp(RETIRED_TAURI_PKG).test(content) || /from\s+['"][^'"]*\blib\/tauri['"]/.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
