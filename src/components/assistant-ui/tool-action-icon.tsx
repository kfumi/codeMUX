import {
  Bot,
  CheckSquare,
  CircleHelp,
  FileText,
  Folder,
  Globe,
  MonitorSmartphone,
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
  AskUserQuestion: CircleHelp,
  request_user_input: CircleHelp,
  browser_list: MonitorSmartphone,
  browser_eval: MonitorSmartphone,
  browser_screenshot: MonitorSmartphone,
  browser_input: MonitorSmartphone,
  browser_cdp: MonitorSmartphone,
  browser_snapshot: MonitorSmartphone,
  browser_click: MonitorSmartphone,
  browser_type: MonitorSmartphone,
  browser_scroll: MonitorSmartphone,
  browser_select: MonitorSmartphone,
};

/**
 * 工具行的动作图标。状态由行尾的 spinner / 失败文字表达，所以这里的图标只说明
 * 「这是哪一类动作」，读一列工具行时可以按形状扫读（对齐参考实现的 `ToolActionIcon`）。
 * 尺寸用 em 跟随界面字号（1.08em ≈ 动作词 13px 时的 14px）：图标比文字略大半档有呼吸感，
 * 但不能冒出文字行太多（视觉上像往下坠）；写死像素会跟丢设置里的界面字号。
 */
export function ToolActionIcon({
  toolName,
  className,
}: {
  toolName: string;
  className?: string;
}) {
  const Icon = TOOL_ICONS[normalizeToolName(toolName)] ?? ICONS[getToolAction(toolName)];
  return <Icon aria-hidden className={cn('shrink-0 size-[1.08em]', className)} />;
}
