import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LAYOUT_DIVIDER_CLASS } from './layoutTokens';

// 按 import.meta.url 定位源码，而不是 cwd —— 从仓库根以外的目录起 vitest 时
// process.cwd() 指向别处，契约测试会静默读不到文件。
const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = readFileSync(join(HERE, '..', 'styles', 'globals.css'), 'utf8');
const MAIN_LAYOUT_SOURCE = readFileSync(join(HERE, '..', 'components', 'layout', 'MainLayout.tsx'), 'utf8');

describe('布局分割线 token', () => {
  it('使用统一的颜色，且完全不透明以保证圆角弯折处与直线段粗细一致', () => {
    expect(LAYOUT_DIVIDER_CLASS).toBe('border-[hsl(var(--layout-divider))]');
  });
});

describe('内容面圆角 token', () => {
  it('三个 token 驱动：起始侧、终止侧、两者较大值', () => {
    expect(GLOBALS_CSS).toContain('--content-radius-start: 0px;');
    expect(GLOBALS_CSS).toContain('--content-radius-end: 0px;');
    expect(GLOBALS_CSS).toContain(
      '--content-radius-max: max(var(--content-radius-start), var(--content-radius-end));',
    );
  });

  it('拆成两层：外层给圆角形状与 elevation，内层才 clip-path', () => {
    // `clip-path` 会把元素连同 box-shadow 一起裁掉 —— 阴影和裁切必须在两个元素上。
    expect(GLOBALS_CSS).toContain('.content-surface-root {');
    expect(GLOBALS_CSS).toContain('.content-surface {');
    expect(GLOBALS_CSS).toContain('clip-path: inset(');
    expect(GLOBALS_CSS).toContain('var(--content-radius-start) var(--content-radius-end)');
    // 外层承担圆角形状（border-*-radius），内层只裁切 —— 两者的职责不能互换。
    expect(GLOBALS_CSS).toContain('border-start-end-radius: var(--content-radius-end);');
    // 圆角面本身不再用 border-radius —— 圆角是**裁切**出来的，
    // 分隔线画在它下面就能严丝合缝，不需要补偿抗锯齿的 SVG 弧线。
    expect(GLOBALS_CSS).not.toMatch(/\.content-surface\s*\{[^}]*border-radius/);
  });

  it('内容面浮起时起始侧取 --radius-content，终止侧贴窗口边缘保持直角', () => {
    expect(GLOBALS_CSS).toContain(".content-surface-root[data-floats='true'] {");
    expect(GLOBALS_CSS).toContain('--content-radius-start: var(--radius-content);');
    expect(GLOBALS_CSS).toContain('--content-radius-end: 0px;');
    // 内容面圆角是阶梯的一档（Codex 的 12px 基数 × 1.25 超椭圆 = 15px），
    // 随两个缩放因子一起变，而不是写死的 15px。
    expect(GLOBALS_CSS).toContain(
      '--radius-content: calc(0.9375rem * var(--radius-scale) * var(--radius-superellipse-scale));',
    );
  });

  it('删掉了手写 SVG 弧线 workaround 及其分割线补偿', () => {
    expect(MAIN_LAYOUT_SOURCE).not.toContain('vectorEffect="non-scaling-stroke"');
    expect(MAIN_LAYOUT_SOURCE).not.toContain('A11.5 11.5');
    // 分隔线改成侧栏自己的一条 border-r，不再由内容面画「直线段 + 弧线段」。
    expect(MAIN_LAYOUT_SOURCE).toContain('border-[hsl(var(--layout-divider))]');
    // 外层负责 elevation，内层负责 clip-path —— MainLayout 里必须是两个元素。
    expect(MAIN_LAYOUT_SOURCE).toContain('content-surface-root');
    expect(MAIN_LAYOUT_SOURCE).toContain('content-surface flex');
  });
});
