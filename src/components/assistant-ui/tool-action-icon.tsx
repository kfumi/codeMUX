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
import { builtinMcpToolSegment } from '@/lib/builtinMcp';
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
  browser_list: Globe,
  browser_eval: Globe,
  browser_screenshot: Globe,
  browser_input: Globe,
  browser_cdp: Globe,
  browser_snapshot: Globe,
  browser_click: Globe,
  browser_type: Globe,
  browser_scroll: Globe,
  browser_select: Globe,
  computer_windows: MonitorSmartphone,
  computer_screenshot: MonitorSmartphone,
  computer_save_screenshot: MonitorSmartphone,
  computer_active_window: MonitorSmartphone,
  computer_apps: MonitorSmartphone,
  computer_elements: MonitorSmartphone,
  computer_wait: MonitorSmartphone,
  computer_click: MonitorSmartphone,
  computer_type: MonitorSmartphone,
  computer_key: MonitorSmartphone,
  computer_paste: MonitorSmartphone,
  computer_scroll: MonitorSmartphone,
  computer_drag: MonitorSmartphone,
  computer_set_value: MonitorSmartphone,
  computer_launch: MonitorSmartphone,
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
  const builtinSegment = builtinMcpToolSegment(toolName);
  const Icon = (builtinSegment ? TOOL_ICONS[builtinSegment] : undefined)
    ?? TOOL_ICONS[normalizeToolName(toolName)]
    ?? ICONS[getToolAction(toolName)];
  return <Icon aria-hidden className={cn('shrink-0 size-[1.08em]', className)} />;
}
