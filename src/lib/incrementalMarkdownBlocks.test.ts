// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarkdownIntoBlocks } from 'streamdown';
import { describe, expect, it, vi } from 'vitest';

import { createIncrementalBlockParser } from './incrementalMarkdownBlocks';

/**
 * 流式里真实出现的块类型都放进来：散文、`##` 标题、**增长中的代码围栏**、表格、列表。
 * 用逐字前缀驱动，所以每一步都必然出现"半个构造"（未闭合围栏、半行表格、半个行内标记）。
 *
 * 刻意**不含** `[^`：上游有一条非局部规则（全文出现脚注样式就把全文当一块），
 * 那种文本在这条用例里会走保守退让路径，覆盖不到冻结路径 —— 它由后面三条用例负责（两条针对
 * `[^`，一条是逐字符比对会踩到这条规则的语料）。
 */
const DOCUMENT = [
  '好的，我来改这三处。',
  '',
  '## 改动一：把状态收敛到单例',
  '',
  '```ts',
  'export function createPoller(interval: number) {',
  '  let timer: number | null = null;',
  '  const subscribers = new Set<() => void>();',
  '  return {',
  '    subscribe(listener: () => void) {',
  '      subscribers.add(listener);',
  '      if (timer === null) timer = window.setInterval(run, interval);',
  '      return () => { subscribers.delete(listener); };',
  '    },',
  '  };',
  '}',
  '```',
  '',
  '| 指标 | 之前 | 之后 |',
  '|---|---|---|',
  '| 轮询器 | 2 个 | 1 个 |',
  '| 每 tick 重渲染 | 2 次 | 0 次 |',
  '',
  '- 去掉每次 tick 的 `setLoading`；',
  '- 改用 `useSyncExternalStore` 读快照。',
  '',
  '以上是全部改动。',
].join('\n');

/** 按 30 个等分点切前缀，等价于"逐字增长的流式提交"。 */
const PREFIXES = Array.from({ length: 30 }, (_, index) =>
  DOCUMENT.slice(0, Math.round((DOCUMENT.length * (index + 1)) / 30)),
);

describe('createIncrementalBlockParser', () => {
  it('每一次追加后的分块结果都与参考实现逐项一致', () => {
    const incremental = createIncrementalBlockParser(parseMarkdownIntoBlocks);

    for (const prefix of PREFIXES) {
      expect(incremental(prefix)).toEqual(parseMarkdownIntoBlocks(prefix));
    }
  });

  it('后续追加里才出现 `[^` 时仍与参考实现一致（上游的非局部脚注规则）', () => {
    // 上游：全文任意位置出现 `[^x]` / `[^x]:` 就把**整段文本**当成一块（无锚点正则早退）。
    // 这在前缀局部的冻结里表达不了，所以本用例锁住"出现 `[^` 就整篇重解析"。
    // 代码块里的取反字符类（`[^0-9]`）同样命中上游的正则，所以两种形态都要覆盖。
    const cases = [
      ['第一段\n\n第二段\n', '第一段\n\n第二段\n\n[^1]: 脚注定义\n'],
      [
        '先看代码：\n\n```ts\nconst ok = 1;\n```\n',
        '先看代码：\n\n```ts\nconst ok = 1;\nconst re = /[^0-9]/;\n```\n',
      ],
    ];

    for (const [before, after] of cases) {
      const incremental = createIncrementalBlockParser(parseMarkdownIntoBlocks);

      // 先产生"多块"的缓存状态，再追加触发非局部规则的文本。
      expect(incremental(before)).toEqual(parseMarkdownIntoBlocks(before));
      expect(incremental(after)).toEqual(parseMarkdownIntoBlocks(after));
      // 触发之后仍然一致（偏差不会从这里开始累积）。
      expect(incremental(`${after}\n再接一段。\n`)).toEqual(
        parseMarkdownIntoBlocks(`${after}\n再接一段。\n`),
      );
    }
  });

  it('出现 `[^` 时把全文交给参考实现（保守退让，不是静默分叉）', () => {
    const reference = vi.fn(parseMarkdownIntoBlocks);
    const incremental = createIncrementalBlockParser(reference);

    incremental('第一段\n\n第二段\n');
    reference.mockClear();

    const withFootnote = '第一段\n\n第二段\n\n[^1]: 脚注定义\n';
    incremental(withFootnote);

    expect(reference.mock.calls[reference.mock.calls.length - 1]?.[0]).toBe(withFootnote);
  });

  it('恰好只冻结"除最后一块以外"的块', () => {
    const reference = vi.fn(parseMarkdownIntoBlocks);
    const incremental = createIncrementalBlockParser(reference);

    incremental('第一段\n\n第二段\n');
    reference.mockClear();

    incremental('第一段\n\n第二段\n\n第三段\n');

    const tail = reference.mock.calls[0]?.[0] ?? '';
    // 多冻结一块（第三段也冻住）就会漏掉它；少冻结一块（第二段也重解析）就白丢了收益。
    expect(tail.startsWith('第二段')).toBe(true);
    expect(tail.endsWith('第三段\n')).toBe(true);
  });

  it('参考实现累计收到的字符数明显少于前缀总量（真增量，而不是直通全文）', () => {
    const reference = vi.fn(parseMarkdownIntoBlocks);
    const incremental = createIncrementalBlockParser(reference);

    for (const prefix of PREFIXES) {
      incremental(prefix);
    }

    // 直通实现会让这个比值等于 1；字符串是原始值，按值比较的断言挡不住直通，所以这里比字符量。
    const passedChars = reference.mock.calls.reduce((sum, call) => sum + String(call[0]).length, 0);
    const prefixChars = PREFIXES.reduce((sum, prefix) => sum + prefix.length, 0);
    const ratio = passedChars / prefixChars;

    expect(ratio, `传给参考实现的字符量占比 ${ratio.toFixed(3)}`).toBeLessThan(0.8);
  });

  it('只有一块时不做冻结（整块都在变）', () => {
    const incremental = createIncrementalBlockParser(parseMarkdownIntoBlocks);

    expect(incremental('单段')).toEqual(parseMarkdownIntoBlocks('单段'));
    expect(incremental('单段继续增长')).toEqual(parseMarkdownIntoBlocks('单段继续增长'));
  });

  it('非追加编辑（中段被改写）时退回整体解析，结果仍与参考一致', () => {
    const reference = vi.fn(parseMarkdownIntoBlocks);
    const incremental = createIncrementalBlockParser(reference);

    incremental('第一段\n\n第二段\n');
    reference.mockClear();

    const edited = '改写的开头\n\n第二段\n';
    expect(incremental(edited)).toEqual(parseMarkdownIntoBlocks(edited));
    expect(reference.mock.calls[reference.mock.calls.length - 1]?.[0]).toBe(edited);
  });

  it('同一输入重复调用结果稳定', () => {
    const incremental = createIncrementalBlockParser(parseMarkdownIntoBlocks);
    const once = incremental(DOCUMENT);
    const twice = incremental(DOCUMENT);

    expect(twice).toEqual(once);
  });

  it('流式正文确实注入了增量分块（源码契约，防止接线被静默摘掉）', () => {
    const source = readFileSync(
      // 用本文件的位置定位源文件，而不是 `process.cwd()`：后者只在"从仓库根跑 vitest"时成立，
      // 从别的目录跑（编辑器集成、单文件调试）会静默失败或误判。
      // 也不能写成 `new URL('./x', import.meta.url)`：Vite 会把这种写法当成资源 URL 改写成
      // http 地址，`fileURLToPath` 随后抛 ERR_INVALID_URL_SCHEME（先例见
      // `CodeMuxThread.navActiveSource.test.ts:37`）。沿用 dirname + join。
      // （`本文件` = `src/lib/`，源文件在 `src/components/`，所以只退一级。）
      join(dirname(fileURLToPath(import.meta.url)), '../components/agent/assistant-ui/CodeMuxThread.tsx'),
      'utf8',
    );

    // 只有"每实例一份缓存 + 真的传进 Streamdown"两件事同时成立，这条优化才生效。
    expect(source).toMatch(/createIncrementalBlockParser\(parseMarkdownIntoBlocks\)/);
    expect(source).toMatch(/parseMarkdownIntoBlocksFn=\{blockParser\}/);
  });
});

/**
 * 会踩到**上游块边界特殊规则**的语料，用来逐字符比对：
 *
 * - `[^0-9]`：代码块里的取反字符类同样命中上游的脚注正则（无锚点），触发"全文当一块"的早退；
 * - `[^1]` / `[^1]:`：真脚注；
 * - `$$`：上游有"奇数个 `$$` 时把下一个 token 并进上一块"的奇偶合并；
 * - 未闭合 `<div>`：上游有 HTML 标签栈，栈非空时后续 token 全部并入上一块。
 *
 * 这些规则里只有脚注那条是**非局部**的（要看全文），另外两条只看前缀。逐字符比对的意义在于：
 * 前缀局部性一旦被破坏，分叉点会落在"某个字符刚追加进来"的那一步，而不是均匀分布在采样点上。
 */
const BOUNDARY_TRICKY_DOCUMENTS = [
  [
    '先给结论。',
    '',
    '```ts',
    'const re = /[^0-9]/g;',
    'const s = String(value);',
    '```',
    '',
    '就是这样。',
  ].join('\n'),
  ['第一段。', '', '带脚注引用[^1]。', '', '[^1]: 定义在最后。'].join('\n'),
  ['行间公式：', '', '$$', 'E = mc^2', '$$', '', '公式之后的一段话。'].join('\n'),
  [
    '未闭合的 HTML：',
    '',
    '<div class="box">',
    '',
    '里面还有一段。',
    '',
    '</div>',
    '',
    '收尾。',
  ].join('\n'),
];

describe('createIncrementalBlockParser 的逐字符前缀一致性', () => {
  it('每一个字符前缀的分块结果都与参考实现逐项一致（含触发全局规则的语料）', () => {
    for (const document of BOUNDARY_TRICKY_DOCUMENTS) {
      const incremental = createIncrementalBlockParser(parseMarkdownIntoBlocks);

      for (let length = 1; length <= document.length; length += 1) {
        const prefix = document.slice(0, length);
        const actual = incremental(prefix);
        const expected = parseMarkdownIntoBlocks(prefix);

        expect(
          actual,
          `前缀长度 ${length} 处与参考实现不一致：${JSON.stringify(prefix.slice(-40))}`,
        ).toEqual(expected);
      }
    }
  });
});
