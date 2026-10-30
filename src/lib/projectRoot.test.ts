import { describe, expect, it } from 'vitest';

import {
  appendPickedRoots,
  getBoundProjectPath,
  getPrimaryProjectRoot,
  getProjectRootPaths,
  isPathInsideProjectRoot,
  normalizeProjectRootPath,
  projectRootName,
  removeRootKeepingPrimary,
  resolveProjectPath,
  toEditableProjectRoots,
  disambiguatedRootNames,
  type EditableProjectRoot,
} from './projectRoot';
import type { Project } from '../types/project';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Fullstack',
    roots: [
      { path: 'D:/work/frontend', position: 0, isPrimary: true },
      { path: 'D:/work/backend', position: 1, isPrimary: false },
    ],
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function root(path: string, isPrimary = false): EditableProjectRoot {
  return { path, isPrimary };
}

describe('resolveProjectPath', () => {
  it('returns the primary root, which keys the Git environment cache', () => {
    expect(resolveProjectPath('p1', [project()])).toBe('D:/work/frontend');
  });

  it('follows the primary flag when the order does not change', () => {
    const switched = project({
      roots: [
        { path: 'D:/work/frontend', position: 0, isPrimary: false },
        { path: 'D:/work/backend', position: 1, isPrimary: true },
      ],
    });
    expect(resolveProjectPath('p1', [switched])).toBe('D:/work/backend');
  });

  it('falls back to the first root for legacy rows without a primary flag', () => {
    const legacy = project({
      roots: [
        { path: 'D:/work/backend', position: 1, isPrimary: false },
        { path: 'D:/work/frontend', position: 0, isPrimary: false },
      ],
    });
    expect(resolveProjectPath('p1', [legacy])).toBe('D:/work/frontend');
  });

  it('returns null for a missing project or no roots', () => {
    expect(resolveProjectPath('missing', [project()])).toBeNull();
    expect(resolveProjectPath(null, [project()])).toBeNull();
    expect(resolveProjectPath('p1', [project({ roots: [] })])).toBeNull();
  });
});

describe('project roots', () => {
  it('returns all root paths in position order', () => {
    const unordered = project({
      roots: [
        { path: 'D:/work/backend', position: 2, isPrimary: true },
        { path: 'D:/work/frontend', position: 1, isPrimary: false },
      ],
    });
    expect(getProjectRootPaths(unordered)).toEqual(['D:/work/frontend', 'D:/work/backend']);
    expect(getPrimaryProjectRoot(unordered)).toBe('D:/work/backend');
  });

  it('resolves the root bound to a session project', () => {
    expect(getBoundProjectPath({ project_id: 'p1' }, [project()])).toBe('D:/work/frontend');
    expect(getBoundProjectPath({ project_id: null }, [project()])).toBeNull();
  });

  it('normalizes separators, case and trailing slashes into one key', () => {
    expect(normalizeProjectRootPath(' D:\\Work\\Alpha\\ ')).toBe('d:/work/alpha');
    expect(normalizeProjectRootPath(null)).toBe('');
  });

  it('checks containment by the normalized key', () => {
    expect(isPathInsideProjectRoot('D:\\Work\\Alpha', 'd:/work/alpha/src')).toBe(true);
    expect(isPathInsideProjectRoot('D:/work/alpha', 'D:/work/alphabet')).toBe(false);
    expect(isPathInsideProjectRoot('', 'D:/work/alpha')).toBe(false);
  });

  it('reads the last path segment on both separators', () => {
    expect(projectRootName('D:\\work\\alpha\\')).toBe('alpha');
    expect(projectRootName('/home/me/beta/')).toBe('beta');
  });

  it('disambiguates same-named folders with their parent directory', () => {
    const names = disambiguatedRootNames([
      root('D:/work/client/src'),
      root('D:/work/server/src'),
      root('D:/work/docs'),
    ]);

    expect(names).toEqual(['client/src', 'server/src', 'docs']);
  });

  it('marks the first root as primary for legacy projects without a flag', () => {
    expect(
      toEditableProjectRoots([
        { path: 'D:/work/backend', position: 1, isPrimary: false },
        { path: 'D:/work/frontend', position: 0, isPrimary: false },
      ]),
    ).toEqual([
      { path: 'D:/work/frontend', isPrimary: true },
      { path: 'D:/work/backend', isPrimary: false },
    ]);
  });

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
});
