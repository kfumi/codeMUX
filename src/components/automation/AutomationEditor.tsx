import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';

import {
  buildDefaultPermissionConfig,
  serializePermissionConfig,
  type AgentPermissionConfig,
} from '../../lib/agentPermissions';
import { daemonFacade } from '../../lib/facades/daemon-facade';
import {
  buildScheduledTaskDraftFromSettings,
  getAgentPermissionDefault,
  getConfiguredAgentModelIds,
  getDefaultAgentKindFromConfig,
  resolvePreferredAgentModel,
} from '../../lib/scheduledTaskDefaults';
import { useAgentModels } from '../../hooks/useAgentModels';
import { useProjectStore } from '../../stores/projectStore';
import { useScheduledTaskStore } from '../../stores/scheduledTaskStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ModelProvider } from '../../types/provider';
import type { AgentKind } from '../../types/session';
import type { ScheduledTaskDraft, TaskRun } from '../../types/scheduledTask';
import { AgentPermissionSelector } from '../agent/AgentPermissionSelector';
import { AgentSelector } from '../agent/AgentSelector';
import { AgentModelSelector } from '../agent/AgentModelSelector';
import { CodeMuxAssistantRuntimeProvider } from '../agent/assistant-ui/CodeMuxAssistantRuntime';
import { AutomationProjectPicker } from './AutomationProjectPicker';
import { AutomationPageHeader } from './AutomationPageHeader';
import { AutomationEditorHeaderActions } from './AutomationEditorHeaderActions';
import { AutomationTaskHistoryPanel } from './AutomationTaskHistoryPanel';
import { AutomationTaskStatusBadge } from './AutomationTaskStatusBadge';
import {
  normalizeScheduleForSave,
  ScheduleConfigurator,
  scheduleValueFromInitialDraft,
  scheduleValueFromTask,
  type ScheduleConfiguratorValue,
} from './ScheduleConfigurator';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Input } from '../ui/input';

const AUTOMATION_DRAFT_SESSION_ID = 'scheduled-task-draft';
const EMPTY_RUNS: TaskRun[] = [];
const EMPTY_MODEL_PROVIDERS: ModelProvider[] = [];

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

interface AutomationEditorProps {
  taskId: string | null;
  initialDraft: ScheduledTaskDraft | null;
  onBack: () => void;
  onOpenSession: (sessionId: string, projectId: string | null) => void;
}

export function AutomationEditor({
  taskId,
  initialDraft,
  onBack,
  onOpenSession,
}: AutomationEditorProps) {
  const projects = useProjectStore((state) => state.projects);
  const config = useSettingsStore((state) => state.config);
  const createTask = useScheduledTaskStore((state) => state.createTask);
  const updateTask = useScheduledTaskStore((state) => state.updateTask);
  const deleteTask = useScheduledTaskStore((state) => state.deleteTask);
  const fetchRuns = useScheduledTaskStore((state) => state.fetchRuns);
  const runs = useScheduledTaskStore((state) => {
    if (!taskId) return EMPTY_RUNS;
    return state.runs[taskId] ?? EMPTY_RUNS;
  });

  const [tab, setTab] = useState<'settings' | 'history'>('settings');
  const [timezone, setTimezone] = useState('');
  const [scheduleValue, setScheduleValue] = useState<ScheduleConfiguratorValue | null>(() =>
    scheduleValueFromInitialDraft(initialDraft),
  );
  const [draft, setDraft] = useState<ScheduledTaskDraft>(() => {
    const settingsConfig = useSettingsStore.getState().config;
    if (initialDraft) {
      return buildScheduledTaskDraftFromSettings(settingsConfig, {
        title: initialDraft.title,
        instruction: initialDraft.instruction,
        projectId: initialDraft.projectId ?? projects[0]?.id ?? null,
        reasoningEffort: initialDraft.reasoningEffort,
        planMode: initialDraft.planMode,
        enabled: initialDraft.enabled,
        scheduleKind: initialDraft.scheduleKind,
        scheduleTime: initialDraft.scheduleTime,
        weeklyWeekday: initialDraft.weeklyWeekday,
        monthlyDay: initialDraft.monthlyDay,
      });
    }
    return buildScheduledTaskDraftFromSettings(settingsConfig, {
      projectId: projects[0]?.id ?? null,
    });
  });
  const [isSaving, setIsSaving] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const initializedFromSettingsRef = useRef(false);

  const modelProviders = config?.model_providers ?? EMPTY_MODEL_PROVIDERS;
  const activeProviderId = config?.active_provider_id ?? null;
  const configuredModelIds = getConfiguredAgentModelIds(draft.agentKind, config);
  const preferredProviderId = draft.providerId
    ?? configuredModelIds.providerId
    ?? activeProviderId;
  const { models } = useAgentModels(draft.agentKind, modelProviders, preferredProviderId);

  const preferredModel = useMemo(
    () => resolvePreferredAgentModel(
      draft.agentKind,
      config,
      models,
      draft.providerId,
      draft.model,
    ),
    [config, draft.agentKind, draft.model, draft.providerId, models],
  );

  const effectiveModel = preferredModel?.modelId ?? '';
  const effectiveProviderId = preferredModel?.providerId ?? preferredProviderId;

  const handleModelChange = useCallback((modelId: string, providerId: string) => {
    setDraft((current) => ({
      ...current,
      model: modelId,
      providerId,
    }));
  }, []);

  const handleReasoningEffortChange = useCallback((effort: ScheduledTaskDraft['reasoningEffort']) => {
    setDraft((current) => ({
      ...current,
      reasoningEffort: effort,
    }));
  }, []);

  useEffect(() => {
    daemonFacade.scheduledTasks.getTimezone().then(setTimezone).catch(() => setTimezone(''));
  }, []);

  useEffect(() => {
    if (taskId || !config || initializedFromSettingsRef.current) return;

    const agentKind = getDefaultAgentKindFromConfig(config);
    const modelDefaults = getConfiguredAgentModelIds(agentKind, config);

    setDraft((current) => ({
      ...current,
      agentKind,
      permissionConfig: getAgentPermissionDefault(agentKind, config),
      providerId: modelDefaults.providerId,
      model: modelDefaults.model,
    }));
    initializedFromSettingsRef.current = true;
  }, [config, initialDraft, taskId]);

  useEffect(() => {
    if (!preferredModel) return;
    if (draft.model === preferredModel.modelId && draft.providerId === preferredModel.providerId) {
      return;
    }
    setDraft((current) => ({
      ...current,
      model: preferredModel.modelId,
      providerId: preferredModel.providerId,
    }));
  }, [draft.model, draft.providerId, preferredModel]);

  useEffect(() => {
    if (!taskId) return;
    daemonFacade.scheduledTasks.get(taskId).then((task) => {
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
        enabled: task.enabled,
      });
      setScheduleValue(scheduleValueFromTask(
        task.scheduleKind,
        task.scheduleTime,
        task.weeklyWeekday,
        task.weeklyWeekdays,
        task.monthlyDay,
      ));
    });
    fetchRuns(taskId);
  }, [taskId, fetchRuns]);

  const handleAgentKindChange = useCallback((agentKind: AgentKind) => {
    const modelDefaults = getConfiguredAgentModelIds(agentKind, config);
    setDraft((current) => ({
      ...current,
      agentKind,
      permissionConfig: getAgentPermissionDefault(agentKind, config),
      planMode: 'off',
      providerId: modelDefaults.providerId,
      model: modelDefaults.model,
    }));
  }, [config]);

  const buildInput = () => {
    if (!draft.projectId) {
      throw new Error('请选择一个项目');
    }
    if (!draft.instruction.trim()) {
      throw new Error('任务指令不能为空');
    }
    if (!scheduleValue) {
      throw new Error('请添加调度计划');
    }
    const schedule = normalizeScheduleForSave(scheduleValue);
    return {
      title: draft.title.trim() || '未命名定时任务',
      instruction: draft.instruction.trim(),
      projectId: draft.projectId,
      agentKind: draft.agentKind,
      providerId: draft.providerId ?? effectiveProviderId,
      model: draft.model ?? (effectiveModel || null),
      reasoningEffort: draft.reasoningEffort,
      permissionConfig: JSON.stringify(serializePermissionConfig(draft.agentKind, draft.permissionConfig)),
      planMode: draft.planMode,
      scheduleKind: schedule.scheduleKind,
      scheduleTime: schedule.scheduleTime,
      weeklyWeekday: schedule.weeklyWeekday,
      weeklyWeekdays: schedule.weeklyWeekdays,
      monthlyDay: schedule.monthlyDay,
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
      } else {
        await createTask(input);
        toast.success('已创建');
        onBack();
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
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="删除定时任务"
        description={`确定删除「${draft.title}」吗？此操作无法撤销。`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={handleDelete}
      />
      <AutomationPageHeader
        title={taskId ? '编辑定时任务' : '新建任务'}
        description={taskId ? '调整此任务的执行时间、指令和运行方式。' : '配置指令、调度与运行参数'}
        onBack={onBack}
        actions={
          <AutomationEditorHeaderActions
            taskId={taskId}
            enabled={draft.enabled}
            isSaving={isSaving}
            onSave={() => void handleSave()}
            onEnabledChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            onDeleteRequest={() => setDeleteConfirmOpen(true)}
          />
        }
        tabs={taskId
          ? [
            { id: 'settings', label: '设置' },
            { id: 'history', label: '历史' },
          ]
          : undefined}
        activeTab={tab}
        onTabChange={(nextTab) => setTab(nextTab as 'settings' | 'history')}
      />

      {tab === 'settings' ? (
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {taskId && (
            <div className="flex flex-col items-start gap-2.5">
              <span className="text-ui-body text-muted-foreground">状态</span>
              <AutomationTaskStatusBadge enabled={draft.enabled} />
            </div>
          )}

          <label className="flex flex-col gap-2">
            <span className="text-ui-body text-muted-foreground">任务标题</span>
            <Input
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="未命名定时任务"
              className="text-ui-body"
            />
          </label>

          <ScheduleConfigurator
            value={scheduleValue}
            timezone={timezone}
            onChange={setScheduleValue}
          />

          <label className="flex flex-col gap-2">
            <span className="text-ui-body text-muted-foreground">指令</span>
            <div className="rounded-lg border border-border/70 bg-muted/10">
              <textarea
                value={draft.instruction}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft((current) => ({
                  ...current,
                  instruction: event.target.value,
                }))}
                placeholder="例如：Review 最近 24 小时的提交，总结可能引入的 bug 和修复建议"
                rows={8}
                className="min-h-[160px] w-full resize-none rounded-t-lg border-0 bg-transparent px-3 py-3 text-ui-body outline-none focus:ring-0"
              />
              <CodeMuxAssistantRuntimeProvider
                sessionId={AUTOMATION_DRAFT_SESSION_ID}
                agentKind={draft.agentKind}
                onSend={async () => {}}
                onCommand={async () => {}}
              >
                <div className="flex flex-wrap items-center gap-1 border-t border-border/60 px-2 py-1.5">
                  <AutomationProjectPicker
                    projects={projects}
                    value={draft.projectId}
                    onChange={(projectId) => setDraft((current) => ({ ...current, projectId }))}
                  />
                  <AgentSelector
                    value={draft.agentKind}
                    onChange={handleAgentKindChange}
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
                  <div className="ml-auto flex flex-wrap items-center gap-1">
                    <AgentModelSelector
                      agentKind={draft.agentKind}
                      providers={modelProviders}
                      activeProviderId={effectiveProviderId}
                      value={effectiveModel}
                      onChange={handleModelChange}
                      reasoningEffort={draft.reasoningEffort}
                      onReasoningEffortChange={handleReasoningEffortChange}
                    />
                  </div>
                </div>
              </CodeMuxAssistantRuntimeProvider>
            </div>
            {!draft.projectId && (
              <p className="text-ui-body text-destructive">请选择一个项目后才能保存</p>
            )}
          </label>
        </div>
      ) : taskId ? (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <AutomationTaskHistoryPanel
            taskId={taskId}
            projectId={draft.projectId}
            runs={runs}
            onOpenSession={onOpenSession}
          />
        </div>
      ) : null}
    </div>
  );
}
