import { Bot, FileText, Folder, Globe, Pencil, Search, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react';


import { getToolAction, type ToolAction } from '@/components/agent/toolHeaderSummary';
import { cn } from '@/lib/utils';

const ICONS: Record<ToolAction, LucideIcon> = {
  read: FileText,
  list: Folder,
  search: Search,
  write: Pencil,
  edit: Pencil,
  run: SquareTerminal,
  fetch: Globe,
  delegate: Bot,
  use: Wrench,
};

/**
 * 工具行的动作图标。状态由行尾的 spinner / 失败文字表达，所以这里的图标只说明
 * 「这是哪一类动作」，读一列工具行时可以按形状扫读（对齐参考实现的 `ToolActionIcon`）。
 */
export function ToolActionIcon({
  toolName,
  className,
  size = 15,
}: {
  toolName: string;
  className?: string;
  size?: number;
}) {
  const Icon = ICONS[getToolAction(toolName)];
  return <Icon aria-hidden className={cn('shrink-0', className)} size={size} />;
}
