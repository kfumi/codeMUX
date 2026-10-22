import { describe, expect, it } from 'vitest';

import {
  appendPickedRoots,
  disambiguatedRootNames,
  projectRootName,
  removeRootKeepingPrimary,
  type EditableProjectRoot,
} from './projectRoots';

function root(path: string, isPrimary = false): EditableProjectRoot {
  return { path, isPrimary };
}

describe('projectRoots', () => {
  it('marks the first picked folder as primary and dedupes by normalized path', () => {
    const next = appendPickedRoots([], [
      'D:/work/alpha',
      'D:\\work\\alpha\\',
      'D:/work/beta',
    ]);

    expect(next).toEqual([
      { path: 'D:/work/alpha', isPrimary: true },
      { path: 'D:/work/beta', isPrimary: false },
    ]);
  });

  it('keeps the existing primary when appending more folders', () => {
    const next = appendPickedRoots(
      [root('D:/work/alpha', true), root('D:/work/beta')],
      ['D:/work/beta/', 'D:/work/gamma'],
    );

    expect(next.map((entry) => entry.path)).toEqual([
      'D:/work/alpha',
      'D:/work/beta',
      'D:/work/gamma',
    ]);
    expect(next.filter((entry) => entry.isPrimary)).toHaveLength(1);
    expect(next[0].isPrimary).toBe(true);
  });

  it('promotes the first remaining root when the primary is removed', () => {
    const next = removeRootKeepingPrimary(
      [root('D:/work/alpha', true), root('D:/work/beta'), root('D:/work/gamma')],
      'D:/work/alpha',
    );

    expect(next).toEqual([
      { path: 'D:/work/beta', isPrimary: true },
      { path: 'D:/work/gamma', isPrimary: false },
    ]);
  });

  it('leaves the primary untouched when a non-primary root is removed', () => {
    const next = removeRootKeepingPrimary(
      [root('D:/work/alpha', true), root('D:/work/beta')],
      'D:/work/beta',
    );

    expect(next).toEqual([{ path: 'D:/work/alpha', isPrimary: true }]);
  });

  it('disambiguates same-named folders with their parent directory', () => {
    const names = disambiguatedRootNames([
      root('D:/work/client/src'),
      root('D:/work/server/src'),
      root('D:/work/docs'),
    ]);

    expect(names).toEqual(['client/src', 'server/src', 'docs']);
  });

  it('reads the last path segment on both separators', () => {
    expect(projectRootName('D:\\work\\alpha\\')).toBe('alpha');
    expect(projectRootName('/home/me/beta/')).toBe('beta');
  });
});
