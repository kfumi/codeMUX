// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


import { useAgentStore } from '../../stores/agentStore';
import { NEW_SESSION_DRAFT_SESSION_ID, useNewSessionStore } from '../../stores/newSessionStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { Project } from '../../types/project';
import { ProjectExplorer } from './ProjectExplorer';

const listDirectoryMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    listDirectory: listDirectoryMock,
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

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
    listDirectoryMock.mockReset();
    useSessionStore.setState({ activeSessionId: 'session-1' });
    useNewSessionStore.setState({ isDraftOpen: false });
    useAgentStore.setState({ pendingComposerReferenceInsert: {} });
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => undefined),
      },
    });

    listDirectoryMock.mockImplementation(async (path, depth) => {
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
      expect(listDirectoryMock).toHaveBeenCalledWith(
        `${project.path}/docs/superpowers`,
        1,
        project.path,
        true,
      );
    });

    expect(screen.getByText('specs')).toBeTruthy();

    fireEvent.click(screen.getByText('specs'));

    await waitFor(() => {
      expect(listDirectoryMock).toHaveBeenCalledWith(
        `${project.path}/docs/superpowers/specs`,
        1,
        project.path,
        true,
      );
    });

    expect(screen.getByText('feature.md')).toBeTruthy();
  });

  it('shows the file tree context menu actions', async () => {
    render(<ProjectExplorer project={project} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('docs')).toBeTruthy();
    });

    fireEvent.contextMenu(screen.getByText('docs'));

    expect(screen.getByText('打开')).toBeTruthy();
    expect(screen.getByText('打开方式')).toBeTruthy();
    expect(screen.getByText('在资源管理器中打开')).toBeTruthy();
    expect(screen.getByText('复制绝对路径')).toBeTruthy();
    expect(screen.getByText('复制相对路径')).toBeTruthy();
    expect(screen.getByText('添加到聊天')).toBeTruthy();
  });

  it('queues a file reference for the active session from the context menu', async () => {
    render(<ProjectExplorer project={project} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('docs')).toBeTruthy();
    });

    fireEvent.contextMenu(screen.getByText('docs'));
    fireEvent.click(screen.getByText('添加到聊天'));

    expect(useAgentStore.getState().pendingComposerReferenceInsert['session-1']).toEqual({
      reference: 'docs',
      isDirectory: true,
    });
  });

  it('queues a file reference for the new-session draft when no active session exists', async () => {
    useSessionStore.setState({ activeSessionId: null });
    useNewSessionStore.setState({ isDraftOpen: true });

    render(<ProjectExplorer project={project} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('docs')).toBeTruthy();
    });

    fireEvent.contextMenu(screen.getByText('docs'));
    fireEvent.click(screen.getByText('添加到聊天'));

    expect(useAgentStore.getState().pendingComposerReferenceInsert[NEW_SESSION_DRAFT_SESSION_ID]).toEqual({
      reference: 'docs',
      isDirectory: true,
    });
  });
});
