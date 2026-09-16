// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DiffViewer } from './diff-viewer';

const PATCH = [
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
  '',
].join('\n');

const PATCH_NO_NEWLINE = [
  '--- a/notes.txt',
  '+++ b/notes.txt',
  '@@ -1 +1 @@',
  '-old content',
  '+new content',
  '\\ No newline at end of file',
  '',
].join('\n');

describe('DiffViewer hunk 头', () => {
  afterEach(cleanup);

  it('默认展示 hunk 头', () => {
    render(<DiffViewer patch={PATCH} />);

    expect(screen.getByText('@@ -1,3 +1,3 @@')).toBeTruthy();
  });

  it('showHunkHeaders={false} 时隐藏', () => {
    render(<DiffViewer patch={PATCH} showHunkHeaders={false} />);

    expect(screen.queryByText('@@ -1,3 +1,3 @@')).toBeNull();
  });

  it('并排模式下 hunk 头整行铺开，不重复渲染两次', () => {
    render(<DiffViewer patch={PATCH} viewMode="split" />);

    expect(screen.getAllByText('@@ -1,3 +1,3 @@').length).toBe(1);
  });

  it('两份全文之间按全文范围合成 hunk 头', () => {
    // 注意用表达式传值:JSX 属性字符串不处理 \n 转义。
    render(<DiffViewer oldFile={'a\nb'} newFile={'a\nc'} />);

    expect(screen.getByText('@@ -1,2 +1,2 @@')).toBeTruthy();
  });
});

describe('DiffViewer 无结尾换行标记', () => {
  afterEach(cleanup);

  it('默认展示标记', () => {
    render(<DiffViewer patch={PATCH_NO_NEWLINE} />);

    expect(screen.getByText('\\ No newline at end of file')).toBeTruthy();
  });

  it('showNoNewlineMarker={false} 时隐藏', () => {
    render(<DiffViewer patch={PATCH_NO_NEWLINE} showNoNewlineMarker={false} />);

    expect(screen.queryByText('\\ No newline at end of file')).toBeNull();
  });

  it('标记不占行号位，也不影响增删统计', () => {
    render(<DiffViewer patch={PATCH_NO_NEWLINE} />);

    const marker = screen.getByText('\\ No newline at end of file');
    const row = marker.closest('[data-slot="diff-viewer-line"]');
    expect(row?.getAttribute('data-type')).toBe('nonewline');
    // 增删统计只数真实内容行
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
  });
});
