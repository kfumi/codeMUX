import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 界面字号令牌守卫。
 *
 * 规则：UI 文字的字号必须走 `src/styles/globals.css` 里由 `--ui-font-size` 派生的
 * `text-ui-*` 令牌（或按代码字号走的 `text-code`），不得写绝对像素、也不得内联复刻
 * 令牌的 calc 公式。写死的 px 在用户调整「界面字号 / 代码字体大小」时纹丝不动，
 * 会和相邻文字错层 —— 这正是本次全仓排查的起因。
 *
 * 新增例外请在下方的 ALLOWED_FILES 里写清理由，不要放宽这里的匹配。
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const GLOBALS_CSS = join(SRC_DIR, 'styles', 'globals.css');

/**
 * 例外清单：字号跟随固定 px 的方块尺寸（图标内的字母/数字徽标），
 * 或仅在 `import.meta.env.DEV` 下加载的开发工具。
 */
const ALLOWED_FILES = new Set([
  // 20px 方块内的文件扩展名徽标（`size-5`）。
  'src/components/assistant-ui/diff-viewer.tsx',
  // 20px 方块内的 A/M/D 变更状态字母（`h-5 w-5`）。
  'src/components/workspace/review/ReviewPanel.tsx',
  // 28px 方块内的提供商品牌首字母（`h-7 w-7`）。
  'src/components/settings/ProviderBrandIcon.tsx',
  // 纯装饰圆点，无文本语义。
  'src/components/preview/PreviewPanel.tsx',
  // 仅 DEV 加载的性能浮层。
  'src/components/dev/PerfOverlay.tsx',
  'src/components/dev/PerfOverlay.css',
]);

/** `text-[11px]` / `text-[0.75rem]` / 内联复刻令牌公式的 `text-[max(...)]`。 */
const HARDCODED_TEXT_UTILITY = /text-\[\s*(?:max\(|\d+(?:\.\d+)?(?:px|rem|em)\b)/g;
/** React 内联 style 的字面量字号（`fontSize: codeFontSize` 这类变量赋值不算）。 */
const HARDCODED_INLINE_FONT_SIZE = /fontSize:\s*(?:\d|'\d)/g;
/** CSS 里的绝对字号（前置断言排除 `--ui-font-size` / `--code-font-size` 这类自定义属性名）。 */
const HARDCODED_CSS_FONT_SIZE = /(?:^|[^\w-])font-size:\s*\d+(?:\.\d+)?(?:px|rem|em)\b/g;

/** globals.css 里唯一允许的绝对字号：`html` 的 rem 基准（有意固定，与界面字号无关）。 */
const ALLOWED_CSS_ROOT_FONT_SIZE = 'font-size: 16px';

/** 递归收集 src 下的 ts/tsx/css 源文件（排除测试自身，与 store-double-write 同法）。 */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx|css)$/.test(full)) continue;
    if (/\.test\.(ts|tsx)$/.test(full)) continue;
    out.push(full);
  }
  return out;
}

function posixRelative(full: string): string {
  return relative(SRC_DIR, full).split(sep).join('/');
}

/** 收集 `src/...` 相对路径下的全部命中，用于一次性断言（比逐文件 assert 更好读）。 */
function collectOffenders(pattern: RegExp, extraFilter?: (line: string) => boolean): string[] {
  const offenders: string[] = [];
  for (const full of listSourceFiles(SRC_DIR)) {
    const rel = posixRelative(full);
    if (ALLOWED_FILES.has(`src/${rel}`)) continue;
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (extraFilter && !extraFilter(line)) return;
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (!match) return;
      offenders.push(`src/${rel}:${index + 1} → ${match[0]}`);
    });
  }
  return offenders.sort();
}

describe('界面字号令牌守卫', () => {
  it('组件里没有写死的绝对字号 text-[Npx]', () => {
    expect(collectOffenders(HARDCODED_TEXT_UTILITY)).toEqual([]);
  });

  it('组件里没有内联复刻令牌公式或直接写 fontSize 数字', () => {
    expect(collectOffenders(HARDCODED_INLINE_FONT_SIZE)).toEqual([]);
  });

  it('CSS 里除 html 的 rem 基准外没有写死的绝对字号', () => {
    expect(
      collectOffenders(HARDCODED_CSS_FONT_SIZE, (line) => !line.includes(ALLOWED_CSS_ROOT_FONT_SIZE)),
    ).toEqual([]);
  });

  it('每个字号令牌都派生自 --ui-font-size 或 --code-font-size', () => {
    const css = readFileSync(GLOBALS_CSS, 'utf8');
    const themeStart = css.indexOf('@theme {');
    const themeEnd = css.indexOf('\n}', themeStart);
    expect(themeStart).toBeGreaterThan(-1);
    expect(themeEnd).toBeGreaterThan(themeStart);
    const theme = css.slice(themeStart, themeEnd);

    const declaration = /(--text-ui-[a-z]+|--text-(?:xs|sm|base|lg|xl|2xl|3xl)):\s*([^;]+);/g;
    const found: string[] = [];
    for (const match of theme.matchAll(declaration)) {
      const [, name, value] = match;
      found.push(name);
      expect(
        /var\(--ui-font-size\)|var\(--text-ui-|var\(--code-font-size\)/.test(value),
        `${name} 写了固定值 ${value.trim()}，没有派生自用户字号设置`,
      ).toBe(true);
    }

    // 令牌梯子本身也要在（防止有人整段删掉后守卫静默通过）。
    for (const required of ['--text-ui-micro', '--text-ui-caption', '--text-ui-meta', '--text-ui-compact', '--text-ui-body']) {
      expect(found).toContain(required);
    }
  });
});
