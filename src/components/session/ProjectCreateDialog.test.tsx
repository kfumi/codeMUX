// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Project } from '../../types/project';
import { useProjectStore } from '../../stores/projectStore';
import { ProjectCreateDialog } from './ProjectCreateDialog';

const { createProjectMock, openDialogMock } = vi.hoisted(() => ({
  createProjectMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  openDialogMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    createProject: createProjectMock,
  },
}));

vi.mock('../../lib/desktopDialogs', () => ({
  openDialog: openDialogMock,
}));

function projectFixture(name: string, roots: string[]): Project {
  return {
    id: 'created-project',
    name,
    roots: roots.map((path, position) => ({
      path,
      position,
      isPrimary: position === 0,
    })),
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('ProjectCreateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({ projects: [], activeProjectId: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the create action disabled until a name and a folder exist', () => {
    render(<ProjectCreateDialog open onOpenChange={() => {}} />);

    expect(screen.getByRole('button', { name: '创建项目' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /选择文件夹/ })).toBeTruthy();
  });

  it('fills the name from the first folder and submits every root in pick order', async () => {
    openDialogMock.mockResolvedValue(['D:/work/alpha', 'D:/work/beta']);
    createProjectMock.mockImplementation((name: unknown, roots: unknown) =>
      Promise.resolve(projectFixture(String(name), roots as string[])));

    render(<ProjectCreateDialog open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }));

    await screen.findByText('alpha');
    const nameInput = screen.getByPlaceholderText('新项目') as HTMLInputElement;
    expect(nameInput.value).toBe('alpha');

    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledWith('alpha', ['D:/work/alpha', 'D:/work/beta']);
    });
  });

  it('keeps a user-typed name when folders are picked afterwards', async () => {
    openDialogMock.mockResolvedValue(['D:/work/alpha']);
    createProjectMock.mockResolvedValue(projectFixture('我的项目', ['D:/work/alpha']));

    render(<ProjectCreateDialog open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('新项目'), { target: { value: '我的项目' } });
    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }));

    await screen.findByText('alpha');
    expect((screen.getByPlaceholderText('新项目') as HTMLInputElement).value).toBe('我的项目');

    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledWith('我的项目', ['D:/work/alpha']);
    });
  });

  it('moves the chosen folder to the front when marking it primary', async () => {
    openDialogMock.mockResolvedValue(['D:/work/alpha', 'D:/work/beta']);
    createProjectMock.mockResolvedValue(projectFixture('beta', ['D:/work/beta', 'D:/work/alpha']));

    render(<ProjectCreateDialog open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }));
    await screen.findByText('alpha');

    fireEvent.click(screen.getByText('设为主要'));

    const rows = screen.getAllByLabelText(/^移除 /);
    expect(rows[0]?.closest('div')?.textContent).toContain('beta');
    expect(rows[0]?.closest('div')?.textContent).toContain('主要');
    expect((screen.getByPlaceholderText('新项目') as HTMLInputElement).value).toBe('beta');

    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledWith('beta', ['D:/work/beta', 'D:/work/alpha']);
    });
  });

  it('promotes the next folder to primary when the first one is removed', async () => {
    openDialogMock.mockResolvedValue(['D:/work/alpha', 'D:/work/beta']);
    createProjectMock.mockResolvedValue(projectFixture('beta', ['D:/work/beta']));

    render(<ProjectCreateDialog open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }));
    await screen.findByText('alpha');

    fireEvent.click(screen.getByLabelText('移除 alpha'));

    expect(screen.getByLabelText('移除 beta').closest('div')?.textContent).toContain('主要');
    expect((screen.getByPlaceholderText('新项目') as HTMLInputElement).value).toBe('beta');

    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledWith('beta', ['D:/work/beta']);
    });
  });

  it('does not create anything when the dialog is cancelled', async () => {
    const onOpenChange = vi.fn();
    render(<ProjectCreateDialog open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(createProjectMock).not.toHaveBeenCalled();
  });
});
