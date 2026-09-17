// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';

// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import { EditableFileView, FileView } from './FileView';

// Monaco 在 jsdom 里跑不起来,替换掉模块本身;这里验的是宿主门控与传参路径。
// mock 会捕获 props,用于断言只读/可编辑视图给 Monaco 的 readOnly 取值。
type MonacoProps = Record<string, unknown>;
const monacoProps: MonacoProps[] = [];

vi.mock('../code/MonacoCodeView', () => ({
  default: (props: MonacoProps) => {
    monacoProps.push(props);
    return <div data-testid="monaco-editor-mock" />;
  },
}));

async function lastMonacoProps(): Promise<MonacoProps> {
  await screen.findByTestId('monaco-editor-mock');
  return monacoProps[monacoProps.length - 1];
}

describe('FileView 宿主门控', () => {
  afterEach(() => {
    cleanup();
    monacoProps.length = 0;
  });

  it('桌面形态走 Monaco,且只读浏览显式只读', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
    render(<FileView content={'alpha\nbeta'} filePath="/repo/src/app.ts" />);

    expect(screen.getByTestId('monaco-code-surface')).toBeTruthy();
    expect(await lastMonacoProps()).toMatchObject({ readOnly: true });
  });

  it('移动形态用 highlight.js 只读视图(Monaco 不支持移动浏览器)', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'mobile' });
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
    render(
      <EditableFileView content="alpha" filePath="/repo/notes.unknown" onChange={() => {}} />,
    );

    const textarea = screen.getByLabelText('编辑 /repo/notes.unknown');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(screen.queryByTestId('monaco-editor-mock')).toBeNull();
  });

  it('可编辑视图在桌面形态走 Monaco,且不再只读', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
    render(
      <EditableFileView content="alpha" filePath="/repo/src/app.ts" onChange={() => {}} />,
    );

    expect(screen.getByTestId('monaco-code-surface')).toBeTruthy();
    expect(await lastMonacoProps()).toMatchObject({ readOnly: false });
  });
});
