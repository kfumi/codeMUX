// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
import { DiffView, InlineDiffLines } from './DiffView';

// Monaco 在 jsdom 里跑不起来,替换掉模块本身;这里验的是宿主门控与内联路径。
vi.mock('../code/MonacoDiffView', () => ({
  default: () => <div data-testid="monaco-diff-mock" />,
}));

const OLD_CONTENT = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
const NEW_CONTENT = OLD_CONTENT.replace('line 7', 'line seven');

describe('InlineDiffLines', () => {
  it('只展示变更行及其上下三行上下文', () => {
    render(<InlineDiffLines oldContent={OLD_CONTENT} newContent={NEW_CONTENT} />);

    expect(screen.getByText('line 4')).toBeTruthy();
    expect(screen.getByText('line 10')).toBeTruthy();
    expect(screen.getByText('-')).toBeTruthy();
    expect(screen.getByText('+')).toBeTruthy();
    expect(screen.queryByText('line 3')).toBeNull();
    expect(screen.queryByText('line 11')).toBeNull();
    expect(screen.getAllByText('...').length).toBeGreaterThan(0);
  });
});

describe('DiffView 宿主门控', () => {
  afterEach(() => {
    cleanup();
  });

  it('桌面形态交给 Monaco diff editor', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
    render(<DiffView oldContent={OLD_CONTENT} newContent={NEW_CONTENT} filePath="/repo/src/app.ts" />);

    expect(screen.getByTestId('monaco-diff-surface')).toBeTruthy();
    expect(screen.queryByTestId('highlight-diff-surface')).toBeNull();
    expect(await screen.findByTestId('monaco-diff-mock')).toBeTruthy();
  });

  it('移动形态退回轻量渲染', () => {
    useDaemonConnectionStore.setState({ hostForm: 'mobile' });
    render(<DiffView oldContent={OLD_CONTENT} newContent={NEW_CONTENT} />);

    expect(screen.getByTestId('highlight-diff-surface')).toBeTruthy();
    expect(screen.queryByTestId('monaco-diff-surface')).toBeNull();
  });

  it('inline 变体(手风琴)始终用轻量渲染，内容驱动高度', () => {
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
    render(<DiffView variant="inline" oldContent={OLD_CONTENT} newContent={NEW_CONTENT} />);

    expect(screen.getByTestId('inline-diff-view')).toBeTruthy();
    expect(screen.queryByTestId('monaco-diff-surface')).toBeNull();
  });

  it('统计头展示增删行数', () => {
    useDaemonConnectionStore.setState({ hostForm: 'mobile' });
    render(<DiffView oldContent={OLD_CONTENT} newContent={NEW_CONTENT} />);

    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
  });
});
