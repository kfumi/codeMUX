/**
 * 出厂产物契约：`dist-web/` 里必须真的带上新的设计 token。
 *
 * 背景：外观 token 走的是「`src/styles/globals.css` 声明 → `@theme` 映射 →
 * Tailwind 产出工具类 → `applyAppearance` 运行时改写 CSS 变量」这条链。任何一环
 * 断掉（比如忘记映射 `--shadow-*` 命名空间、忘记在 `@theme` 里声明阶梯），
 * 开发态（Vite 直接吃源码）看不出来，但浏览器与移动宿主加载的是 `dist-web/`
 * 产物，用户看到的就是「桌面端对、网页端不对」。
 *
 * 这份测试直接读构建产物做断言。产物不存在时**跳过**（而不是失败）——
 * CI 的全量门禁是 `npm run build:web` 之后跑 `npx vitest run`。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CODEX_DARK_SEEDS, CODEX_LIGHT_SEEDS, deriveThemeTokens, hexToRgb, rgbToHslTriplet } from '../lib/colorDerivation';

const DIST_WEB = join(process.cwd(), 'dist-web', 'assets');
const BUILT = existsSync(DIST_WEB);
const CSS_FILES = BUILT ? readdirSync(DIST_WEB).filter((name) => name.endsWith('.css')) : [];
const BUILT_CSS = CSS_FILES.map((name) => readFileSync(join(DIST_WEB, name), 'utf8')).join('\n');

// 注意 `.` 前缀：只写 `toContain('shadow-elevation')` 会连 `:root` 里的
// `--shadow-elevation-*` **变量声明**一起匹配上，工具类根本没产出也会绿。
const REQUIRED_UTILITIES = [
  '.rounded-2xs',
  '.rounded-md',
  '.rounded-lg',
  '.rounded-xl',
  '.rounded-2xl',
  '.rounded-full',
  '.shadow-elevation-subtle',
  '.shadow-elevation',
  '.shadow-elevation-prominent',
  '.shadow-elevation-content',
  '.text-foreground',
  '.text-muted-foreground',
  '.text-foreground-tertiary',
  '.text-diff-added',
  '.text-diff-removed',
  '.bg-accent-bg',
];

describe.skipIf(!BUILT)('dist-web 出厂产物携带设计 token', () => {
  it('产物里有 CSS，且不是空壳', () => {
    expect(CSS_FILES.length).toBeGreaterThan(0);
    expect(BUILT_CSS.length).toBeGreaterThan(1000);
  });

  it('圆角阶梯的两个缩放因子与超椭圆渐进增强都在', () => {
    expect(BUILT_CSS).toContain('--radius-scale');
    expect(BUILT_CSS).toContain('--radius-superellipse-scale');
    // @supports 块必须出现在 base 默认值之后，才能可靠覆盖它。
    expect(BUILT_CSS).toContain('@supports (corner-shape:superellipse(1.5))');
    expect(BUILT_CSS.indexOf('@supports (corner-shape:superellipse(1.5))')).toBeGreaterThan(
      BUILT_CSS.indexOf('--radius-superellipse-scale'),
    );
    // 只对桌面壳生效：PC 浏览器 / 移动端按设计退回 1 倍标准圆角。
    // 产物里属性值的引号会被压缩器去掉，所以只断言选择器前缀。
    expect(BUILT_CSS).toContain('html[data-host=');
  });

  it('圆角阶梯的全部档位都进了产物（哪怕当前没有组件用到）', () => {
    // 断言的是 **token**，不是工具类：Tailwind 只按需产出 `rounded-*`，
    // 阶梯本身靠 `@theme static` 保证完整 —— 否则「这一档没人用」会让
    // 后来的人写任意值圆角，把阶梯契约从内部破掉。
    for (const step of ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full']) {
      expect(BUILT_CSS, `--radius-${step}`).toContain(`--radius-${step}:`);
    }
  });

it('阶梯 / elevation / 文字与 diff 色的工具类都真的产出了', () => {
    for (const util of REQUIRED_UTILITIES) {
      expect(
        BUILT_CSS.includes(`${util}{`) || BUILT_CSS.includes(`,${util}{`),
        util,
      ).toBe(true);
    }
  });

  it('浅色兜底值与派生引擎的默认种子逐项一致', () => {
    const tokens = deriveThemeTokens(CODEX_LIGHT_SEEDS, false);
    for (const name of [
      '--background',
      '--foreground',
      '--foreground-tertiary',
      '--border',
      '--primary',
      '--accent-bg',
      '--diff-added',
    ]) {
      expect(BUILT_CSS, name).toContain(`${name}:${tokens[name]}`);
    }
  });

  it('深色兜底值与派生引擎的默认种子逐项一致', () => {
    const tokens = deriveThemeTokens(CODEX_DARK_SEEDS, true);
    for (const name of [
      '--background',
      '--foreground',
      '--foreground-tertiary',
      '--border',
      '--primary',
      '--accent-bg',
      '--diff-added',
    ]) {
      expect(BUILT_CSS, name).toContain(`${name}:${tokens[name]}`);
    }
  });

  it('深色 surface 是纯黑（Codex 的 #000000），不是近黑', () => {
    expect(deriveThemeTokens(CODEX_DARK_SEEDS, true)['--background']).toBe(
      rgbToHslTriplet(hexToRgb(CODEX_DARK_SEEDS.surface)),
    );
    expect(BUILT_CSS).toContain('--background:0 0% 0%');
  });

  it('内容面的三个圆角 token 与 clip-path 都在产物里', () => {
    expect(BUILT_CSS).toContain('--content-radius-start');
    expect(BUILT_CSS).toContain('--content-radius-end');
    expect(BUILT_CSS).toContain('--content-radius-max');
    expect(BUILT_CSS).toContain('clip-path:inset(');
    // 圆角形状在外层、裁切在内层 —— clip-path 会把 box-shadow 一起裁掉。
    expect(BUILT_CSS).toContain('.content-surface-root');
    expect(BUILT_CSS).toContain('.content-surface');
  });
});
