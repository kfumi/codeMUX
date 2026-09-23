import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { daemonFacade } from '../../lib/facades/daemon-facade';
import {
  getConfiguredAgentModelIds,
  getDefaultAgentKindFromConfig,
} from '../../lib/scheduledTaskDefaults';
import { AgentSelector } from '../agent/AgentSelector';
import { AgentModelSelector } from '../agent/AgentModelSelector';
import { InstructionComposer } from '../agent/InstructionComposer';
import { AutomationProjectPicker } from '../automation/AutomationProjectPicker';
import { BranchPicker } from './BranchPicker';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWorkTaskStore } from '../../stores/workTaskStore';
import type { WorkTask, WorkTaskInput } from '../../types/workTask';
import type { ReasoningEffort } from '../../types/session';
import type { GitRepositoryState } from '../../lib/gitTypes';

interface TaskEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 有值 = 编辑（仅 todo/failed 可编辑）；无值 = 新建。 */
  task?: WorkTask | null;
  defaultProjectId?: string | null;
}

interface EditorDraft {
  title: string;
  instruction: string;
  projectId: string | null;
  agentKind: WorkTaskInput['agentKind'];
  providerId: string | null;
  model: string | null;
  useWorktree: boolean;
  /** 基线分支草稿：输入框存原始字符串，提交时空串转 null（= 默认项目当前分支）。 */
  baseBranch: string;
}

const EMPTY_MODEL_PROVIDERS: [] = [];

function draftFromTask(task: WorkTask): EditorDraft {
  return {
    title: task.title,
    instruction: task.instruction,
    projectId: task.projectId,
    agentKind: task.agentKind,
    providerId: task.providerId,
    model: task.model,
    useWorktree: task.useWorktree,
    baseBranch: task.baseBranch ?? '',
  };
}

export function TaskEditorDialog({
  open,
  onOpenChange,
  task,
  defaultProjectId = null,
}: TaskEditorDialogProps) {
  const isEdit = task != null;
  const projects = useProjectStore((state) => state.projects);
  const fetchProjects = useProjectStore((state) => state.fetchProjects);
  const config = useSettingsStore((state) => state.config);
  const createTask = useWorkTaskStore((state) => state.createTask);
  const updateTask = useWorkTaskStore((state) => state.updateTask);

  // 新任务的默认值 = 设置 → 智能体运行时里的默认配置：默认智能体种类
  // (agent_defaults.default_agent_kind)，以及该种类自己的默认供应商/模型
  // (agent_configs[kind].default_provider_id / default_model，缺省回落 active_provider)。
  const defaultsForAgent = (agentKind: WorkTaskInput['agentKind']) => ({
    agentKind,
    ...getConfiguredAgentModelIds(agentKind, config),
  });
  const [draft, setDraft] = useState<EditorDraft>(() => ({
    title: '',
    instruction: '',
    projectId: defaultProjectId,
    ...defaultsForAgent(getDefaultAgentKindFromConfig(config)),
    useWorktree: true,
    baseBranch: '',
  }));
  // WorkTaskInput 不含 reasoning effort；选择器需要该 prop，本地暂存不落库。
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('high');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 选中项目的 Git 仓库状态（分支列表 + 当前分支）；用于基线分支选择器。
  // status=error 视为「不是 Git 仓库 / 读不到仓库」，选择器禁用并给出提示。
  const [repoState, setRepoState] = useState<GitRepositoryState | null>(null);
  const [repoStatus, setRepoStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const branchFetchSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    fetchProjects();
    setRepoState(null);
    setRepoStatus('idle');
    if (task) {
      setDraft(draftFromTask(task));
    } else {
      setDraft({
        title: '',
        instruction: '',
        projectId: defaultProjectId,
        ...defaultsForAgent(getDefaultAgentKindFromConfig(config)),
        useWorktree: true,
        baseBranch: '',
      });
    }
  }, [open, task, defaultProjectId, fetchProjects, config]);

  // 选中项目后预取仓库状态（分支列表）。不依赖 worktree 勾选：分支选择器需要
  // 知道项目是否 Git 仓库；非 Git 仓库读取失败 → error，选择器禁用。
  useEffect(() => {
    if (!open || draft.projectId == null) {
      setRepoState(null);
      setRepoStatus('idle');
      return;
    }
    const project = projects.find((entry) => entry.id === draft.projectId);
    if (!project) return;
    const seq = ++branchFetchSeq.current;
    setRepoStatus('loading');
    Promise.resolve(daemonFacade.git.getRepositoryState(project.path))
      .then((state) => {
        if (seq !== branchFetchSeq.current) return;
        setRepoState(state);
        setRepoStatus('ready');
      })
      .catch(() => {
        if (seq !== branchFetchSeq.current) return;
        setRepoState(null);
        setRepoStatus('error');
      });
  }, [open, draft.projectId, projects]);

  const gitBranches = repoState?.branches ?? [];
  // 基线分支选择器禁用原因（按优先级）；null = 可用。
  // 勾选 worktree 时它是基准分支；未勾选时会在项目目录迁出该分支后运行。
  const branchDisabledReason = draft.projectId == null
    ? '请先选择项目'
    : repoStatus === 'loading'
      ? '正在读取分支……'
      : repoStatus === 'error'
        ? '该项目不是 Git 仓库'
        : null;

  const modelProviders = useMemo(
    () => config?.model_providers ?? EMPTY_MODEL_PROVIDERS,
    [config],
  );

  const canSubmit = draft.title.trim().length > 0 && draft.projectId != null && !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit || draft.projectId == null) return;
    setIsSubmitting(true);
    const input: WorkTaskInput = {
      title: draft.title.trim(),
      instruction: draft.instruction,
      projectId: draft.projectId,
      agentKind: draft.agentKind,
      providerId: draft.providerId,
      model: draft.model,
      useWorktree: draft.useWorktree,
      baseBranch: draft.baseBranch.trim() || null,
    };
    try {
      if (isEdit && task) {
        await updateTask(task.id, input);
        toast.success('任务已更新');
      } else {
        await createTask(input);
        toast.success('任务已创建');
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(isEdit ? '更新任务失败' : '创建任务失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    // modal={false}:对话框里有 Radix 下拉/浮层(智能体、模型、思考强度)。模态
    // Dialog 会把 body 设成 pointer-events:none 并抢占焦点,portal 到 body 的弹层
    // 继承该屏蔽后点不动(表现为「点开没选项」)。非模态不产生这些副作用,弹层
    // 行为与页面上下文一致;点外部/Esc 关闭语义仍由 Radix 保留。
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑任务' : '新建待办任务'}</DialogTitle>
          <DialogDescription>
            {isEdit ? '修改任务内容后保存。' : '描述一个编码任务，稍后可以从看板开始执行。'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <label htmlFor="work-task-title" className="text-ui-body font-medium text-foreground">
              标题 <span className="text-destructive">*</span>
            </label>
            <Input
              id="work-task-title"
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="例如：修复登录页的空状态"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-3">
            <label htmlFor="work-task-instruction" className="text-ui-body font-medium text-foreground">
              任务指令
            </label>
            {/* 与「新建自动化」一致：智能体 / 模型 / 思考强度收进指令框底部工具栏。 */}
            <InstructionComposer
              id="work-task-instruction"
              value={draft.instruction}
              onChange={(instruction) => setDraft((current) => ({ ...current, instruction }))}
              placeholder="描述要完成的工作、目标文件或验收标准……"
              rows={5}
              toolbar={
                <AgentSelector
                  value={draft.agentKind}
                  // 换种类时把供应商/模型一并换成该种类在「智能体运行时」里配的默认,
                  // 否则会带着上一个种类的模型提交(例如 Claude 的默认模型配到 Codex 上)。
                  onChange={(agentKind) => setDraft((current) => ({ ...current, ...defaultsForAgent(agentKind) }))}
                />
              }
              toolbarEnd={
                <AgentModelSelector
                  agentKind={draft.agentKind}
                  providers={modelProviders}
                  activeProviderId={draft.providerId ?? config?.active_provider_id ?? null}
                  value={draft.model ?? ''}
                  onChange={(modelId, providerId) => setDraft((current) => ({
                    ...current,
                    model: modelId,
                    providerId,
                  }))}
                  reasoningEffort={reasoningEffort}
                  onReasoningEffortChange={setReasoningEffort}
                  enableModelContextRegistration={false}
                />
              }
            />
          </div>

          <div className="flex flex-col gap-3">
            {/* 项目靠左、基线分支靠右同排；分支选择器支持筛选与手动输入新分支名。 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-3">
                <span className="text-ui-body font-medium text-foreground">项目</span>
                <AutomationProjectPicker
                  projects={projects}
                  value={draft.projectId}
                  onChange={(projectId) => setDraft((current) => ({ ...current, projectId }))}
                  fullWidth
                />
              </div>
              <div className="flex flex-col gap-3">
                <span className="text-ui-body font-medium text-foreground">基线分支</span>
                <BranchPicker
                  branches={gitBranches}
                  currentBranch={repoState?.currentBranch ?? null}
                  value={draft.baseBranch}
                  onChange={(branch) => setDraft((current) => ({ ...current, baseBranch: branch }))}
                  disabled={branchDisabledReason != null}
                  disabledHint={branchDisabledReason ?? undefined}
                  loading={repoStatus === 'loading'}
                />
              </div>
            </div>
            {draft.projectId != null && repoStatus === 'ready' && !draft.useWorktree && (
              <p className="text-ui-caption text-muted-foreground">
                未启用独立 worktree：将在项目目录迁出所选分支后运行。
              </p>
            )}
            {draft.projectId == null && (
              <p className="text-ui-caption text-destructive">请选择项目后保存</p>
            )}
            <label className="flex items-center gap-2 text-ui-body text-foreground">
              <input
                type="checkbox"
                className="accent-[hsl(var(--primary))]"
                checked={draft.useWorktree}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  useWorktree: event.target.checked,
                }))}
              />
              在独立 worktree 中执行
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {isEdit ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
