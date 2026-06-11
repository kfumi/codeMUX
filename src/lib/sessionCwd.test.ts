import { describe, expect, it } from 'vitest';

import type { Project } from '../types/project';
import { resolveSessionCwd } from './sessionCwd';

const projects: Project[] = [
  {
    id: 'project-1',
    name: 'codeMUX',
    path: 'D:/project/ai-code/codeMUX',
    created_at: '',
    updated_at: '',
  },
];

describe('resolveSessionCwd', () => {
  it('prefers the bound project path for a new session draft', () => {
    expect(resolveSessionCwd(projects, 'project-1', '.')).toBe('D:/project/ai-code/codeMUX');
  });

  it('falls back to the remembered cwd when no draft project is bound', () => {
    expect(resolveSessionCwd(projects, null, 'D:/workspace')).toBe('D:/workspace');
  });

  it('falls back to the remembered cwd when the draft project is missing', () => {
    expect(resolveSessionCwd(projects, 'missing-project', 'D:/workspace')).toBe('D:/workspace');
  });
});
