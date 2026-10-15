/**
 * 输入区底排控件（`+` / 权限 / 自动接受 / 计划）的**共用外形**。
 *
 * Codex 的这一排是「无边框、无底色」的：控件平时只剩图标与文字，悬停或展开时才浮出一层
 * ink（`bg-foreground/8`，与标题栏那排窗口控件同一套写法）。之前这里每个控件都自带
 * `border border-border/40 bg-[hsl(var(--surface-2))]/70`，一排看过去像挂了几个小方块，
 * 是整排与 Codex 差得最明显的地方。
 *
 * 两个细节：
 * - 悬停用 ink 的 alpha 而不是某个固定表面色。控件压在**抬高档**（composer 的
 *   `--surface-1`）上，而 `--muted` / `--surface-3` 那几档是相对**表面种子**算的，
 *   深色下比 composer 还暗，悬停会变成「按下去」。
 * - 焦点环取不透明主色 + 2px 外偏移，外偏移底色就是 composer 自己的表面色。
 */
export const COMPOSER_BAR_CONTROL_CLASS = [
  'inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2',
  'text-xs font-medium text-muted-foreground outline-none transition-colors duration-fast',
  'hover:bg-foreground/8 hover:text-foreground',
  'data-[state=open]:bg-foreground/8 data-[state=open]:text-foreground',
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--surface-1))]',
  'disabled:pointer-events-none disabled:opacity-50',
].join(' ');

/** 只有一个图标的那种控件：方形、不留水平内边距。 */
export const COMPOSER_BAR_ICON_CONTROL_CLASS = 'w-7 px-0';
