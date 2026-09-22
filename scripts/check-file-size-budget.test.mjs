import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUDGETS,
  buildBaseline,
  countLines,
  evaluateSizeBudget,
  shouldCheckFile,
} from './check-file-size-budget.mjs';

/**
 * 门禁本身的用例：门禁写错了比没有门禁更糟（要么放过增长，要么天天报假警）。
 * 这里只测纯函数，不碰真实仓库文件（真实仓库的状态由 `npm run check:size` 自己回答）。
 */
describe('行数预算门禁', () => {
  it('恰好等于预算算通过，超一行就失败', () => {
    const atBudget = evaluateSizeBudget({
      files: [{ path: 'src/a.ts', lines: DEFAULT_BUDGETS['.ts'] }],
      baseline: {},
    });
    expect(atBudget.violations).toEqual([]);

    const oneOver = evaluateSizeBudget({
      files: [{ path: 'src/a.ts', lines: DEFAULT_BUDGETS['.ts'] + 1 }],
      baseline: {},
    });
    expect(oneOver.violations).toEqual([
      { path: 'src/a.ts', lines: 801, budget: 800, kind: 'over-budget' },
    ]);
  });

  it('基线内的文件允许超标，但涨一行就失败', () => {
    const baseline = { 'src/components/agent/assistant-ui/CodeMuxThread.tsx': 2600 };

    expect(evaluateSizeBudget({
      files: [{ path: 'src/components/agent/assistant-ui/CodeMuxThread.tsx', lines: 2600 }],
      baseline,
    }).violations).toEqual([]);

    expect(evaluateSizeBudget({
      files: [{ path: 'src/components/agent/assistant-ui/CodeMuxThread.tsx', lines: 2601 }],
      baseline,
    }).violations).toEqual([
      {
        path: 'src/components/agent/assistant-ui/CodeMuxThread.tsx',
        lines: 2601,
        budget: 2600,
        kind: 'baseline-growth',
      },
    ]);
  });

  it('基线里的文件瘦下来不算违规（可以顺手收紧基线）', () => {
    const result = evaluateSizeBudget({
      files: [{ path: 'src/big.tsx', lines: 400 }],
      baseline: { 'src/big.tsx': 900 },
    });
    expect(result.violations).toEqual([]);
  });

  it('每种扩展名各用各的预算', () => {
    const result = evaluateSizeBudget({
      files: [
        { path: 'crates/daemon/src/a.rs', lines: 950 },
        { path: 'crates/daemon/src/b.rs', lines: 1001 },
        { path: 'src/c.tsx', lines: 900 },
      ],
      baseline: {},
    });
    expect(result.violations.map((violation) => violation.path)).toEqual([
      'crates/daemon/src/b.rs',
      'src/c.tsx',
    ]);
  });

  it('基线由现状生成：只冻结超预算的文件，且排序稳定', () => {
    expect(buildBaseline([
      { path: 'src/z.ts', lines: 900 },
      { path: 'src/a.ts', lines: 801 },
      { path: 'src/small.ts', lines: 10 },
      { path: 'src/readme.md', lines: 9999 },
    ])).toEqual({
      'src/a.ts': 801,
      'src/z.ts': 900,
    });
  });

  it('行数统计：CRLF、末尾换行、空文件', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\r\nb\r\n')).toBe(2);
  });

  it('只扫源码：跳过依赖/产物目录与测试文件', () => {
    expect(shouldCheckFile('src/components/agent/CodeMuxThread.tsx')).toBe(true);
    expect(shouldCheckFile('crates/daemon/src/daemon/mod.rs')).toBe(true);
    expect(shouldCheckFile('node_modules/x/index.js')).toBe(false);
    expect(shouldCheckFile('crates/daemon/target/debug/x.rs')).toBe(false);
    expect(shouldCheckFile('apps/desktop/release/x.ts')).toBe(false);
    expect(shouldCheckFile('src/components/agent/CodeMuxThread.test.tsx')).toBe(false);
    expect(shouldCheckFile('src/styles/globals.css')).toBe(false);
    expect(shouldCheckFile('docs/research/2026-09-21-note.md')).toBe(false);
  });
});
