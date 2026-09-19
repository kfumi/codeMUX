import { Check, CircleAlert, FolderOpen, KeyRound, Cpu, ShieldCheck } from 'lucide-react';

import { cn } from '../../lib/utils';

interface AgentSetupChecklistProps {
  agentLabel: string;
  hasUsableProvider: boolean;
  isLoadingModel: boolean;
  hasModel: boolean;
  hasWorkspace: boolean;
  compact?: boolean;
}

export function AgentSetupChecklist({
  agentLabel,
  hasUsableProvider,
  isLoadingModel,
  hasModel,
  hasWorkspace,
  compact = false,
}: AgentSetupChecklistProps) {
  const steps = [
    { label: `${agentLabel} 已选择`, ready: true, icon: Cpu },
    { label: '模型供应商', ready: hasUsableProvider, icon: KeyRound },
    { label: '模型', ready: hasModel && !isLoadingModel, icon: Cpu },
    { label: '工作目录', ready: hasWorkspace, icon: FolderOpen },
    { label: '权限模式', ready: true, icon: ShieldCheck },
  ];
  const readyCount = steps.filter((step) => step.ready).length;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 rounded-xl border border-border/45 bg-[hsl(var(--surface-2))]/42 px-3 py-2 text-ui-caption text-muted-foreground',
        compact && 'justify-start',
      )}
      aria-label={`智能体准备状态，${readyCount} 项就绪`}
      data-testid="agent-setup-checklist"
    >
      <span className="mr-1 font-medium text-foreground/76">开始前检查</span>
      {steps.map((step) => {
        const Icon = step.ready ? Check : CircleAlert;
        const StepIcon = step.icon;
        return (
          <span
            key={step.label}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-1',
              step.ready
                ? 'border-emerald-500/20 bg-emerald-500/6 text-emerald-700 dark:text-emerald-300'
                : 'border-amber-500/25 bg-amber-500/8 text-amber-700 dark:text-amber-300',
            )}
          >
            <StepIcon className="h-3 w-3 opacity-70" />
            <span>{step.label}</span>
            <Icon className="h-3 w-3" />
          </span>
        );
      })}
    </div>
  );
}
