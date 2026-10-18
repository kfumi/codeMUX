// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitCommitGraphCommit } from '../../../lib/gitTypes';
import { GitGraphPane } from './GitGraphPane';

function commit(hash: string, parents: string[], subject: string): GitCommitGraphCommit {
  return {
    hash,
    parents,
    refs: [{ name: 'HEAD', kind: 'head' }],
    subject,
    authorName: 'tester',
    authoredAtMs: Date.UTC(2026, 0, 2, 3, 4),
  };
}

describe('GitGraphPane', () => {
  afterEach(() => cleanup());

  const commits = [commit('aaaaaaaaaaaa', ['bbbbbbbbbbbb'], 'feat: 第一条'), commit('bbbbbbbbbbbb', [], 'fix: 第二条')];

  it('默认不展示详情', () => {
    render(
      <GitGraphPane commits={commits} selectedCommitHash="aaaaaaaaaaaa" onSelectCommit={vi.fn()} />,
    );
    expect(screen.queryByTestId('git-graph-commit-detail')).toBeNull();
  });

  it('点击某行才展开底部详情，再点收起', () => {
    render(
      <GitGraphPane commits={commits} selectedCommitHash={null} onSelectCommit={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('feat: 第一条'));
    const detail = screen.getByTestId('git-graph-commit-detail');
    expect(detail.textContent).toContain('主题');
    expect(detail.textContent).toContain('feat: 第一条');
    // 父提交以短 hash 展示
    expect(detail.textContent).toContain('bbbbbbb');

    // 展开后主题同时出现在行与详情里，这里点回行（DOM 中第一个）以收起。
    fireEvent.click(screen.getAllByText('feat: 第一条')[0]!);
    expect(screen.queryByTestId('git-graph-commit-detail')).toBeNull();
  });

  it('点击某行回调 onSelectCommit', () => {
    const onSelectCommit = vi.fn();
    render(
      <GitGraphPane commits={commits} selectedCommitHash={null} onSelectCommit={onSelectCommit} />,
    );

    fireEvent.click(screen.getByText('feat: 第一条'));
    expect(onSelectCommit).toHaveBeenCalledWith('aaaaaaaaaaaa');
  });

  it('空历史展示空状态', () => {
    render(<GitGraphPane commits={[]} selectedCommitHash={null} onSelectCommit={vi.fn()} />);
    expect(screen.getByText('暂无提交')).toBeTruthy();
  });
});
