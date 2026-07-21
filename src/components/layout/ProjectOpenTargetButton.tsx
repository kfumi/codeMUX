import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';

import { fileApi } from '../../lib/tauri';
import { getOpenTargetOption, normalizeOpenTarget, OPEN_TARGET_OPTIONS, type OpenTarget } from '../../lib/openTargets';
import { cn } from '../../lib/utils';
import { useSettingsStore } from '../../stores/settingsStore';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface ProjectOpenTargetButtonProps {
  projectPath: string;
}

export function ProjectOpenTargetButton({ projectPath }: ProjectOpenTargetButtonProps) {
  const configuredTarget = useSettingsStore((state) => state.config?.default_open_target);
  const defaultTarget = normalizeOpenTarget(configuredTarget);
  const defaultOption = getOpenTargetOption(defaultTarget);
  const DefaultIcon = defaultOption.Icon;

  const openProject = (target: OpenTarget) => {
    void fileApi.openProjectPath(projectPath, target).catch(() => {
      toast.error('打开项目失败');
    });
  };

  return (
    <div className="flex h-7 shrink-0 items-center overflow-hidden rounded-md border border-border/44 bg-[hsl(var(--surface-2))]/70 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`打开项目：${defaultOption.label}`}
            onClick={() => openProject(defaultTarget)}
            className="flex h-7 w-8 items-center justify-center text-foreground/60 transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <DefaultIcon className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>用 {defaultOption.label} 打开项目</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <DropdownMenuTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="选择打开项目方式"
                className="flex h-7 w-6 items-center justify-center border-l border-border/38 text-foreground/45 transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
          </DropdownMenuTrigger>
          <TooltipContent side="bottom">
            <p>选择打开项目方式</p>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="z-[180] min-w-[168px]">
          {OPEN_TARGET_OPTIONS.map((option) => {
            const Icon = option.Icon;
            const active = option.value === defaultTarget;
            return (
              <DropdownMenuItem
                key={option.value}
                icon={<Icon className={cn('h-4 w-4', active ? 'text-primary' : 'text-foreground/58')} />}
                onClick={() => openProject(option.value)}
              >
                <span className={cn('text-[12px]', active && 'font-medium text-foreground')}>
                  {option.label}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
