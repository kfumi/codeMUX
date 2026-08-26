import { ArrowLeft, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';

import {
  buildDefaultPermissionConfig,
  serializePermissionConfig,
  type AgentPermissionConfig,
} from '../../lib/agentPermissions';
import { scheduledTaskApi } from '../../lib/tauri';
import { useProjectStore } from '../../stores/projectStore';
import { useScheduledTaskStore } from '../../stores/scheduledTaskStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { AgentKind } from '../../types/session';
import type { ScheduledTaskDraft, ScheduleKind, TaskRun } from '../../types/scheduledTask';
import { AgentPermissionSelector } from '../agent/AgentPermissionSelector';
import { AgentSelector } from '../agent/AgentSelector';
import { AgentModelSelector } from '../agent/AgentModelSelector';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

const WEEKDAY_OPTIONS = [
  { value: 0, label: '周一' },
  { value: 1, label: '周二' },
  { value: 2, label: '周三' },
  { value: 3, label: '周四' },
  { value: 4, label: '周五' },
  { value: 5, label: '周六' },
  { value: 6, label: '周日' },
];

const SCHEDULE_OPTIONS: Array<{ value: ScheduleKind; label: string }> = [
  { value: 'hourly', label: '每小时' },
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '每工作日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
];

function parsePermissionConfig(agentKind: AgentKind, raw: string): AgentPermissionConfig {
  try {
    const parsed = JSON.parse(raw) as AgentPermissionConfig;
    if (parsed && typeof parsed === 'object' && 'kind' in parsed) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return buildDefaultPermissionConfig(agentKind);
}

function runStatusLabel(run: TaskRun): string {
  switch (run.status) {
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'awaiting_input':
      return '等待输入';
    case 'skipped':
      if (run.skipReason === 'overlap') return '已跳过（重叠）';
      if (run.skipReason === 'concurrency_limit') return '已跳过（并发上限）';
      if (run.skipReason === 'project_missing') return '已跳过（项目缺失）';
      return '已跳过';
    default:
      return run.status;
  }
}

interface AutomationEditorProps {
  taskId: string | null;
  initialDraft: ScheduledTaskDraft | null;
  onBack: () => void;
  onSaved: (taskId: string) => void;
  onOpenSession: (sessionId: string, projectId: string | null) => void;
}

export function AutomationEditor({
  taskId,
  initialDraft,
  onBack,
  onSaved,
  onOpenSession,
}: AutomationEditorProps) {
  const projects = useProjectStore((state) => state.projects);
  const config = useSettingsStore((state) => state.config);
  const createTask = useScheduledTaskStore((state) => state.createTask);
  const updateTask = useScheduledTaskStore((state) => state.updateTask);
  const deleteTask = useScheduledTaskStore((state) => state.deleteTask);
  const fetchRuns = useScheduledTaskStore((state) => state.fetchRuns);
  const runs = useScheduledTaskStore((state) => state.runs[taskId ?? ''] ?? []);

  const [tab, setTab] = useState<'settings' | 'history'>('settings');
  const [timezone, setTimezone] = useState('');
  const [draft, setDraft] = useState<ScheduledTaskDraft>(() => initialDraft ?? {
    title: '未命名定时任务',
    instruction: '',
    projectId: projects[0]?.id ?? null,
    agentKind: 'claude_code',
    providerId: null,
    model: null,
    reasoningEffort: 'high',
    permissionConfig: buildDefaultPermissionConfig('claude_code'),
    planMode: 'off',
    scheduleKind: 'weekdays',
    scheduleTime: '09:00',
    weeklyWeekday: 1,
    monthlyDay: 1,
    enabled: true,
  });
  const [isSaving, setIsSaving] = useState(false);

  const modelProviders = config?.model_providers ?? [];
  const activeProviderId = config?.active_provider_id ?? null;

  useEffect(() => {
    scheduledTaskApi.getTimezone().then(setTimezone).catch(() => setTimezone(''));
  }, []);

  useEffect(() => {
    if (!taskId) return;
    scheduledTaskApi.get(taskId).then((task) => {
      if (!task) return;
      setDraft({
        title: task.title,
        instruction: task.instruction,
        projectId: task.projectId,
        agentKind: task.agentKind,
        providerId: task.providerId,
        model: task.model,
        reasoningEffort: task.reasoningEffort ?? 'high',
        permissionConfig: parsePermissionConfig(task.agentKind, task.permissionConfig),
        planMode: task.planMode,
        scheduleKind: task.scheduleKind,
        scheduleTime: task.scheduleTime,
        weeklyWeekday: task.weeklyWeekday ?? 1,
        monthlyDay: task.monthlyDay ?? 1,
        enabled: task.enabled,
      });
    });
    fetchRuns(taskId);
  }, [taskId, fetchRuns]);

  const handleAgentKindChange = useCallback((agentKind: AgentKind) => {
    const nextDefault = config
      ? serializePermissionConfig(agentKind, config.agent_configs[agentKind]?.permission_config)
      : buildDefaultPermissionConfig(agentKind);
    setDraft((current) => ({
      ...current,
      agentKind,
      permissionConfig: nextDefault,
      planMode: 'off',
      providerId: null,
      model: null,
    }));
  }, [config]);

  const buildInput = () => {
    if (!draft.projectId) {
      throw new Error('请选择一个项目');
    }
    if (!draft.instruction.trim()) {
      throw new Error('任务指令不能为空');
    }
    return {
      title: draft.title.trim() || '未命名定时任务',
      instruction: draft.instruction.trim(),
      projectId: draft.projectId,
      agentKind: draft.agentKind,
      providerId: draft.providerId,
      model: draft.model,
      reasoningEffort: draft.reasoningEffort,
      permissionConfig: JSON.stringify(serializePermissionConfig(draft.agentKind, draft.permissionConfig)),
      planMode: draft.planMode,
      scheduleKind: draft.scheduleKind,
      scheduleTime: draft.scheduleTime,
      weeklyWeekday: draft.scheduleKind === 'weekly' ? draft.weeklyWeekday : null,
      monthlyDay: draft.scheduleKind === 'monthly' ? draft.monthlyDay : null,
      timezone,
      enabled: draft.enabled,
    };
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const input = buildInput();
      if (taskId) {
        await updateTask(taskId, input);
        toast.success('已保存');
        onSaved(taskId);
      } else {
        const created = await createTask(input);
        toast.success('已创建');
        onSaved(created.id);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!taskId) return;
    await deleteTask(taskId);
    toast.success('已删除');
    onBack();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border/60 px-6 py-4">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="返回">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="text-ui-caption text-muted-foreground">
            自动化 &gt; {taskId ? draft.title : '新建任务'}
          </div>
        </div>
        {taskId && (
          <Button variant="ghost" size="icon" onClick={handleDelete} aria-label="删除任务">
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
        <Button onClick={handleSave} disabled={isSaving}>
          保存
        </Button>
      </div>

      <div className="flex gap-4 border-b border-border/60 px-6">
        <button
          type="button"
          className={`py-2 text-ui-compact ${tab === 'settings' ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
          onClick={() => setTab('settings')}
        >
          设置
        </button>
        {taskId && (
          <button
            type="button"
            className={`py-2 text-ui-compact ${tab === 'history' ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
            onClick={() => setTab('history')}
          >
            历史
          </button>
        )}
      </div>

      {tab === 'settings' ? (
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <Input
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="任务标题"
          />

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-ui-caption text-muted-foreground">计划</span>
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-ui-compact"
                value={draft.scheduleKind}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  scheduleKind: event.target.value as ScheduleKind,
                }))}
              >
                {SCHEDULE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            {draft.scheduleKind !== 'hourly' && (
              <label className="space-y-1">
                <span className="text-ui-caption text-muted-foreground">时刻</span>
                <Input
                  type="time"
                  value={draft.scheduleTime}
                  onChange={(event) => setDraft((current) => ({ ...current, scheduleTime: event.target.value }))}
                />
              </label>
            )}

            {draft.scheduleKind === 'weekly' && (
              <label className="space-y-1">
                <span className="text-ui-caption text-muted-foreground">星期</span>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-ui-compact"
                  value={draft.weeklyWeekday}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    weeklyWeekday: Number(event.target.value),
                  }))}
                >
                  {WEEKDAY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            )}

            {draft.scheduleKind === 'monthly' && (
              <label className="space-y-1">
                <span className="text-ui-caption text-muted-foreground">每月几号</span>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={draft.monthlyDay}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    monthlyDay: Number(event.target.value),
                  }))}
                />
              </label>
            )}
          </div>

          <label className="block space-y-1">
            <span className="text-ui-caption text-muted-foreground">项目（必选）</span>
            <select
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-ui-compact"
              value={draft.projectId ?? ''}
              onChange={(event) => setDraft((current) => ({
                ...current,
                projectId: event.target.value || null,
              }))}
            >
              <option value="">选择项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>

          <textarea
            value={draft.instruction}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft((current) => ({
              ...current,
              instruction: event.target.value,
            }))}
            placeholder="总结最近 24 小时的提交，标出可能引入的 bug 和修复建议"
            rows={8}
            className="min-h-[160px] w-full rounded-md border border-border bg-background px-3 py-2 text-ui-compact"
          />

          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
            <AgentSelector
              value={draft.agentKind}
              onChange={handleAgentKindChange}
            />
            <AgentModelSelector
              agentKind={draft.agentKind}
              providers={modelProviders}
              activeProviderId={draft.providerId ?? activeProviderId}
              value={draft.model ?? ''}
              onChange={(modelId, providerId) => setDraft((current) => ({
                ...current,
                model: modelId,
                providerId,
              }))}
              reasoningEffort={draft.reasoningEffort}
              onReasoningEffortChange={(effort) => setDraft((current) => ({
                ...current,
                reasoningEffort: effort,
              }))}
            />
            <AgentPermissionSelector
              agentKind={draft.agentKind}
              permissionConfig={draft.permissionConfig}
              planMode={draft.planMode}
              onPermissionConfigChange={(permissionConfig) => setDraft((current) => ({
                ...current,
                permissionConfig,
              }))}
              onPlanModeChange={(planMode) => setDraft((current) => ({ ...current, planMode }))}
              onModeChange={(permissionConfig, planMode) => setDraft((current) => ({
                ...current,
                permissionConfig,
                planMode,
              }))}
            />
          </div>
          {!taskId && (
            <p className="text-ui-caption text-muted-foreground">
              执行档位默认与新建对话一致，可随时下拉切换并随任务保存。
            </p>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {runs.length === 0 ? (
            <p className="text-ui-caption text-muted-foreground">还没有执行记录。</p>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  disabled={!run.sessionId}
                  onClick={() => run.sessionId && onOpenSession(run.sessionId, draft.projectId)}
                  className="flex w-full items-center justify-between rounded-lg border border-border/70 px-4 py-3 text-left disabled:opacity-60"
                >
                  <div>
                    <div className="text-ui-compact font-medium">{runStatusLabel(run)}</div>
                    <div className="text-ui-caption text-muted-foreground">
                      {new Date(run.scheduledFor).toLocaleString()}
                    </div>
                  </div>
                  {run.sessionId && <span className="text-ui-caption text-primary">打开会话</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
