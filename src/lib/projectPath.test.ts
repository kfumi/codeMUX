import { describe, expect, it } from 'vitest';

import { resolveProjectPath } from './projectPath';
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
