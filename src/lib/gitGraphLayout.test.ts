import { describe, expect, it } from 'vitest';

import { layoutGitGraph } from './gitGraphLayout';
import type { GitCommitGraphCommit } from './gitTypes';

function commit(
  hash: string,
  parents: string[],
  subject = hash,
): GitCommitGraphCommit {
  return { hash, parents, refs: [], subject, authorName: 'tester', authoredAtMs: 0 };
}

describe('layoutGitGraph', () => {
  it('线性历史：单泳道，行数与提交数一致', () => {
    const commits = [commit('a', ['b']), commit('b', ['c']), commit('c', [])];
    const layout = layoutGitGraph(commits);

    expect(layout.rows).toHaveLength(3);
    expect(layout.rows.every((row) => row.laneIndex === 0)).toBe(true);
    expect(layout.laneCount).toBe(1);
    // 相邻行的 y 正好差一个行高
    expect(layout.rows[1]!.y - layout.rows[0]!.y).toBe(layout.rowHeight);
    // 每条父连线一条 path
    expect(layout.paths).toHaveLength(2);
    expect(layout.paths.every((path) => path.path.startsWith('M '))).toBe(true);
  });

  it('分叉与合并：使用多于一条泳道并返回有效尺寸', () => {
    const commits = [
      commit('merge', ['a', 'b']),
      commit('a', ['base']),
      commit('b', ['base']),
      commit('base', []),
    ];
    const layout = layoutGitGraph(commits);

    expect(layout.rows).toHaveLength(4);
    expect(layout.laneCount).toBeGreaterThanOrEqual(2);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    expect(layout.rows[0]!.commit.hash).toBe('merge');
  });

  it('忽略窗口外的父提交（分页边界）不抛错', () => {
    const commits = [commit('a', ['outside-window'])];
    const layout = layoutGitGraph(commits);

    expect(layout.rows).toHaveLength(1);
    expect(layout.paths).toHaveLength(0);
  });

  it('空历史返回空的布局', () => {
    const layout = layoutGitGraph([]);
    expect(layout.rows).toHaveLength(0);
    expect(layout.paths).toHaveLength(0);
    expect(layout.laneCount).toBe(1);
  });

  it('自定义行高影响像素高度与行间距', () => {
    const commits = [commit('a', ['b']), commit('b', [])];
    const layout = layoutGitGraph(commits, { rowHeight: 30 });

    expect(layout.rowHeight).toBe(30);
    expect(layout.rows[1]!.y - layout.rows[0]!.y).toBe(30);
  });
});
