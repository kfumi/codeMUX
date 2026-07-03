import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureWorkingDirectory, resolveDefaultWorkingDirectory, resolveWorkingDirectory } from './defaultWorkingDirectory.js';

describe('default working directory', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  function tempHome(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemux-home-'));
    tempRoots.push(root);
    return root;
  }

  it('uses a CodemuxProject folder under the user home for non-project conversations', () => {
    const home = tempHome();

    expect(resolveDefaultWorkingDirectory(home)).toBe(path.join(home, 'CodemuxProject'));
    expect(resolveWorkingDirectory('.', home)).toBe(path.join(home, 'CodemuxProject'));
    expect(resolveWorkingDirectory('', home)).toBe(path.join(home, 'CodemuxProject'));
    expect(resolveWorkingDirectory('   ', home)).toBe(path.join(home, 'CodemuxProject'));
  });

  it('creates the non-project conversation folder lazily when it is selected', () => {
    const home = tempHome();
    const cwd = ensureWorkingDirectory('.', home);

    expect(cwd).toBe(path.join(home, 'CodemuxProject'));
    expect(fs.statSync(cwd).isDirectory()).toBe(true);
  });

  it('leaves explicit project paths unchanged', () => {
    const home = tempHome();
    const projectPath = path.join(home, 'existing-project');

    expect(resolveWorkingDirectory(projectPath, home)).toBe(projectPath);
  });
});
