// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';

// Monaco 在 jsdom 里跑不起来,替换掉模块本身;这里验的是宿主门控与占位路径。
vi.mock('../code/MonacoCodeView', () => ({
  default: () => <div data-testid="monaco-editor-mock" />,
}));

describe('FileView 宿主门控', () => {
  afterEach(() => {
    cleanup();
  });

  it('桌面形态走 Monaco', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
    const { FileView } = await import('./FileView');
    render(<FileView content={'alpha\nbeta'} filePath="/repo/src/app.ts" />);

    expect(screen.getByTestId('monaco-code-surface')).toBeTruthy();
    expect(await screen.findByTestId('monaco-editor-mock')).toBeTruthy();
  });

  it('移动形态用 highlight.js 只读视图(Monaco 不支持移动浏览器)', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'mobile' });
    const { FileView } = await import('./FileView');
    render(<FileView content={'alpha\nbeta'} filePath="/repo/notes.unknown" />);

    expect(screen.queryByTestId('monaco-code-surface')).toBeNull();
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    // 行号 gutter 仍然存在
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('可编辑视图在移动形态保留 textarea 编辑能力', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'mobile' });
    const { EditableFileView } = await import('./FileView');
    render(
      <EditableFileView content="alpha" filePath="/repo/notes.unknown" onChange={() => {}} />,
    );

    const textarea = screen.getByLabelText('编辑 /repo/notes.unknown');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(screen.queryByTestId('monaco-editor-mock')).toBeNull();
  });

  it('可编辑视图在桌面形态走 Monaco', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
    const { EditableFileView } = await import('./FileView');
    render(
      <EditableFileView content="alpha" filePath="/repo/src/app.ts" onChange={() => {}} />,
    );

    expect(screen.getByTestId('monaco-code-surface')).toBeTruthy();
    expect(await screen.findByTestId('monaco-editor-mock')).toBeTruthy();
  });
});
