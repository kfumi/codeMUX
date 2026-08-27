import { CalendarClock, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { buildScheduledTaskDraftFromSettings } from '../../lib/scheduledTaskDefaults';
import { cn } from '../../lib/utils';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useScheduledTaskStore } from '../../stores/scheduledTaskStore';
import type { ScheduledTaskDraft } from '../../types/scheduledTask';
import { AutomationPageHeader } from './AutomationPageHeader';
import { AutomationTaskActionsMenu } from './AutomationTaskActionsMenu';
import { AutomationTaskMetaChips } from './AutomationTaskMetaChips';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Input } from '../ui/input';

const TEMPLATES: Array<{
  id: string;
  label: string;
  description: string;
  draft: Partial<ScheduledTaskDraft>;
}> = [
  {
    id: 'daily-brief',
    label: '每日提交简报',
    description: '工作日早晨总结最近提交',
    draft: {
      title: '每日提交简报',
      scheduleKind: 'weekdays',
      scheduleTime: '09:00',
      instruction: '总结最近 24 小时的提交，标出可能引入的 bug 和修复建议。',
    },
  },
  {
    id: 'weekly-review',
    label: '每周回顾',
    description: '周五下午收一周工作',
    draft: {
      title: '每周回顾',
      scheduleKind: 'weekly',
      scheduleTime: '17:00',
      weeklyWeekday: 4,
      instruction: '生成本周工作回顾：完成了什么、遗留项、下周建议。',
    },
  },
  {
    id: 'follow-up',
    label: '跟进监控',
    description: '工作日早晨检查未合并改动',
    draft: {
      title: '跟进监控',
      scheduleKind: 'weekdays',
      scheduleTime: '08:30',
      instruction: '检查当前仓库未合并的改动与 open PR，列出需要我跟进的项。',
    },
  },
];

interface AutomationLandingProps {
  onCreate: (draft: ScheduledTaskDraft) => void;
  onSelectTask: (taskId: string) => void;
}

export function AutomationLanding({ onCreate, onSelectTask }: AutomationLandingProps) {
  const tasks = useScheduledTaskStore((state) => state.tasks);
  const deleteTask = useScheduledTaskStore((state) => state.deleteTask);
  const projects = useProjectStore((state) => state.projects);
  const config = useSettingsStore((state) => state.config);
  const [query, setQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return tasks;
    return tasks.filter((task) => task.title.toLowerCase().includes(normalized));
  }, [query, tasks]);

  const buildBlankDraft = (): ScheduledTaskDraft =>
    buildScheduledTaskDraftFromSettings(config, {
      projectId: projects[0]?.id ?? null,
    });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除定时任务"
        description={deleteTarget
          ? `确定删除「${deleteTarget.title}」吗？此操作无法撤销。`
          : ''}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteTask(deleteTarget.id);
          toast.success('已删除');
          setDeleteTarget(null);
        }}
      />
      <AutomationPageHeader
        title="定时任务"
        description="仅在 CodeMUX 运行时生效（含托盘隐藏）；彻底退出后不会触发，也不会补跑。"
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => onCreate(buildBlankDraft())}>
            <Plus className="h-4 w-4" />
            创建
          </Button>
        }
        toolbar={
          <div className="relative w-full">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索定时任务"
              className="h-8 pl-8 text-ui-body"
            />
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mb-6">
          <h3 className="mb-3 text-ui-body font-medium text-foreground/80">建议模板</h3>
          <div className="grid gap-3 md:grid-cols-3">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => onCreate({ ...buildBlankDraft(), ...template.draft })}
                className="rounded-lg border border-border/70 bg-muted/20 p-4 text-left transition-colors hover:bg-muted/40"
              >
                <div className="text-ui-body font-medium">{template.label}</div>
                <div className="mt-1 text-ui-body text-muted-foreground">{template.description}</div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-3 text-ui-body font-medium text-foreground/80">我的任务</h3>
          {filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 p-8 text-center text-ui-body text-muted-foreground">
              还没有定时任务。使用模板或点右上角创建。
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((task) => {
                const projectMissing = !projects.some((project) => project.id === task.projectId);
                return (
                  <div
                    key={task.id}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border border-border/70 px-4 py-3',
                      projectMissing && 'border-amber-500/40 bg-amber-500/5',
                    )}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => onSelectTask(task.id)}
                    >
                      <div className="flex items-center gap-2">
                        <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-ui-body font-medium">{task.title}</span>
                      </div>
                      <AutomationTaskMetaChips task={task} nowMs={nowMs} />
                      {projectMissing && (
                        <p className="mt-1 text-ui-body text-amber-600 dark:text-amber-400">
                          项目不可用
                        </p>
                      )}
                    </button>
                    <AutomationTaskActionsMenu
                      task={task}
                      onEdit={() => onSelectTask(task.id)}
                      onDelete={() => setDeleteTarget({ id: task.id, title: task.title })}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
