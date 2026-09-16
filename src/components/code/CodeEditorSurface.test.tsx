// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';

// Monaco 在 jsdom 里跑不起来(需要真实布局与 worker),所以替换掉这个模块。
// 这里要验的是「宿主形态 → 走哪条渲染路径」的门控,不是编辑器本身。
vi.mock('./MonacoCodeView', () => ({
  default: () => <div data-testid="monaco-editor-mock" />,
}));

async function renderSurface(hostForm: 'desktop' | 'browser' | 'mobile') {
  useDaemonConnectionStore.setState({ hostForm });
  const { CodeEditorSurface } = await import('./CodeEditorSurface');
  render(
    <CodeEditorSurface
      value='{"a":1}'
      onChange={() => {}}
      language="json"
      ariaLabel="JSON 配置"
    />,
  );
}

describe('CodeEditorSurface', () => {
  afterEach(() => {
    cleanup();
  });

  it('桌面形态交给 Monaco', async () => {
    await renderSurface('desktop');

    expect(await screen.findByTestId('monaco-editor-mock')).toBeTruthy();
    expect(screen.getByTestId('monaco-code-surface')).toBeTruthy();
  });

  it('PC 浏览器形态也交给 Monaco', async () => {
    await renderSurface('browser');

    expect(await screen.findByTestId('monaco-editor-mock')).toBeTruthy();
  });

  it('移动形态退回可编辑 textarea，不加载 Monaco', async () => {
    await renderSurface('mobile');

    const textarea = screen.getByLabelText('JSON 配置');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect((textarea as HTMLTextAreaElement).value).toBe('{"a":1}');
    expect(screen.queryByTestId('monaco-editor-mock')).toBeNull();
    expect(screen.queryByTestId('monaco-code-surface')).toBeNull();
  });
});
