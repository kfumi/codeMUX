import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';

interface InstructionComposerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  id?: string;
  disabled?: boolean;
  className?: string;
  textareaClassName?: string;
  /** 底部工具栏左侧内容（项目、智能体、权限等）。 */
  toolbar?: ReactNode;
  /** 底部工具栏右侧内容（模型、思考强度等），自动靠右。 */
  toolbarEnd?: ReactNode;
}

/**
 * 指令输入框 + 底部工具栏（发送框样式）。新建自动化与新建待办任务共用，
 * 让选择智能体 / 模型 / 思考强度等都收进输入框底部，保持各处表单一致。
 */
export function InstructionComposer({
  value,
  onChange,
  placeholder,
  rows = 6,
  id,
  disabled = false,
  className,
  textareaClassName,
  toolbar,
  toolbarEnd,
}: InstructionComposerProps) {
  const hasToolbar = toolbar != null || toolbarEnd != null;
  return (
    // 背景与 Input 字段一致（bg-muted/80）：在弹窗（暗色下是 surface-3）里
    // 也能与窗口背景拉开层次，同时让各处表单的指令框样式统一。
    <div className={cn('overflow-hidden rounded-lg border border-border/70 bg-muted/80', className)}>
      <textarea
        id={id}
        value={value}
        disabled={disabled}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'w-full resize-none border-0 bg-transparent px-3 py-3 text-ui-body text-foreground outline-none placeholder:text-muted-foreground focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50',
          textareaClassName,
        )}
      />
      {hasToolbar && (
        <div className="flex flex-wrap items-center gap-1 border-t border-border/60 px-2 py-1.5">
          {toolbar}
          {toolbarEnd != null && (
            <div className="ml-auto flex flex-wrap items-center gap-1">{toolbarEnd}</div>
          )}
        </div>
      )}
    </div>
  );
}
