import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 表单字段间距守卫。
 *
 * 规则：容器里的 `space-y-N` 不能依赖行内元素撑出纵向间距。Tailwind v4 的 `space-y-N`
 * 把外边距加在**前一个兄弟**的 `margin-block-end` 上（`--tw-space-y-reverse:0` →
 * `margin-block-start:0; margin-block-end:N`；v3 才是给后一个兄弟加 `margin-top`），
 * 而 `<label>`/`<span>` 默认 `display:inline`，**行内元素的纵向外边距会被浏览器直接忽略**。
 * 于是「space-y-N 容器 + 行内 label/span 打头」这种写法里，间距实际只剩行盒那 2px。
 *
 * 实测（项目编译后的真实 CSS，同一 dev server 下量到的像素）：`space-y-4` + 行内 label
 * → label 与输入框间距 2px；同容器改 `flex flex-col gap-3` → 12px。表单 label 贴着自己
 * 的输入框、且「改数值完全没效果」，就是踩了这个。
 *
 * 正确写法：`flex flex-col gap-N`（gap 与子元素 display 无关），或给 label/span 加 `block`。
 * 例外请写进下方的 ALLOWED_FILES 并注明理由，不要放宽这里的匹配。
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 例外的 `src/...` 相对路径（写清理由，默认应为空）。 */
const ALLOWED_FILES = new Set<string>();

/** 容器元素上带 `space-y-N` 且开标签在同一行结束。 */
const SPACE_Y_CONTAINER = /space-y-[0-9.]+(?:"|\s[^>]*?)>\s*$/;
/** 首个子元素是 label / span（行内，除非自带 block/flex/...）。 */
const INLINE_FIRST_CHILD = /^\s*<(?:label|span)\b/;
/** 让 label/span 变成块级/弹性子项、从而让 space-y-N 恢复生效的类。 */
const BLOCKISH = /\b(?:block|flex|grid|inline-block|inline-flex|list-item|table)\b/;
/** 静态可判定的 className 字面量。 */
const CLASS_NAME = /className="([^"]*)"/;

/** 递归收集 src 下的 ts/tsx 源文件（排除测试自身，与 appearanceTypography 同法）。 */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(full)) continue;
    if (/\.test\.(ts|tsx)$/.test(full)) continue;
    out.push(full);
  }
  return out;
}

function posixRelative(full: string): string {
  return relative(SRC_DIR, full).split(sep).join('/');
}

/**
 * 取容器之后第一个子元素的标签文本（可能跨行），用于判断它是不是行内 label/span。
 * `className={` 这类动态写法无法静态判定，直接放行（不猜）。
 */
function firstChildTag(lines: string[], containerIndex: number): string | null {
  let started = false;
  let tag = '';
  for (let i = containerIndex + 1; i < lines.length && i <= containerIndex + 8; i += 1) {
    const line = lines[i];
    if (!started) {
      if (line.trim() === '') continue;
      if (!INLINE_FIRST_CHILD.test(line)) return null;
      started = true;
    }
    tag += `${line} `;
    if (line.includes('>')) break;
  }
  return started ? tag : null;
}

/** 收集全部命中，一次性断言（比逐文件 assert 更好读）。 */
function collectOffenders(): string[] {
  const offenders: string[] = [];
  for (const full of listSourceFiles(SRC_DIR)) {
    const rel = posixRelative(full);
    if (ALLOWED_FILES.has(`src/${rel}`)) continue;
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!SPACE_Y_CONTAINER.test(line)) return;
      const childTag = firstChildTag(lines, index);
      if (childTag === null) return;
      if (childTag.includes('className={')) return; // 动态 className：不可静态判定。
      const className = CLASS_NAME.exec(childTag)?.[1] ?? '';
      if (BLOCKISH.test(className)) return;
      const container = /space-y-[0-9.]+/.exec(line)?.[0] ?? 'space-y-?';
      offenders.push(`src/${rel}:${index + 1} → ${container} + 行内 ${childTag.trim().slice(0, 24)}…`);
    });
  }
  return offenders.sort();
}

describe('表单字段间距守卫', () => {
  it('没有「space-y-N 容器 + 行内 label/span 打头」的写法（space-y 对行内元素无效）', () => {
    expect(collectOffenders()).toEqual([]);
  });
});
