// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fileApi } from '../../lib/tauri';
import type { Project } from '../../types/project';
import { ProjectExplorer } from './ProjectExplorer';

vi.mock('../../stores/sidePanelStore', () => ({
  useSidePanelStore: (selector: (state: { openFileTab: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ openFileTab: vi.fn() }),
}));

const project: Project = {
  id: 'project-1',
  name: 'lnyd',
  path: 'D:/project/wfm/lnyd',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('ProjectExplorer', () => {
  beforeEach(() => {
    vi.spyOn(fileApi, 'listDirectory').mockImplementation(async (path, depth) => {
      if (path === project.path && depth === 5) {
        return [
          {
            name: 'docs',
            path: `${project.path}/docs`,
            is_dir: true,
            children: [
              {
                name: 'superpowers',
                path: `${project.path}/docs/superpowers`,
                is_dir: true,
              },
            ],
          },
        ];
      }

      if (path === `${project.path}/docs/superpowers` && depth === 1) {
        return [
          {
            name: 'specs',
            path: `${project.path}/docs/superpowers/specs`,
            is_dir: true,
          },
        ];
      }

      if (path === `${project.path}/docs/superpowers/specs` && depth === 1) {
        return [
          {
            name: 'feature.md',
            path: `${project.path}/docs/superpowers/specs/feature.md`,
            is_dir: false,
          },
        ];
      }

      return [];
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lazy-loads children when expanding a directory past the initial depth', async () => {
    render(<ProjectExplorer project={project} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('docs')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('docs'));
    fireEvent.click(screen.getByText('superpowers'));

    expect(screen.queryByText('specs')).toBeNull();

    await waitFor(() => {
      expect(fileApi.listDirectory).toHaveBeenCalledWith(
        `${project.path}/docs/superpowers`,
        1,
        project.path,
        true,
      );
    });

    expect(screen.getByText('specs')).toBeTruthy();

    fireEvent.click(screen.getByText('specs'));

    await waitFor(() => {
      expect(fileApi.listDirectory).toHaveBeenCalledWith(
        `${project.path}/docs/superpowers/specs`,
        1,
        project.path,
        true,
      );
    });

    expect(screen.getByText('feature.md')).toBeTruthy();
  });
});
