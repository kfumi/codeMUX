import { keybindingDisplayParts, type ShortcutPlatform } from '../../lib/shortcuts/keyboardShortcuts';
import { cn } from '../../lib/utils';

/**
 * 键位展示：把键位字符串渲染成键帽或一行纯文本。
 *
 * 两处共用同一份渲染 —— 设置页的快捷键分区与搜索结果的命令分区；按钮上的
 * tooltip 提示走 `useShortcutHint`（只要一段文案，不渲染键帽）。
 *
 * 没有可展示键帽的键位（含显式解绑 `null`）按 `emptyLabel` 呈现：默认「未绑定」，
 * 搜索结果里传「已禁用」—— 它与「用出厂默认」是两件事，见 ADR 0013）。
 *
 * `variant`：`keycap` 是带描边的独立键帽（搜索用）；`plain` 是
 * `Ctrl + K` 形式的纯文本 —— 它已经坐在设置页的键位药丸里（药丸自带描边），
 * 再套一层键帽就出现了双层边框。
 *
 * 两种变体都跟随界面字体（`--font-ui`），不用等宽：键位不是代码，混排等宽会显得跳。
 */
export function ShortcutKeys({
  binding,
  platform,
  className,
  emptyLabel = '未绑定',
  variant = 'keycap',
}: {
  binding: string | null | undefined;
  platform: ShortcutPlatform;
  className?: string;
  /** 没有可展示键帽时（含显式解绑 `null`）的文案。 */
  emptyLabel?: string;
  /** `keycap`：独立键帽；`plain`：纯文本，供已有边框的容器使用。 */
  variant?: 'keycap' | 'plain';
}) {
  const parts = keybindingDisplayParts(binding, platform);

  if (parts.length === 0) {
    return <span className={cn('text-ui-caption text-muted-foreground', className)}>{emptyLabel}</span>;
  }

  if (variant === 'plain') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-ui-caption leading-none text-foreground',
          className,
        )}
      >
        {parts.map((part, index) => (
          // 同一个键位里修饰键不会重复，直接用文案当 key
          <span key={`${part}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 ? <span className="text-muted-foreground">+</span> : null}
            {part}
          </span>
        ))}
      </span>
    );
  }

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {parts.map((part, index) => (
        <kbd
          key={`${part}-${index}`}
          className="rounded-sm border border-border bg-secondary px-1.5 py-0.5 font-sans text-ui-caption leading-none text-muted-foreground"
        >
          {part}
        </kbd>
      ))}
    </span>
  );
}
