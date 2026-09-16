// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MonacoLoading } from './MonacoLoading';

describe('MonacoLoading', () => {
  afterEach(() => {
    cleanup();
  });

  it('渲染默认文案与状态语义', () => {
    render(<MonacoLoading />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('编辑器加载中');
  });

  it('支持自定义文案(diff 场景)', () => {
    render(<MonacoLoading label="Diff 加载中" />);

    expect(screen.getByRole('status').textContent).toContain('Diff 加载中');
  });
});
