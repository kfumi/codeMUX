// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../types/project';
import { AutomationProjectPicker } from './AutomationProjectPicker';

const project: Project = {
  id: 'p1',
  name: 'multi-root',
  roots: [
    { path: 'D:/work/alpha', position: 0, isPrimary: true },
    { path: 'D:/work/beta', position: 1, isPrimary: false },
  ],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('AutomationProjectPicker', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the bound primary root for the selected project', () => {
    render(
      <AutomationProjectPicker
        projects={[project]}
        value="p1"
        onChange={() => {}}
        fullWidth
      />,
    );

    expect(screen.getByText('multi-root')).toBeTruthy();
    expect(screen.getByText('D:/work/alpha')).toBeTruthy();
  });
});
