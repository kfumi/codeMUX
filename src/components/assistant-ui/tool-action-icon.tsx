import {
  Bot,
  CheckSquare,
  FileText,
  Folder,
  Globe,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import { getToolAction, normalizeToolName, type ToolAction } from '@/components/agent/toolHeaderSummary';
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
 * 少数工具的动作分类（`ToolAction`）不贴合语义，单独指定图标：
 * 待办/计划类工具用 `Wrench`（`use` 的兜底图标）会让人误以为在执行命令。
 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  TodoWrite: CheckSquare,
  update_plan: CheckSquare,
  TaskList: CheckSquare,
  ExitPlanMode: CheckSquare,
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
  const Icon = TOOL_ICONS[normalizeToolName(toolName)] ?? ICONS[getToolAction(toolName)];
  return <Icon aria-hidden className={cn('shrink-0', className)} size={size} />;
}
