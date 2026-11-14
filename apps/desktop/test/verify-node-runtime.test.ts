import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const afterPack = require('../scripts/after-pack.cjs') as (context: unknown) => Promise<void>;
const verifyNodeRuntime = require('../scripts/verify-node-runtime.cjs') as (
  context: unknown,
) => Promise<void>;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeAppOutDir() {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemux-after-pack-'));
  tempDirs.push(appOutDir);
  return appOutDir;
}

function contextFor(appOutDir: string, electronPlatformName: string) {
  return {
    appOutDir,
    electronPlatformName,
    packager: { appInfo: { productFilename: 'CodeMUX' } },
  };
}

function touch(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'stub');
}

async function withoutWindowsSigningCredentials<T>(run: () => Promise<T>): Promise<T> {
  const cscLink = process.env.CSC_LINK;
  const winCscLink = process.env.WIN_CSC_LINK;
  delete process.env.CSC_LINK;
  delete process.env.WIN_CSC_LINK;

  try {
    return await run();
  } finally {
    if (cscLink === undefined) delete process.env.CSC_LINK;
    else process.env.CSC_LINK = cscLink;
    if (winCscLink === undefined) delete process.env.WIN_CSC_LINK;
    else process.env.WIN_CSC_LINK = winCscLink;
  }
}

describe('verify-node-runtime afterPack hook', () => {
  it('accepts a complete Windows runtime', async () => {
    const appOutDir = makeAppOutDir();
    const nodeDir = path.join(appOutDir, 'resources', 'node');
    touch(path.join(nodeDir, 'node.exe'));
    touch(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));

    await expect(verifyNodeRuntime(contextFor(appOutDir, 'win32'))).resolves.toBeUndefined();
  });

  it('fails the build when the bundled npm was filtered out', async () => {
    // 回归：electron-builder 会丢弃根级 node_modules,导致 resources/node 里
    // 只有 node.exe 和 npm.cmd,用户侧报「Node.js 运行时不可用」。
    const appOutDir = makeAppOutDir();
    const nodeDir = path.join(appOutDir, 'resources', 'node');
    touch(path.join(nodeDir, 'node.exe'));
    touch(path.join(nodeDir, 'npm.cmd'));

    await expect(verifyNodeRuntime(contextFor(appOutDir, 'win32'))).rejects.toThrow(
      /node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js/,
    );
  });

  it('accepts the unix layout with lib/node_modules', async () => {
    const appOutDir = makeAppOutDir();
    const nodeDir = path.join(appOutDir, 'resources', 'node');
    touch(path.join(nodeDir, 'bin', 'node'));
    touch(path.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));

    await expect(verifyNodeRuntime(contextFor(appOutDir, 'linux'))).resolves.toBeUndefined();
  });

  it('gives platform-neutral guidance when unix npm is missing', async () => {
    const appOutDir = makeAppOutDir();
    const nodeDir = path.join(appOutDir, 'resources', 'node');
    touch(path.join(nodeDir, 'bin', 'node'));

    await expect(verifyNodeRuntime(contextFor(appOutDir, 'linux'))).rejects.toThrow(
      /extraResources 配置，确保完整 Node 与 npm 文件已复制到资源根的 node\//,
    );
  });

  it('looks inside the .app bundle on macOS', async () => {
    const appOutDir = makeAppOutDir();
    const nodeDir = path.join(appOutDir, 'CodeMUX.app', 'Contents', 'Resources', 'node');
    touch(path.join(nodeDir, 'bin', 'node'));
    touch(path.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));

    await expect(verifyNodeRuntime(contextFor(appOutDir, 'darwin'))).resolves.toBeUndefined();
  });
});

describe('composed afterPack hook', () => {
  it('verifies the bundled runtime before signing the daemon', async () => {
    const appOutDir = makeAppOutDir();
    const nodeDir = path.join(appOutDir, 'resources', 'node');
    touch(path.join(nodeDir, 'node.exe'));
    touch(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));

    await withoutWindowsSigningCredentials(async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        await afterPack(contextFor(appOutDir, 'win32'));
        const messages = info.mock.calls.map(([message]) => String(message));
        expect(messages[0]).toContain('[verify-node-runtime]');
        expect(messages[1]).toContain('[sign-daemon]');
      } finally {
        info.mockRestore();
      }
    });
  });

  it('does not sign the daemon when runtime verification fails', async () => {
    const appOutDir = makeAppOutDir();

    await withoutWindowsSigningCredentials(async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        await expect(afterPack(contextFor(appOutDir, 'win32'))).rejects.toThrow(
          /node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js/,
        );
        expect(info).not.toHaveBeenCalled();
      } finally {
        info.mockRestore();
      }
    });
  });
});
