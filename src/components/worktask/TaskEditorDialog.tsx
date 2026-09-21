import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { daemonFacade } from '../../lib/facades/daemon-facade';
import { AgentSelector } from '../agent/AgentSelector';
import { AgentModelSelector } from '../agent/AgentModelSelector';
import { AutomationProjectPicker } from '../automation/AutomationProjectPicker';
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

  const [draft, setDraft] = useState<EditorDraft>({
    title: '',
    instruction: '',
    projectId: defaultProjectId,
    agentKind: 'claude_code',
    providerId: null,
    model: null,
    useWorktree: true,
    baseBranch: '',
  });
  // WorkTaskInput 不含 reasoning effort；选择器需要该 prop，本地暂存不落库。
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('high');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 项目当前分支（占位提示用）；预取失败静默回退为固定占位文案。
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const branchFetchSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    fetchProjects();
    setCurrentBranch(null);
    if (task) {
      setDraft(draftFromTask(task));
    } else {
      setDraft({
        title: '',
        instruction: '',
        projectId: defaultProjectId,
        agentKind: 'claude_code',
        providerId: config?.active_provider_id ?? null,
        model: null,
        useWorktree: true,
        baseBranch: '',
      });
    }
  }, [open, task, defaultProjectId, fetchProjects, config]);

  // 选中项目且勾选 worktree 时预取当前分支，作为基线分支输入的占位提示（失败静默）。
  useEffect(() => {
    if (!open || !draft.useWorktree || draft.projectId == null) return;
    const project = projects.find((entry) => entry.id === draft.projectId);
    if (!project) return;
    const seq = ++branchFetchSeq.current;
    daemonFacade.git
      .getRepositoryState(project.path)
      .then((state) => {
        if (seq === branchFetchSeq.current) {
          setCurrentBranch(state.currentBranch);
        }
      })
      .catch(() => {
        // 预取失败静默：占位文案保持「默认：项目当前分支」。
      });
  }, [open, draft.useWorktree, draft.projectId, projects]);

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

  const baseBranchPlaceholder = currentBranch
    ? `默认：项目当前分支（${currentBranch}）`
    : '默认：项目当前分支';
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

        <div className="space-y-4">
          <div className="space-y-1.5">
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

          <div className="space-y-1.5">
            <label htmlFor="work-task-instruction" className="text-ui-body font-medium text-foreground">
              任务指令
            </label>
            <textarea
              id="work-task-instruction"
              value={draft.instruction}
              onChange={(event) => setDraft((current) => ({ ...current, instruction: event.target.value }))}
              placeholder="描述要完成的工作、目标文件或验收标准……"
              rows={5}
              className="w-full resize-y rounded-md border border-transparent bg-muted/80 px-3 py-2 text-ui-body text-foreground ring-offset-background transition-[background-color,border-color,color,box-shadow] duration-150 placeholder:text-muted-foreground hover:bg-muted focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:ring-offset-0"
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-ui-body font-medium text-foreground">项目</span>
            <AutomationProjectPicker
              projects={projects}
              value={draft.projectId}
              onChange={(projectId) => setDraft((current) => ({ ...current, projectId }))}
            />
            {draft.projectId == null && (
              <p className="text-ui-caption text-destructive">请选择项目后保存</p>
            )}
          </div>

          <div className="space-y-2">
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
            {draft.useWorktree && (
              <div className="space-y-1.5">
                <label
                  htmlFor="work-task-base-branch"
                  className="text-ui-body font-medium text-foreground"
                >
                  基线分支
                </label>
                <Input
                  id="work-task-base-branch"
                  value={draft.baseBranch}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    baseBranch: event.target.value,
                  }))}
                  placeholder={baseBranchPlaceholder}
                />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <AgentSelector
              value={draft.agentKind}
              onChange={(agentKind) => setDraft((current) => ({ ...current, agentKind }))}
            />
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
