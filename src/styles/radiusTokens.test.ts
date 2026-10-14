/**
 * 源码契约：圆角必须走阶梯 token，不得回退到字面量 px / rem。
 *
 * 背景：圆角曾是单一 `--radius` 加几个 `calc()` 派生，组件里也散落着
 * `rounded-[6px]` 这类字面量。Codex 的模型是「八档基准阶梯 + 用户缩放档 +
 * 超椭圆渐进增强」——阶梯形状由 tokens/layoutTokens.test.ts 之类的契约守住，
 * 而「不要在组件里写字面量圆角」由本文件守住。两者缺一不可：只守阶梯，
 * 组件照样可以绕开它。
 *
 * 口径：只扫生产源码（组件与 CSS）；测试文件里允许出现字面量（本文件自身就在断言它们）。
 * 例外：`rounded-full`（胶囊/圆形）与 `rounded-none` 不是「圆角档位」，不禁。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..');
const GLOBALS_CSS = readFileSync(join(SRC_ROOT, 'styles', 'globals.css'), 'utf8');

/** Codex 的八档圆角阶梯（@theme 里以 --radius-<档> 声明）。 */
export const RADIUS_LADDER = {
  '2xs': '0.125rem',
  xs: '0.25rem',
  sm: '0.375rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
  '2xl': '1.5rem',
  '3xl': '2rem',
} as const;

const BANNED_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // Tailwind 任意值圆角：rounded-[6px] / rounded-[0.5rem] / rounded-[var(--x)]
  { name: '任意值圆角 rounded-[…]（用阶梯工具类 rounded-2xs|xs|sm|md|lg|xl|2xl|3xl|full）', pattern: /rounded-\[[^\]]*\]/ },
  // CSS 里的字面量圆角。`999px` / `9999px` / `50%` / `100%` 这些胶囊与圆形
  // 现在统一走 `var(--radius-full)`，`inherit` 是继承语义 —— 都排除。
  // 负向前瞻里必须自带 `\s*`，否则正则会回溯掉前导空格让排除失效。
  {
    name: '字面量圆角 border-radius（用 var(--radius-*)）',
    pattern: /border-radius:\s*(?!\s*(?:50%|100%|999px|9999px|inherit|initial|unset))[^;]*?(?:\d+px|\d*\.?\d+rem)/,
  },
  // 单角字面量：border-top-left-radius: 6px
  {
    name: '字面量单角圆角 border-*-radius（用 var(--radius-*)）',
    pattern: /border-(?:top|bottom)-(?:left|right)-radius:\s*(?!\s*(?:inherit|initial|unset))[^;]*?(?:\d+px|\d*\.?\d+rem)/,
  },
  // 已废弃的单一圆角变量
  { name: '已废弃的 var(--radius) 单一圆角变量（用阶梯）', pattern: /var\(--radius\)/ },
  // 内联 style 里的字面量圆角
  { name: '内联圆角 borderRadius 字面量', pattern: /borderRadius:\s*['"`]?\s*\d+(?:\.\d+)?(?:px|rem)/ },
];

/**
 * 明确的豁免：文件路径 → 理由。
 *
 * 每一条豁免都必须写清楚「为什么这里拿不到阶梯 token」，否则就成了绕过契约的后门。
 */
const EXEMPTIONS: Record<string, string> = {
  // 注入到**被检查的第三方页面**里的 DOM（浏览器 host 的元素高亮 tooltip）。
  // 那些文档里没有本应用的 CSS 变量，只能写字面量；它的配色也刻意不跟随主题
  // （要压在任意网页上都能看清）。
  [join('lib', 'elementSelector.ts')]: '注入第三方页面的 DOM，拿不到本应用的 CSS 变量',
};

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkSourceFiles(full));
      continue;
    }
    if (!/\.(tsx?|css)$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    files.push(full);
  }
  return files;
}

describe('圆角阶梯源码契约', () => {
  it('globals.css 声明了 Codex 的八档基准阶梯', () => {
    for (const [step, base] of Object.entries(RADIUS_LADDER)) {
      expect(GLOBALS_CSS, `--radius-${step}`).toContain(
        `--radius-${step}: calc(${base} * var(--radius-scale) * var(--radius-superellipse-scale));`,
      );
    }
  });

  it('阶梯由用户缩放档与超椭圆放大两个因子驱动', () => {
    expect(GLOBALS_CSS).toContain('--radius-scale: 1;');
    // 默认 1（在 @layer base 里），支持 superellipse 的引擎上被 @supports 改写成 1.25。
    expect(GLOBALS_CSS).toContain('--radius-superellipse-scale: 1;');
    expect(GLOBALS_CSS).toContain('--radius-superellipse-scale: 1.25;');
    expect(GLOBALS_CSS).toContain('@supports (corner-shape: superellipse(1.5))');
    // 只对桌面壳生效：PC 浏览器与移动端按设计强制退回 1 倍标准圆角。
    expect(GLOBALS_CSS).toContain("html[data-host='desktop'] {");
    // @supports 块必须在 @layer base 之外（无 layer 才能盖过 @layer base 的默认值）。
    expect(GLOBALS_CSS.indexOf('@supports (corner-shape: superellipse(1.5))')).toBeGreaterThan(
      GLOBALS_CSS.indexOf('.dark input::placeholder'),
    );
  });

  it('内容面圆角是阶梯的一档（15px = 12px 基数 × 1.25 超椭圆），随两个缩放因子一起变', () => {
    // 写成字面量 15px 的话，sharp 档下整条阶梯都在缩放、唯独它不变 ——
    // 「相对关系保持不变」就不成立了。
    expect(GLOBALS_CSS).toContain(
      '--radius-content: calc(0.9375rem * var(--radius-scale) * var(--radius-superellipse-scale));',
    );
  });

  it('生产源码里不再有字面量圆角', () => {
    const offenders: string[] = [];
    for (const file of walkSourceFiles(SRC_ROOT)) {
      const relative = file.slice(SRC_ROOT.length + 1);
      if (EXEMPTIONS[relative]) continue;
      const source = readFileSync(file, 'utf8');
      for (const { name, pattern } of BANNED_PATTERNS) {
        if (pattern.test(source)) {
          offenders.push(`${relative}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('豁免清单里的文件都真的存在（防止路径写错后豁免变成空转）', () => {
    for (const relative of Object.keys(EXEMPTIONS)) {
      expect(() => statSync(join(SRC_ROOT, relative)), relative).not.toThrow();
    }
  });
});
