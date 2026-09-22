/**
 * 源码契约：动效一律走语义 token，不得回退到字面量时长 / 手写缓动曲线。
 *
 * 背景：动效时长与缓动曾散落在 40+ 个组件里（数字时长 150/200/300ms、7 处手写的
 * cubic-bezier 缓动）。这些值与语义 token（fast/normal/slow、ease-motion-*）重复，
 * 改一处观感就会漂移。此测试按现有先例（`CodeMuxThread.navActiveSource.test.ts`
 * 的源码契约）读源码文本，防止后续改动把字面量悄悄塞回来。
 *
 * 口径：只扫非测试的生产源码；测试文件里允许出现这些字面量（本文件自身就在断言它们）。
 * 一次性/超出 300ms 纪律的例外不在禁用之列——本测试只钉死已有语义替代品的写法。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..');
const GLOBALS_CSS = readFileSync(join(SRC_ROOT, 'styles', 'globals.css'), 'utf8');

/** 已被语义 token 取代、不应再出现在生产源码里的写法。 */
const BANNED_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: '字面量数字时长 duration-<n>（用 duration-fast|normal|slow）', pattern: /duration-\d+\b/ },
  { name: '任意值时长（duration 方括号写法，用 duration-fast|normal|slow）', pattern: /duration-\[[^\]]*\]/ },
  { name: '动画时长 animation-duration 方括号写法（用 duration-* 驱动 --tw-duration）', pattern: /animation-duration-\[/ },
  { name: '手写动画缓动 animation-timing-function（用 ease-motion-*）', pattern: /\[animation-timing-function:(cubic-bezier|ease)/ },
  { name: '手写 cubic-bezier 缓动工具类（用 ease-motion-*）', pattern: /ease-\[cubic-bezier\(/ },
  { name: 'Tailwind 关键字缓动 ease-out|in|in-out（用 ease-motion-*）', pattern: /(?<![\w:-])ease-(in-out|out|in)(?![\w-])/ },
];

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    files.push(full);
  }
  return files;
}

describe('动效 token 源码契约', () => {
  it('globals.css 定义了三档时长与三种缓动的原始值', () => {
    expect(GLOBALS_CSS).toContain('--motion-duration-fast: 150ms;');
    expect(GLOBALS_CSS).toContain('--motion-duration-normal: 200ms;');
    expect(GLOBALS_CSS).toContain('--motion-duration-slow: 300ms;');
    expect(GLOBALS_CSS).toContain('--motion-ease-out: cubic-bezier(0.22, 1, 0.36, 1);');
    expect(GLOBALS_CSS).toContain('--motion-ease-in: cubic-bezier(0.4, 0, 1, 1);');
    expect(GLOBALS_CSS).toContain('--motion-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);');
    expect(GLOBALS_CSS).toContain('--motion-ease-standard: cubic-bezier(0.32, 0.72, 0, 1);');
  });

  it('@theme 把原始值映射成 duration-* / ease-motion-* 工具类', () => {
    expect(GLOBALS_CSS).toContain('--transition-duration-fast: var(--motion-duration-fast);');
    expect(GLOBALS_CSS).toContain('--transition-duration-normal: var(--motion-duration-normal);');
    expect(GLOBALS_CSS).toContain('--transition-duration-slow: var(--motion-duration-slow);');
    expect(GLOBALS_CSS).toContain('--ease-motion-out: var(--motion-ease-out);');
    expect(GLOBALS_CSS).toContain('--ease-motion-in: var(--motion-ease-in);');
    expect(GLOBALS_CSS).toContain('--ease-motion-in-out: var(--motion-ease-in-out);');
    expect(GLOBALS_CSS).toContain('--ease-motion-standard: var(--motion-ease-standard);');
  });

  it('生产源码里不再有字面量标准档位与手写缓动', () => {
    const offenders: string[] = [];
    for (const file of walkSourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const { name, pattern } of BANNED_PATTERNS) {
        if (pattern.test(source)) {
          offenders.push(`${file.slice(SRC_ROOT.length + 1)}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
