/**
 * 源码契约（工单 02 成本项）：导航热循环内禁止读取布局几何。
 *
 * 单独成一个文件（node 环境、不挂 jsdom），因为要按现有先例
 * （`src/lib/facades/facade-boundary.test.ts`）读源码文本：jsdom 环境里
 * `import.meta.url` 不是 file 地址，`fileURLToPath` 会拒绝。
 *
 * 这条不变量是「滚动时不再逐条测量」的守卫：`getBoundingClientRect` 的调用次数在
 * jsdom 里读不出真实成本，只能用源码文本钉死 —— 工单 01 的基准负责给出调用次数，
 * 本文件负责防止后续改动把逐条测量悄悄塞回热路径。
 *
 * 口径：`scrollTop` 不算布局几何 —— 它是滚动位置，不读它就无法判断滚到哪里；
 * 工单 01 的基准计数器（`longSessionBenchmark.ts`）同样不统计它。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 被契约禁止出现在热循环里的布局几何读取。 */
const LAYOUT_READ_TOKENS = [
  'getBoundingClientRect',
  'getClientRects',
  'getElementById',
  'querySelector',
  'offsetTop',
  'offsetLeft',
  'offsetHeight',
  'offsetWidth',
  'scrollHeight',
  'scrollWidth',
  'clientHeight',
  'clientWidth',
];

// 不能用 `new URL('./CodeMuxThread.tsx', import.meta.url)`：Vite 会把这种写法当成
// 资源 URL 改写成 http 地址（fileURLToPath 随后拒绝）。沿用先例的 dirname + join。
const THREAD_SOURCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'CodeMuxThread.tsx',
);
const THREAD_SOURCE = readFileSync(THREAD_SOURCE_PATH, 'utf8');

/** 取出 `function <name>(...) { ... }` 或 `const <name> = (...) => { ... }` 的函数体。 */
function extractFunctionBody(source: string, name: string): string {
  const declarationIndex = source.search(new RegExp(`(function ${name}\\s*\\(|const ${name} = )`));
  expect(declarationIndex, `源码里找不到 ${name}`).toBeGreaterThanOrEqual(0);

  const openBrace = source.indexOf('{', declarationIndex);
  expect(openBrace, `${name} 的函数体没有左花括号`).toBeGreaterThan(declarationIndex);

  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace, index + 1);
      }
    }
  }

  throw new Error(`${name} 的函数体没有闭合`);
}

describe('导航热循环的源码契约', () => {
  it('每帧回调内不读布局几何，且比较交给 pickActiveEventIndex', () => {
    const body = extractFunctionBody(THREAD_SOURCE, 'updateActive');

    for (const token of LAYOUT_READ_TOKENS) {
      expect(body, `updateActive 内出现了布局读取 ${token}`).not.toContain(token);
    }
    expect(body).toContain('pickActiveEventIndex(');
  });

  it('排帧回调只负责调度，不读布局几何', () => {
    const body = extractFunctionBody(THREAD_SOURCE, 'scheduleUpdateActive');

    expect(body).toContain('requestAnimationFrame');
    for (const token of LAYOUT_READ_TOKENS) {
      expect(body, `scheduleUpdateActive 内出现了布局读取 ${token}`).not.toContain(token);
    }
  });

  it('比较函数本身不读布局几何', () => {
    const body = extractFunctionBody(THREAD_SOURCE, 'pickActiveEventIndex');

    for (const token of LAYOUT_READ_TOKENS) {
      expect(body, `pickActiveEventIndex 内出现了布局读取 ${token}`).not.toContain(token);
    }
  });

  it('几何读取只发生在测量事务里（否则上面的断言是空洞的）', () => {
    const body = extractFunctionBody(THREAD_SOURCE, 'measureNavOffsets');

    expect(body).toContain('getBoundingClientRect');
    expect(body).toContain('getElementById');
  });

  it('逐项测量的写法不再出现在热路径里', () => {
    // 改动前的老写法：热循环里 `getElementById('msg-' + …)` + `getBoundingClientRect()`。
    // 现在这两者只允许出现在 measureNavOffsets 与 scrollToMessage（落点在另一条工作流）。
    const occurrences = THREAD_SOURCE.split('getElementById(`msg-${').length - 1;
    expect(occurrences).toBe(2);
  });
});
