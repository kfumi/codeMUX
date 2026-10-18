/**
 * 源码契约：选项列表（菜单 / 下拉 / 单选组）的「选中」底色一律走共享的
 * `option-row` 阶梯，不得回退到弱 `bg-muted/NN` 或写死的调色板色号。
 *
 * 背景：这些选中态曾散落在十几个组件里，写法大致两类，各自都读不出选中：
 *  1. `bg-muted/56` + `bg-muted/64` 这类**相邻 alpha**。浅色主题下 `--muted`
 *     ≈ 98.8%，压在 `--surface-2` 面板上两个值都≈纯白，选中与悬停完全分不开。
 *  2. `!bg-neutral-200` / `dark:!bg-neutral-700`（model-selector）写死了调色板
 *     色号并带 `!important`：既绕开主题 token，换强调色 / 调对比度都不跟着动。
 * 它们的共同症状就是「选中效果不明显」。
 *
 * 阶梯定义在 `globals.css` 的 `@layer components` 里，三档：
 *   常态 → 光标（hover / focus / data-highlighted，ink 4.5%）→ 选中（ink 8%）。
 *
 * 特别钉死的一条：选中态**不能**用 Tailwind 的 `data-[…]:option-row-selected`
 * 变体 —— Tailwind v4 的变体只生成它自己的 utility，认不得这个手写类，写上去
 * 会被静默丢弃（编译产物里根本没有那条规则，选中态就彻底没底色了）。必须靠
 * globals.css 里的属性选择器。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..');
const GLOBALS_CSS = readFileSync(join(SRC_ROOT, 'styles', 'globals.css'), 'utf8');

const BANNED_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'Tailwind 变体套用 option-row-* 手写类（变体只认自身 utility，会被静默丢弃）',
    pattern: /data-\[[^\]]*\]:option-row/,
  },
];

/**
 * 写死色号的检查**只扫这些文件**：它们是选项行 / 菜单项的实现方，选中底色必须来自
 * option-row 阶梯。不能全局扫 —— `ProviderBrandIcon` 的各家品牌色、`McpSettings`
 * 与 `RuntimeSettings` 的状态徽章色都是**故意固定**的语义色（AGENTS.md 列的
 * 「intentionally fixed colors」那一类），跟选中态无关，扫进来只会逼着做无关重构。
 */
const PALETTE_SCOPED_FILES = [
  'components/model-selector.tsx',
  'components/ui/select.tsx',
  'components/ui/command.tsx',
  'components/ui/dropdown-menu.tsx',
  'components/agent/AgentPermissionSelector.tsx',
  'components/agent/AgentSelector.tsx',
  'components/agent/DraftWorkspaceToolbar.tsx',
  'components/agent/PermissionApprovalCard.tsx',
  'components/agent/assistant-ui/CodeMuxComposer.tsx',
  'components/automation/AutomationProjectPicker.tsx',
  'components/automation/ScheduleConfigurator.tsx',
  'components/browser/BrowserPanel.tsx',
  'components/browser/BrowserElementPills.tsx',
  'components/preview/PreviewPanel.tsx',
  'components/settings/FontPicker.tsx',
  'components/worktask/BranchPicker.tsx',
  'components/workspace/review/ReviewPanel.tsx',
];

/**
 * 「打勾但没有底色」——最常见的一种漏改：当前项用 Check 标出来了，行却没接
 * option-row-selected，于是选中态只剩一个符号，扫列表时完全读不出来。
 * 命中即要求同文件里出现过 option-row-selected。
 */
const CHECK_WITHOUT_BACKGROUND_FILES = [
  'components/agent/AgentSelector.tsx',
  'components/settings/FontPicker.tsx',
  'components/automation/AutomationProjectPicker.tsx',
  'components/worktask/BranchPicker.tsx',
  'components/automation/ScheduleConfigurator.tsx',
  'components/agent/DraftWorkspaceToolbar.tsx',
];

const PALETTE_PATTERN: RegExp = /(?:bg|text|border|ring|from|to|via)-(?:neutral|gray|zinc|slate|stone)-\d/;

/** 注释里提到这些写法是正常的（说明「原来是什么」），扫描前先剥掉。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

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

describe('选项列表选中态 token 源码契约', () => {
  it('globals.css 在 @layer components 里定义了三档阶梯', () => {
    expect(GLOBALS_CSS).toContain('.option-row {');
    expect(GLOBALS_CSS).toContain('.option-row-selected');
    // 光标档覆盖 hover / focus / Radix 的 data-highlighted。
    expect(GLOBALS_CSS).toMatch(/\.option-row-hover:hover[\s\S]*?\.option-row-hover\[data-highlighted\]/);
  });

  it('选中档比光标档更深', () => {
    const cursor = GLOBALS_CSS.match(/--foreground\) \/ 0\.045/);
    const selected = GLOBALS_CSS.match(/--foreground\) \/ 0\.08/);
    expect(cursor).toBeTruthy();
    expect(selected).toBeTruthy();
  });

  it('选中规则排在光标规则之后，悬停时不会退回浅色', () => {
    expect(GLOBALS_CSS.indexOf('.option-row-selected')).toBeGreaterThan(
      GLOBALS_CSS.indexOf('.option-row-hover:hover'),
    );
  });

  it('Radix / cmdk 的选中属性用属性选择器接进阶梯', () => {
    expect(GLOBALS_CSS).toContain("[data-state='checked'].option-row");
    expect(GLOBALS_CSS).toContain("[data-selected='true'].option-row");
  });

  it('生产源码里没有失效的 Tailwind 变体', () => {
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

  it('选项行所在的组件里没有写死的调色板色号', () => {
    const offenders: string[] = [];
    for (const relative of PALETTE_SCOPED_FILES) {
      const source = stripComments(readFileSync(join(SRC_ROOT, relative), 'utf8'));
      if (PALETTE_PATTERN.test(source)) {
        offenders.push(`${relative}: 写死的调色板色号`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('用 Check 标记当前项的列表都接上了 option-row-selected', () => {
    const offenders: string[] = [];
    for (const relative of CHECK_WITHOUT_BACKGROUND_FILES) {
      // 剥掉注释：光在注释里写「接上 option-row-selected」不算数。
      const source = stripComments(readFileSync(join(SRC_ROOT, relative), 'utf8'));
      if (!source.includes('option-row-selected')) {
        offenders.push(`${relative}: 用 Check 标了当前项，却没有 option-row-selected 底色`);
      }
    }
    expect(offenders).toEqual([]);
  });
});