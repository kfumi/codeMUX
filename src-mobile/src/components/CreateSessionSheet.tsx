import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';

import {
  createSession,
  fetchBootstrap,
  providerSupportsAgent,
  resolveDefaultProvider,
  type MobileBootstrap,
  type MobileProject,
} from '../lib/api';
import type { CompanionConnection } from '../lib/storage';
import { cn } from '../lib/utils';
import {
  mapExecutionModeToPermissionConfig,
  resolveEffectivePermissionConfig,
  type AgentExecutionMode,
  type AgentPlanMode,
} from '@shared/lib/agentPermissions';
import type { AgentKind } from '@shared/types/session';

const AGENT_KINDS = [
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
] as const;

const REASONING_LABELS: Record<string, string> = {
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};

const PERMISSION_OPTIONS: Record<'claude_code' | 'codex' | 'opencode', Array<{ mode: AgentExecutionMode; label: string }>> = {
  claude_code: [
    { mode: 'confirm_before_edit', label: '变更前确认' },
    { mode: 'auto_edit', label: '自动编辑' },
    { mode: 'auto_review', label: '自动模式' },
    { mode: 'plan', label: '计划模式' },
    { mode: 'full_access', label: '完全访问' },
  ],
  codex: [
    { mode: 'read_only', label: '只读模式' },
    { mode: 'auto_edit', label: '自动模式' },
    { mode: 'auto_review', label: '自动审查' },
    { mode: 'full_access', label: '完全访问' },
  ],
  opencode: [
    { mode: 'confirm_before_edit', label: '构建模式' },
    { mode: 'plan', label: '计划模式' },
  ],
};

interface CreateSessionSheetProps {
  connection: CompanionConnection;
  projects: MobileProject[];
  open: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

export function CreateSessionSheet({
  connection,
  projects,
  open,
  onClose,
  onCreated,
}: CreateSessionSheetProps) {
  const [bootstrap, setBootstrap] = useState<MobileBootstrap | null>(null);
  const [title, setTitle] = useState('移动端会话');
  const [agentKind, setAgentKind] = useState<'claude_code' | 'codex' | 'opencode'>('claude_code');
  const [projectId, setProjectId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('high');
  const [planMode, setPlanMode] = useState<AgentPlanMode>('off');
  const [permissionMode, setPermissionMode] = useState<AgentExecutionMode>('confirm_before_edit');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void fetchBootstrap(connection)
      .then((next) => {
        setBootstrap(next);
        const defaultKind = next.defaultAgentKind as 'claude_code' | 'codex' | 'opencode';
        if (defaultKind === 'claude_code' || defaultKind === 'codex' || defaultKind === 'opencode') {
          setAgentKind(defaultKind);
        }
      })
      .catch((err) => setError(String(err)));
  }, [connection, open]);

  useEffect(() => {
    if (!bootstrap) return;
    const provider = resolveDefaultProvider(bootstrap, agentKind);
    setProviderId(provider?.id ?? '');
    setModel(provider?.defaultModel || provider?.models[0]?.id || '');
    const defaultMode = PERMISSION_OPTIONS[agentKind][0]?.mode ?? 'confirm_before_edit';
    setPermissionMode(defaultMode);
    setPlanMode(defaultMode === 'plan' ? 'on' : 'off');
  }, [agentKind, bootstrap]);

  useEffect(() => {
    if (projects.length > 0 && !projectId) {
      setProjectId(projects[0].id);
    }
  }, [projectId, projects]);

  const providers = useMemo(
    () => bootstrap?.providers.filter((provider) => providerSupportsAgent(provider, agentKind)) ?? [],
    [agentKind, bootstrap],
  );

  const selectedProvider = providers.find((provider) => provider.id === providerId) ?? providers[0] ?? null;
  const models = selectedProvider?.models ?? [];

  if (!open) return null;

  const handleSubmit = async () => {
    if (!title.trim()) return;
    if (!projectId) {
      setError('请先创建或选择一个项目');
      return;
    }
    if (!providerId || !model) {
      setError('当前智能体没有可用供应商');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      // resolveEffectivePermissionConfig already normalizes through
      // serializePermissionConfig, so its result is the final config.
      const permissionConfig = resolveEffectivePermissionConfig(
        agentKind as AgentKind,
        mapExecutionModeToPermissionConfig(agentKind as AgentKind, permissionMode),
        permissionMode === 'plan' ? 'on' : planMode,
      );
      const session = await createSession(connection, {
        title: title.trim(),
        agentKind,
        projectId,
        providerId,
        model,
        reasoningEffort,
        planMode: permissionMode === 'plan' ? 'on' : planMode,
        mode: 'agent',
        permissionConfig: JSON.stringify(permissionConfig),
      });
      onCreated(session.id);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const inputClassName = 'w-full rounded-xl border border-border bg-muted/40 px-4 py-3 outline-none transition-colors focus:border-primary/60 focus:bg-muted/60';

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60">
      <div className="max-h-[88dvh] w-full overflow-y-auto rounded-t-3xl border-t border-border bg-background px-5 pb-8 pt-5 text-foreground">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-base font-semibold">新建会话</div>
          <button type="button" className="rounded-md border border-border/60 p-2 text-muted-foreground" onClick={onClose} aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          <label className="block space-y-2 text-sm">
            <span className="text-muted-foreground">标题</span>
            <input
              className={inputClassName}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className="block space-y-2 text-sm">
            <span className="text-muted-foreground">项目</span>
            <select
              className={inputClassName}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.length === 0 ? <option value="">暂无项目</option> : null}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-2 text-sm">
            <span className="text-muted-foreground">智能体种类</span>
            <select
              className={inputClassName}
              value={agentKind}
              onChange={(event) => setAgentKind(event.target.value as typeof agentKind)}
            >
              {AGENT_KINDS.map((kind) => (
                <option key={kind.id} value={kind.id}>
                  {kind.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-2 text-sm">
            <span className="text-muted-foreground">供应商</span>
            <select
              className={inputClassName}
              value={providerId}
              onChange={(event) => {
                setProviderId(event.target.value);
                const nextProvider = providers.find((provider) => provider.id === event.target.value);
                setModel(nextProvider?.defaultModel || nextProvider?.models[0]?.id || '');
              }}
            >
              {providers.length === 0 ? <option value="">无可用供应商</option> : null}
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-2 text-sm">
            <span className="text-muted-foreground">模型</span>
            <select
              className={inputClassName}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name ?? entry.id}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-2 text-sm">
            <span className="text-muted-foreground">思考强度</span>
            <select
              className={inputClassName}
              value={reasoningEffort}
              onChange={(event) => setReasoningEffort(event.target.value)}
            >
              {(bootstrap?.reasoningEfforts ?? ['high']).map((effort) => (
                <option key={effort} value={effort}>
                  {REASONING_LABELS[effort] ?? effort}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-2 text-sm">
            <span className="text-muted-foreground">权限模式</span>
            <select
              className={inputClassName}
              value={permissionMode}
              onChange={(event) => {
                const nextMode = event.target.value as AgentExecutionMode;
                setPermissionMode(nextMode);
                if (nextMode === 'plan') {
                  setPlanMode('on');
                }
              }}
            >
              {PERMISSION_OPTIONS[agentKind].map((option) => (
                <option key={option.mode} value={option.mode}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {agentKind !== 'opencode' && permissionMode !== 'plan' ? (
            <label className="flex items-center justify-between rounded-xl border border-border px-4 py-3 text-sm">
              <span className="text-muted-foreground">Plan 模式</span>
              <input
                type="checkbox"
                checked={planMode === 'on'}
                onChange={(event) => setPlanMode(event.target.checked ? 'on' : 'off')}
              />
            </label>
          ) : null}

          {error ? (
            <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <button
            type="button"
            disabled={loading || projects.length === 0 || providers.length === 0}
            className={cn(
              'w-full rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground',
              (loading || projects.length === 0 || providers.length === 0) && 'opacity-60',
            )}
            onClick={() => void handleSubmit()}
          >
            {loading ? '创建中…' : '创建并打开'}
          </button>
        </div>
      </div>
    </div>
  );
}
