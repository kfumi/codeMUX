import { CalendarClock, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { cn } from '../../lib/utils';
import { useProjectStore } from '../../stores/projectStore';
import { useScheduledTaskStore } from '../../stores/scheduledTaskStore';
import type { ScheduledTaskDraft } from '../../types/scheduledTask';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';

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

function formatNextRun(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

interface AutomationLandingProps {
  onCreate: (draft: ScheduledTaskDraft) => void;
  onSelectTask: (taskId: string) => void;
}

export function AutomationLanding({ onCreate, onSelectTask }: AutomationLandingProps) {
  const tasks = useScheduledTaskStore((state) => state.tasks);
  const setEnabled = useScheduledTaskStore((state) => state.setEnabled);
  const projects = useProjectStore((state) => state.projects);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return tasks;
    return tasks.filter((task) => task.title.toLowerCase().includes(normalized));
  }, [query, tasks]);

  const buildBlankDraft = (): ScheduledTaskDraft => ({
    title: '未命名定时任务',
    instruction: '',
    projectId: projects[0]?.id ?? null,
    agentKind: 'claude_code',
    providerId: null,
    model: null,
    reasoningEffort: 'high',
    permissionConfig: { kind: 'claude_code', permissionMode: 'default' },
    planMode: 'off',
    scheduleKind: 'weekdays',
    scheduleTime: '09:00',
    weeklyWeekday: 1,
    monthlyDay: 1,
    enabled: true,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border/60 px-6 py-4">
        <p className="text-ui-caption text-muted-foreground">
          定时任务仅在 CodeMUX 运行时生效（包括隐藏到托盘）；彻底退出后不会触发，也不会补跑。
        </p>
      </div>

      <div className="flex items-center gap-3 border-b border-border/60 px-6 py-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索定时任务"
            className="pl-9"
          />
        </div>
        <Button onClick={() => onCreate(buildBlankDraft())}>
          <Plus className="h-4 w-4" />
          创建
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mb-6">
          <h3 className="mb-3 text-ui-compact font-medium text-foreground/80">建议模板</h3>
          <div className="grid gap-3 md:grid-cols-3">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => onCreate({ ...buildBlankDraft(), ...template.draft })}
                className="rounded-lg border border-border/70 bg-muted/20 p-4 text-left transition-colors hover:bg-muted/40"
              >
                <div className="text-ui-compact font-medium">{template.label}</div>
                <div className="mt-1 text-ui-caption text-muted-foreground">{template.description}</div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-3 text-ui-compact font-medium text-foreground/80">我的任务</h3>
          {filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 p-8 text-center text-ui-caption text-muted-foreground">
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
                        <span className="truncate text-ui-compact font-medium">{task.title}</span>
                      </div>
                      <div className="mt-1 text-ui-caption text-muted-foreground">
                        下次：{formatNextRun(task.nextRunAt)}
                        {projectMissing ? ' · 项目不可用' : ''}
                      </div>
                    </button>
                    <Switch
                      checked={task.enabled}
                      onCheckedChange={(enabled) => setEnabled(task.id, enabled)}
                      aria-label={`启用 ${task.title}`}
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
