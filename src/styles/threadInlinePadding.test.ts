/**
 * 源码契约：对话列的内边距必须随**列宽**收缩，不能只看窗口。
 *
 * 背景：`--thread-inline-padding` 曾是 `1.25rem` + `@media (min-width: 860px)`
 * 跳到 `2.5rem` —— 媒体查询认的是窗口宽。侧栏或标签页把对话列压到 ~500px 时，
 * 窗口仍 ≥860，于是 40px 的内边距比流式让位边距（10% ≈ 25px）还大，正文只剩
 * 列宽的 ~70%。改成百分比 `clamp()` 后，基宽是包含块（对话列），自然跟着缩。
 *
 * 口径：`%` 在 padding 上按包含块的 inline size 解析，所以这条 token 只能用在
 * `padding-inline` 这类认百分比的属性上 —— 若哪天有人把它用到 `gap` 之类的
 * 纯 length 属性，整条声明会失效，这里也顺手把它钉死在同一个消费者上。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = readFileSync(join(HERE, 'globals.css'), 'utf8');

describe('对话列内边距 token', () => {
  it('取值是随列宽收缩的百分比 clamp，上下限保住窄列呼吸与宽窗原样', () => {
    expect(GLOBALS_CSS).toContain('--thread-inline-padding: clamp(1.25rem, 4%, 2.5rem);');
  });

  it('不再用窗口媒体查询覆盖它', () => {
    // 这条曾经是 `@media (min-width: 860px) { :root { --thread-inline-padding: 2.5rem } }`。
    // 窗口宽的查询在「窗口宽、对话列窄」的场景下会给出相反答案。
    const overrides = GLOBALS_CSS.match(
      /@media[^{]*\{[\s\S]{0,200}?--thread-inline-padding/gu,
    );
    expect(overrides).toBeNull();
  });

  it('只有对话列全线消费它，且用在认百分比的 padding-inline 上', () => {
    const consumers = [...GLOBALS_CSS.matchAll(/[a-z-]+:\s*var\(--thread-inline-padding\)/gu)].map(
      (match) => match[0],
    );
    expect(consumers).toEqual(['padding-inline: var(--thread-inline-padding)']);
  });
});
