/**
 * 源码契约：窗口拖拽区与浮层的层级关系。
 *
 * 背景：自绘标题栏用 `-webkit-app-region: drag` 换窗口拖动能力，但拖拽区是
 * **窗口级**命中测试 —— Chromium 按 app-region 区域的叠加结果决定这一下是拖
 * 窗口还是给页面，浮层的 z-index 不参与。任务详情这类高弹窗顶到视口上沿时，
 * 右上角关闭按钮正好落进标题栏 48px 拖拽带，表现就是「点不了、没反应」。
 *
 * 所以浮层（Radix 弹窗 / popper、sonner toast、自定义遮罩）必须显式声明
 * `no-drag`，而且必须落在真正有盒子尺寸的浮层元素上 —— portal 的包装层是
 * 零高度 div，对它声明相减不到任何面积。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = readFileSync(join(HERE, 'globals.css'), 'utf8');

/** 取出某条选择器规则体（到下一个 `}` 为止）。 */
function ruleBody(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = GLOBALS_CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : null;
}

describe('窗口拖拽区与浮层', () => {
  it('标题栏拖拽区仍由 data-app-drag-region 声明 drag', () => {
    expect(ruleBody('*[data-app-drag-region]')).toContain('-webkit-app-region: drag');
  });

  it('浮层容器声明 no-drag（否则顶部弹窗的关闭按钮会被拖拽区吞掉点击）', () => {
    const group = GLOBALS_CSS.match(/\[role='dialog'\][\s\S]*?\{([^}]*)\}/);
    expect(group, '缺少浮层 no-drag 规则').not.toBeNull();
    const [whole, body] = group!;
    for (const selector of [
      "[role='dialog']",
      "[role='alertdialog']",
      '[data-radix-popper-content-wrapper]',
      '[data-dialog-scrim]',
      '[data-sonner-toaster]',
      '.app-drag-none',
    ]) {
      expect(whole, selector).toContain(selector);
    }
    expect(body).toContain('-webkit-app-region: no-drag');
  });
});
