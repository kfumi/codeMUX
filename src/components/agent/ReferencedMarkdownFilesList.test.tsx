// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
import { ReferencedMarkdownFilesList } from './ReferencedMarkdownFilesList';

vi.mock('../../lib/facades/shell-facade', () => ({
  shellFacade: {
    openProjectPath: vi.fn(async () => undefined),
  },
}));

vi.mock('../../stores/sidePanelStore', () => ({
  useSidePanelStore: (selector: (state: { openFileTab: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ openFileTab: vi.fn() }),
}));

const FILE_PATH = 'D:\\project\\ai-code\\codeMUX\\docs\\spec.md';

function renderList() {
  return render(<ReferencedMarkdownFilesList files={[FILE_PATH]} />);
}

function openMenu() {
  renderList();
  fireEvent.pointerDown(screen.getByRole('button', { name: /打开/ }));
}

describe('ReferencedMarkdownFilesList', () => {
  beforeEach(() => {
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
  });

  afterEach(() => {
    cleanup();
  });

  it('offers explorer / VS Code targets in the desktop shell', () => {
    openMenu();

    expect(screen.getByText('资源管理器')).toBeTruthy();
    expect(screen.getByText('VS Code')).toBeTruthy();
    expect(screen.getByText('复制绝对路径')).toBeTruthy();
  });

  it('hides shell-only open targets outside the desktop shell, keeping copy', () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser' });

    openMenu();

    expect(screen.queryByText('资源管理器')).toBeNull();
    expect(screen.queryByText('VS Code')).toBeNull();
    expect(screen.getByText('复制绝对路径')).toBeTruthy();
    expect(screen.getByText('复制相对路径')).toBeTruthy();
  });
});
