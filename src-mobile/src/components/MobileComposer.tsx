import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  AtSign,
  Bot,
  Brain,
  Check,
  ChevronDown,
  CircleGauge,
  ClipboardList,
  Cpu,
  Eye,
  FileSearch,
  ImagePlus,
  LoaderCircle,
  Plus,
  Send,
  Shield,
  ShieldCheck,
  Square,
  Terminal,
  X,
  type LucideIcon,
} from 'lucide-react';

import {
  fetchComposerContext,
  providerSupportsAgent,
  resolveDefaultProvider,
  type MobileAgentKind,
  type MobileBootstrap,
  type MobileComposerCommand,
  type MobileComposerContext,
  type MobileInputAttachment,
  type MobileInputPayload,
  type MobileSession,
  type MobileSessionSettingsPatch,
} from '../lib/api';
import type { CompanionConnection } from '../lib/storage';
import { buildMobileContextUsage, formatMobileTokens, type MobileContextUsage } from '../lib/contextUsage';
import { cn } from '../lib/utils';
import { ProviderBrandIcon } from '@/components/settings/ProviderBrandIcon';
import { AgentBrandIcon } from '@/components/agent/AgentBrandIcon';
import { getAgentDefinition } from '@/types/agentRegistry';
import {
  codexWorkflowModeToExecutionMode,
  isOpenCodeAutoApproveEnabled,
  mapExecutionModeToPermissionConfig,
  resolveCodexWorkflowMode,
  resolveEffectivePermissionConfig,
  type AgentExecutionMode,
} from '@shared/lib/agentPermissions';

const AGENT_OPTIONS: Array<{ id: MobileAgentKind; label: string }> = [
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
];

const PERMISSION_OPTIONS: Record<MobileAgentKind, Array<{ mode: AgentExecutionMode; label: string }>> = {
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

const REASONING_LABELS: Record<string, string> = {
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};

type ComposerMenu = 'add' | 'agent' | 'context' | 'model' | 'permission' | 'reasoning' | null;

const PERMISSION_ICONS: Record<AgentExecutionMode, LucideIcon> = {
  confirm_before_edit: Shield,
  auto_edit: ShieldCheck,
  read_only: Eye,
  auto_review: FileSearch,
  plan: ClipboardList,
  full_access: Shield,
};

export interface ActiveComposerTrigger {
  kind: 'file' | 'command';
  query: string;
  start: number;
  end: number;
}

export function findActiveComposerTrigger(value: string, cursor: number): ActiveComposerTrigger | null {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const beforeCursor = value.slice(0, safeCursor);
  const tokenStart = Math.max(beforeCursor.lastIndexOf(' '), beforeCursor.lastIndexOf('\n')) + 1;
  const token = beforeCursor.slice(tokenStart);
  if (!token.startsWith('@') && !token.startsWith('/')) {
    return null;
  }
  if (token.length > 1 && /\s/.test(token.slice(1))) {
    return null;
  }
  return {
    kind: token.startsWith('@') ? 'file' : 'command',
    query: token.slice(1).toLowerCase(),
    start: tokenStart,
    end: safeCursor,
  };
}

export function buildCommandInput(
  command: MobileComposerCommand,
  args: string,
  agentKind: MobileAgentKind,
): string {
  const trimmedArgs = args.trim();
  if (agentKind === 'codex' && command.category === 'skill' && command.filePath) {
    const normalized = command.filePath.replace(/[\\/]+$/, '');
    const separator = command.filePath.includes('\\') ? '\\' : '/';
    return `[$${command.name}](${normalized}${separator}SKILL.md)${trimmedArgs ? ` ${trimmedArgs}` : ' '}`;
  }
  return (command.prompt ?? `/${command.name} {args}`)
    .replace(/\{args\}/g, trimmedArgs)
    .trim();
}

export function canSubmitComposer(text: string, attachmentCount: number): boolean {
  return Boolean(text.trim()) || attachmentCount > 0;
}

function formatSuggestion(command: MobileComposerCommand, agentKind: MobileAgentKind): string {
  if (agentKind === 'codex' && command.category === 'skill' && command.filePath) {
    const normalized = command.filePath.replace(/[\\/]+$/, '');
    const separator = command.filePath.includes('\\') ? '\\' : '/';
    return `[$${command.name}](${normalized}${separator}SKILL.md) `;
  }
  return `/${command.name} `;
}

function isMobileAgentKind(value: string): value is MobileAgentKind {
  return value === 'claude_code' || value === 'codex' || value === 'opencode';
}

export function parsePermissionMode(
  agentKind: MobileAgentKind,
  permissionConfig: string | null | undefined,
  planMode: string | null | undefined,
): AgentExecutionMode {
  // Codex Plan Mode is orthogonal (ADR 0010) — the Workflow tier stands even
  // while the plan toggle is on.
  if (planMode === 'on' && agentKind !== 'codex') {
    return 'plan';
  }
  try {
    const raw = JSON.parse(permissionConfig ?? '{}') as Record<string, unknown>;
    if (agentKind === 'opencode') {
      // Plan vs build mirrors the official agent selector; plan_mode carries
      // it (handled above), the snapshot only tracks the auto-approve shield.
      return 'confirm_before_edit';
    }
    if (agentKind === 'codex') {
      return codexWorkflowModeToExecutionMode(resolveCodexWorkflowMode(raw));
    }
    switch (raw.permissionMode) {
      case 'acceptEdits':
        return 'auto_edit';
      case 'auto':
        return 'auto_review';
      case 'plan':
        return 'plan';
      case 'bypassPermissions':
        return 'full_access';
      default:
        return 'confirm_before_edit';
    }
  } catch {
    return 'confirm_before_edit';
  }
}

function readImage(file: File): Promise<MobileInputAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('无法读取图片'));
        return;
      }
      resolve({
        type: 'image',
        name: file.name || 'image',
        mediaType: file.type || 'image/png',
        dataUrl: reader.result,
        size: file.size,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error('无法读取图片'));
    reader.readAsDataURL(file);
  });
}

function filterCommands(commands: MobileComposerCommand[], query: string): MobileComposerCommand[] {
  const normalized = query.trim().toLowerCase();
  return commands
    .filter((command) => !normalized || command.name.toLowerCase().startsWith(normalized))
    .slice(0, 8);
}

function filterFiles(
  files: MobileComposerContext['files'],
  query: string,
): MobileComposerContext['files'] {
  const normalized = query.trim().toLowerCase();
  return files
    .filter((file) => !normalized || file.path.toLowerCase().includes(normalized))
    .slice(0, 8);
}

export function buildSettingsPatch(
  agentKind: MobileAgentKind,
  providerId: string,
  model: string,
  reasoningEffort: string,
  permissionMode: AgentExecutionMode,
  planMode: 'on' | 'off',
  openCodeAutoApprove = false,
): MobileSessionSettingsPatch {
  const effectivePlanMode = permissionMode === 'plan' ? 'on' : planMode;
  // resolveEffectivePermissionConfig already normalizes through
  // serializePermissionConfig, so its result is the final config. For
  // OpenCode the auto-approve shield state must survive settings rewrites.
  const requestedConfig = agentKind === 'opencode'
    ? { kind: 'opencode' as const, autoApprovePermissions: openCodeAutoApprove }
    : mapExecutionModeToPermissionConfig(agentKind, permissionMode);
  const config = resolveEffectivePermissionConfig(
    agentKind,
    requestedConfig,
    effectivePlanMode,
  );
  return {
    agentKind,
    providerId: providerId || null,
    model: model || null,
    reasoningEffort: reasoningEffort || null,
    permissionConfig: config,
    planMode: effectivePlanMode,
  };
}

/** Parses the OpenCode auto-approve shield state from a session snapshot. */
export function parseOpenCodeAutoApprove(permissionConfig: string | null | undefined): boolean {
  try {
    return isOpenCodeAutoApproveEnabled(JSON.parse(permissionConfig ?? '{}'));
  } catch {
    return false;
  }
}

function ToolbarMenuButton({
  active = false,
  disabled = false,
  icon: Icon,
  iconNode,
  label,
  labelText,
  onClick,
  tone = 'default',
}: {
  active?: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  iconNode?: ReactNode;
  label: string;
  labelText?: string;
  onClick: () => void;
  tone?: 'default' | 'warning';
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground/78 transition-all duration-150 hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 active:scale-95 disabled:pointer-events-none disabled:opacity-45',
        labelText ? 'min-w-0 max-w-[min(9rem,30vw)] gap-1.5 px-2' : 'w-8',
        active && 'bg-muted/70 text-foreground',
        tone === 'warning' && 'border-orange-500/25 text-orange-500 hover:bg-orange-500/10 hover:text-orange-400',
      )}
    >
      {iconNode ?? <Icon className="h-4 w-4 shrink-0" strokeWidth={1.9} />}
      {labelText ? <span className="min-w-0 truncate text-[11px] font-medium">{labelText}</span> : null}
    </button>
  );
}

function ToolbarPopover({
  align = 'left',
  children,
  className,
}: {
  align?: 'left' | 'right';
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="menu"
      className={cn(
        'absolute bottom-[calc(100%+0.5rem)] z-50 max-h-[min(22rem,calc(100vh-9rem))] overflow-y-auto rounded-xl border border-border/70 bg-[hsl(var(--surface-2))]/98 p-1.5 text-foreground shadow-[0_20px_54px_-30px_hsl(var(--surface-shadow-strong)/0.58)] backdrop-blur-xl',
        align === 'right' ? 'right-0' : 'left-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

function ToolbarMenuItem({
  active = false,
  description,
  icon: Icon,
  iconNode,
  label,
  onClick,
  tone = 'default',
}: {
  active?: boolean;
  description?: string;
  icon: LucideIcon;
  iconNode?: ReactNode;
  label: string;
  onClick: () => void;
  tone?: 'default' | 'warning';
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        'flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/56 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45',
        active && 'bg-muted/66',
      )}
    >
      {iconNode ?? (
        <Icon
          className={cn('h-4 w-4 shrink-0 text-muted-foreground', tone === 'warning' && 'text-orange-500')}
          strokeWidth={1.9}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{label}</span>
        {description ? <span className="block truncate text-[11px] leading-4 text-muted-foreground">{description}</span> : null}
      </span>
      {active ? <Check className="h-3.5 w-3.5 shrink-0 text-foreground/75" /> : null}
    </button>
  );
}

function ModelBottomSheet({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end bg-black/55"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-model-sheet-title"
        className="max-h-[min(78dvh,36rem)] w-full overflow-hidden rounded-t-3xl border border-b-0 border-border/75 bg-[hsl(var(--surface-2))] text-foreground shadow-[0_-20px_54px_-28px_hsl(var(--surface-shadow-strong)/0.72)]"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/45 px-4 pb-3 pt-3">
          <div className="min-w-0">
            <div id="mobile-model-sheet-title" className="text-sm font-semibold">选择模型</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">选择供应商后切换可用模型</div>
          </div>
          <button
            type="button"
            aria-label="关闭模型选择"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[calc(78dvh-4.75rem)] overflow-y-auto overscroll-contain px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
          {children}
        </div>
      </div>
    </div>
  );
}

function ContextIndicator({
  loading,
  ready,
  usage,
}: {
  loading: boolean;
  ready: boolean;
  usage: MobileContextUsage | null;
}) {
  if (usage) {
    return <UsageRing percentage={usage.percentage * 100} />;
  }

  return (
    <span className="relative inline-flex h-5 w-5 items-center justify-center">
      <CircleGauge className={cn(
        'h-4 w-4 transition-colors',
        loading ? 'animate-pulse text-muted-foreground' : ready ? 'text-success' : 'text-muted-foreground/60',
      )} strokeWidth={1.8} />
      {ready && !loading ? <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-success" /> : null}
    </span>
  );
}

function UsageRing({ percentage }: { percentage: number }) {
  const size = 24;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;
  const stroke = getProgressColor(percentage);

  return (
    <span className="relative inline-flex h-4 w-4 items-center justify-center" aria-hidden="true">
      <svg className="-rotate-90" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
    </span>
  );
}

function getProgressColor(percentage: number): string {
  if (percentage >= 90) return 'hsl(var(--destructive))';
  if (percentage >= 70) return 'hsl(var(--warning))';
  return 'hsl(var(--success))';
}

function ContextUsageSummary({ usage }: { usage: MobileContextUsage | null }) {
  return (
    <>
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-medium text-foreground">上下文</span>
        <span className="text-sm font-medium text-foreground">
          {usage ? `${Math.round(usage.percentage * 100)}%` : '--'}
        </span>
      </div>
      {usage ? (
        <div className="border-t border-border/45 px-4 py-3">
          <div className="space-y-2">
            {([
              ['输入', usage.inputTokens],
              ['缓存', usage.cachedTokens],
              ['输出', usage.outputTokens],
            ] as Array<[string, number]>)
              .filter(([, value]) => value > 0)
              .map(([label, value]) => (
                <ContextStatRow key={label} label={label} value={value} />
              ))}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-border/45 pt-3 text-sm">
            <span className="font-medium text-foreground">总计</span>
            <span className="font-medium text-foreground">
              {formatMobileTokens(usage.usedTokens)} / {formatMobileTokens(usage.totalTokens)}
            </span>
          </div>
        </div>
      ) : (
        <div className="border-t border-border/45 px-4 py-3 text-sm text-muted-foreground">
          暂无 token 用量
        </div>
      )}
    </>
  );
}

function ContextStatRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{formatMobileTokens(value)}</span>
    </div>
  );
}

export interface MobileComposerProps {
  connection: CompanionConnection;
  session: MobileSession;
  bootstrap: MobileBootstrap | null;
  connected: boolean;
  offline: boolean;
  running: boolean;
  onSend: (prompt: string, inputPayload: MobileInputPayload) => Promise<void>;
  onStop: () => Promise<void>;
  onSettingsChange: (settings: MobileSessionSettingsPatch) => Promise<void>;
}

export function MobileComposer({
  connection,
  session,
  bootstrap,
  connected,
  offline,
  running,
  onSend,
  onStop,
  onSettingsChange,
}: MobileComposerProps) {
  const sessionAgentKind = isMobileAgentKind(session.agent_kind) ? session.agent_kind : 'claude_code';
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);
  const [attachments, setAttachments] = useState<MobileInputAttachment[]>([]);
  const [context, setContext] = useState<MobileComposerContext | null>(null);
  const [agentKind, setAgentKind] = useState<MobileAgentKind>(sessionAgentKind);
  const [providerId, setProviderId] = useState(session.provider_id ?? '');
  const [model, setModel] = useState(session.model ?? '');
  const [reasoningEffort, setReasoningEffort] = useState(session.reasoning_effort ?? 'high');
  const [planMode, setPlanMode] = useState<'on' | 'off'>(session.plan_mode === 'on' ? 'on' : 'off');
  const [permissionMode, setPermissionMode] = useState<AgentExecutionMode>(
    parsePermissionMode(sessionAgentKind, session.permission_config, session.plan_mode),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<ComposerMenu>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const contextRequestRef = useRef(0);

  useEffect(() => {
    setAgentKind(sessionAgentKind);
    setProviderId(session.provider_id ?? '');
    setModel(session.model ?? '');
    setReasoningEffort(session.reasoning_effort ?? 'high');
    setPlanMode(session.plan_mode === 'on' ? 'on' : 'off');
    setPermissionMode(parsePermissionMode(sessionAgentKind, session.permission_config, session.plan_mode));
  }, [
    session.agent_kind,
    session.model,
    session.permission_config,
    session.plan_mode,
    session.provider_id,
    session.reasoning_effort,
    sessionAgentKind,
  ]);

  const refreshContext = useCallback(async () => {
    const requestId = contextRequestRef.current + 1;
    contextRequestRef.current = requestId;
    if (offline) {
      setContext(null);
      setContextLoading(false);
      return;
    }
    setContextLoading(true);
    try {
      const next = await fetchComposerContext(connection, session.id);
      if (contextRequestRef.current === requestId) {
        setContext(next);
      }
    } catch {
      if (contextRequestRef.current === requestId) {
        setContext({ files: [], commands: [], tokenUsage: null });
      }
    } finally {
      if (contextRequestRef.current === requestId) {
        setContextLoading(false);
      }
    }
  }, [connection, offline, session.id]);

  useEffect(() => {
    void refreshContext();
    return () => {
      contextRequestRef.current += 1;
    };
  }, [refreshContext]);

  useEffect(() => {
    if (!openMenu) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) {
        return;
      }
      setOpenMenu(null);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenu]);

  const providers = useMemo(
    () => bootstrap?.providers.filter((provider) => providerSupportsAgent(provider, agentKind)) ?? [],
    [agentKind, bootstrap],
  );
  const selectedProvider = providers.find((provider) => provider.id === providerId) ?? providers[0] ?? null;
  const models = selectedProvider?.models ?? [];
  const activeTrigger = useMemo(
    () => findActiveComposerTrigger(text, cursor),
    [cursor, text],
  );
  const suggestions = useMemo(() => {
    if (!activeTrigger || !context) return [];
    if (activeTrigger.kind === 'command') {
      return filterCommands(context.commands, activeTrigger.query);
    }
    return filterFiles(context.files, activeTrigger.query);
  }, [activeTrigger, context]);
  const canEditSettings = !offline && !running && !busy && !session.is_read_only;
  const canSend = !offline
    && connected
    && !running
    && !busy
    && canSubmitComposer(text, attachments.length);
  const SelectedPermissionIcon = PERMISSION_ICONS[permissionMode];
  const selectedAgent = AGENT_OPTIONS.find((option) => option.id === agentKind);
  const selectedAgentDefinition = getAgentDefinition(agentKind);
  const selectedPermission = PERMISSION_OPTIONS[agentKind].find((option) => option.mode === permissionMode);
  const openCodeAutoApprove = useMemo(
    () => parseOpenCodeAutoApprove(session.permission_config),
    [session.permission_config],
  );
  const selectedModel = models.find((entry) => entry.id === model);
  const selectedModelLabel = selectedModel?.name ?? selectedModel?.id ?? (model || '模型');
  const selectedProviderLabel = selectedProvider?.name ?? '供应商';
  const contextUsage = useMemo(
    () => buildMobileContextUsage(context?.tokenUsage, model),
    [context?.tokenUsage, model],
  );

  const commitSettings = useCallback(async (settings: MobileSessionSettingsPatch) => {
    setError(null);
    setBusy(true);
    try {
      await onSettingsChange(settings);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [onSettingsChange]);

  const handleProviderChange = (nextProviderId: string) => {
    if (!canEditSettings) return;
    const nextProvider = providers.find((provider) => provider.id === nextProviderId);
    const nextModel = nextProvider?.defaultModel || nextProvider?.models[0]?.id || '';
    setProviderId(nextProviderId);
    setModel(nextModel);
    void commitSettings(buildSettingsPatch(
      agentKind,
      nextProviderId,
      nextModel,
      reasoningEffort,
      permissionMode,
      planMode,
      openCodeAutoApprove,
    ));
  };

  const handleModelChange = (nextModel: string) => {
    if (!canEditSettings) return;
    setModel(nextModel);
    void commitSettings(buildSettingsPatch(
      agentKind,
      providerId,
      nextModel,
      reasoningEffort,
      permissionMode,
      planMode,
      openCodeAutoApprove,
    ));
  };

  const handleReasoningChange = (nextReasoningEffort: string) => {
    if (!canEditSettings) return;
    setReasoningEffort(nextReasoningEffort);
    void commitSettings(buildSettingsPatch(
      agentKind,
      providerId,
      model,
      nextReasoningEffort,
      permissionMode,
      planMode,
      openCodeAutoApprove,
    ));
  };

  const handlePermissionChange = (nextPermissionMode: AgentExecutionMode) => {
    if (!canEditSettings) return;
    const nextPlanMode = nextPermissionMode === 'plan' ? 'on' : planMode;
    setPermissionMode(nextPermissionMode);
    setPlanMode(nextPlanMode);
    void commitSettings(buildSettingsPatch(
      agentKind,
      providerId,
      model,
      reasoningEffort,
      nextPermissionMode,
      nextPlanMode,
      openCodeAutoApprove,
    ));
  };

  /** Official OpenCode "auto-approve permissions" shield toggle (orthogonal to build/plan). */
  const handleAutoApproveToggle = () => {
    if (!canEditSettings || agentKind !== 'opencode') return;
    void commitSettings(buildSettingsPatch(
      agentKind,
      providerId,
      model,
      reasoningEffort,
      permissionMode,
      planMode,
      !openCodeAutoApprove,
    ));
  };

  /** Issue 12: independent Plan toggle. Codex keeps its Workflow tier; other kinds map plan onto their permission mode. */
  const handlePlanToggle = () => {
    if (!canEditSettings) return;
    const nextPlanMode = planMode === 'on' ? 'off' : 'on';
    setPlanMode(nextPlanMode);
    if (agentKind === 'codex') {
      void commitSettings(buildSettingsPatch(
        agentKind,
        providerId,
        model,
        reasoningEffort,
        permissionMode,
        nextPlanMode,
      ));
      return;
    }
    handlePermissionChange(nextPlanMode === 'on' ? 'plan' : 'confirm_before_edit');
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const images = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (images.length !== files.length) {
      setError('目前仅支持图片附件；代码文件请使用 @ 引用');
    }
    try {
      const next = await Promise.all(images.map(readImage));
      setAttachments((current) => [...current, ...next].slice(0, 6));
    } catch (err) {
      setError(String(err));
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith('image/'));
    if (!image) return;
    event.preventDefault();
    void handleFiles(event.clipboardData.files);
  };

  const activateTrigger = (trigger: '@' | '/') => {
    const nextText = `${text}${trigger}`;
    setText(nextText);
    setCursor(nextText.length);
    setContextOpen(true);
    setOpenMenu(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextText.length, nextText.length);
    });
  };

  const selectSuggestion = (suggestion: MobileComposerContext['files'][number] | MobileComposerCommand) => {
    if (!activeTrigger) return;
    const replacement = activeTrigger.kind === 'file'
      ? (() => {
        const file = suggestion as MobileComposerContext['files'][number];
        const path = file.kind === 'directory' && !file.path.endsWith('/') ? `${file.path}/` : file.path;
        return `[${file.name}](${path}) `;
      })()
      : formatSuggestion(suggestion as MobileComposerCommand, agentKind);
    const nextText = `${text.slice(0, activeTrigger.start)}${replacement}${text.slice(activeTrigger.end)}`;
    const nextCursor = activeTrigger.start + replacement.length;
    setText(nextText);
    setCursor(nextCursor);
    setContextOpen(false);
    setOpenMenu(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const submit = async () => {
    if (!canSend) return;
    const trimmedText = text.trim();
    const payload: MobileInputPayload = {
      text: trimmedText,
      attachments: attachments.length ? attachments : undefined,
      images: attachments.length
        ? attachments.map(({ type: _type, ...image }) => image)
        : undefined,
    };
    setError(null);
    setBusy(true);
    try {
      await onSend(trimmedText, payload);
      setText('');
      setCursor(0);
      setAttachments([]);
      setContextOpen(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    void submit();
  };

  return (
    <div className="relative px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
      {contextOpen && activeTrigger && suggestions.length > 0 ? (
        <div className="absolute bottom-full left-4 right-4 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-background p-1 shadow-xl">
          {suggestions.map((suggestion) => {
            const isFile = activeTrigger.kind === 'file';
            const key = isFile
              ? (suggestion as MobileComposerContext['files'][number]).path
              : (suggestion as MobileComposerCommand).name;
            const label = isFile
              ? (suggestion as MobileComposerContext['files'][number]).path
              : `/${(suggestion as MobileComposerCommand).name}`;
            const description = isFile
              ? (suggestion as MobileComposerContext['files'][number]).kind
              : (suggestion as MobileComposerCommand).description;
            return (
              <button
                key={key}
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-muted/60"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectSuggestion(suggestion)}
              >
                {isFile ? <AtSign className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
                <span className="shrink-0 text-muted-foreground">{description}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="rounded-[1.25rem] border border-border/82 bg-[hsl(var(--surface-1))]/94 p-2.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.026)] transition-all duration-200 focus-within:border-[hsl(var(--primary)/0.38)] focus-within:shadow-[0_18px_42px_-30px_hsl(var(--primary)/0.36),inset_0_1px_0_hsl(var(--foreground)/0.035)]">
        {attachments.length > 0 ? (
          <div className="mb-2 flex gap-2 overflow-x-auto px-0.5 pt-0.5">
            {attachments.map((attachment, index) => (
              <div key={`${attachment.name}-${index}`} className="relative shrink-0">
                <img
                  src={attachment.dataUrl}
                  alt={attachment.name}
                  className="size-14 rounded-lg border border-border/70 object-cover shadow-[0_8px_22px_-18px_hsl(var(--surface-shadow-strong)/0.45)]"
                />
                <button
                  type="button"
                  className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/60 bg-background/92 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
                  onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  aria-label={`移除 ${attachment.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          className="block min-h-14 max-h-52 w-full resize-none overflow-y-auto bg-transparent px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/70"
          placeholder="输入消息… (@ 引用文件，/ 使用命令)"
          rows={2}
          value={text}
          disabled={offline || session.is_read_only}
          onChange={(event) => {
            setText(event.target.value);
            setCursor(event.target.selectionStart ?? event.target.value.length);
            const trigger = findActiveComposerTrigger(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            );
            setContextOpen(Boolean(trigger));
          }}
          onSelect={(event) => {
            setCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />

        <div ref={toolbarRef} className="relative flex min-w-0 items-center gap-0.5 border-t border-border/12 px-1 pt-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              void handleFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <div className="relative">
            <ToolbarMenuButton
              active={openMenu === 'add'}
              disabled={offline || session.is_read_only}
              icon={Plus}
              label="添加附件或功能"
              onClick={() => setOpenMenu((current) => current === 'add' ? null : 'add')}
            />
            {openMenu === 'add' ? (
              <ToolbarPopover className="w-52">
                <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground/70">添加到消息</div>
                <ToolbarMenuItem
                  icon={ImagePlus}
                  label="添加图片"
                  description="上传截图或图片附件"
                  onClick={() => {
                    setOpenMenu(null);
                    fileInputRef.current?.click();
                  }}
                />
                <ToolbarMenuItem
                  active={activeTrigger?.kind === 'file'}
                  icon={AtSign}
                  label="引用文件"
                  description="输入 @ 搜索项目文件"
                  onClick={() => activateTrigger('@')}
                />
                <ToolbarMenuItem
                  active={activeTrigger?.kind === 'command'}
                  icon={Terminal}
                  label="使用命令"
                  description="输入 / 搜索命令或技能"
                  onClick={() => activateTrigger('/')}
                />
                {agentKind !== 'opencode' ? (
                  <ToolbarMenuItem
                    active={planMode === 'on'}
                    icon={ClipboardList}
                    label={planMode === 'on' ? '关闭计划模式' : '计划模式'}
                    description={agentKind === 'codex' ? '正交开关：不改变当前权限档位' : '先分析和规划，不直接修改'}
                    onClick={() => {
                      handlePlanToggle();
                      setOpenMenu(null);
                    }}
                  />
                ) : null}
              </ToolbarPopover>
            ) : null}
          </div>

          <div className="relative">
            <ToolbarMenuButton
              active={openMenu === 'permission'}
              disabled={!canEditSettings}
              icon={SelectedPermissionIcon}
              label={`权限：${selectedPermission?.label ?? '权限模式'}${agentKind === 'codex' && planMode === 'on' ? ' · 计划' : ''}`}
              onClick={() => setOpenMenu((current) => current === 'permission' ? null : 'permission')}
              tone={permissionMode === 'full_access' ? 'warning' : 'default'}
            />
            {openMenu === 'permission' ? (
              <ToolbarPopover className="w-[min(20rem,calc(100vw-2rem))]">
                <div className="px-2.5 pb-1.5 pt-1">
                  <div className="text-xs font-semibold text-foreground">权限模式</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">控制桌面端 Agent 的执行权限</div>
                </div>
                {PERMISSION_OPTIONS[agentKind].map((option) => (
                  <ToolbarMenuItem
                    key={option.mode}
                    active={permissionMode === option.mode}
                    icon={PERMISSION_ICONS[option.mode]}
                    label={option.label}
                    description={option.mode === 'full_access' ? '跳过权限确认，风险更高' : option.mode === 'plan' ? '先分析和规划，暂不直接修改' : '按当前 Agent 的权限策略执行'}
                    onClick={() => {
                      handlePermissionChange(option.mode);
                      setOpenMenu(null);
                    }}
                    tone={option.mode === 'full_access' ? 'warning' : 'default'}
                  />
                ))}
                {agentKind === 'opencode' ? (
                  <ToolbarMenuItem
                    active={openCodeAutoApprove}
                    icon={openCodeAutoApprove ? ShieldCheck : Shield}
                    label={openCodeAutoApprove ? '关闭自动接受权限' : '自动接受权限'}
                    description="显式拒绝的规则仍会生效"
                    onClick={() => {
                      handleAutoApproveToggle();
                      setOpenMenu(null);
                    }}
                    tone={openCodeAutoApprove ? 'warning' : 'default'}
                  />
                ) : null}
              </ToolbarPopover>
            ) : null}
          </div>

          <div className="relative">
            <button
              type="button"
              aria-label="上下文"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'context'}
              disabled={offline}
              onClick={() => {
                setOpenMenu((current) => current === 'context' ? null : 'context');
                void refreshContext();
              }}
              className={cn(
                'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent transition-all duration-150 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 active:scale-95 disabled:pointer-events-none disabled:opacity-45',
                openMenu === 'context' && 'bg-muted/70',
              )}
            >
              <ContextIndicator
                loading={contextLoading}
                ready={Boolean(context)}
                usage={contextUsage}
              />
            </button>
            {openMenu === 'context' ? (
              <ToolbarPopover className="w-56">
                <ContextUsageSummary usage={contextUsage} />
              </ToolbarPopover>
            ) : null}
          </div>

          <div className="relative">
            <ToolbarMenuButton
              disabled
              icon={Bot}
              iconNode={selectedAgentDefinition ? <AgentBrandIcon agent={selectedAgentDefinition} size="sm" /> : undefined}
              label={`智能体：${selectedAgent?.label ?? agentKind}`}
            />
          </div>

          <div className="relative">
            <ToolbarMenuButton
              active={openMenu === 'model'}
              disabled={!canEditSettings || models.length === 0}
              icon={Cpu}
              iconNode={
                <ProviderBrandIcon
                  templateId={selectedProvider?.templateId ?? selectedProvider?.id}
                  name={selectedProvider?.name}
                  className="h-4 w-4 rounded-md"
                  size={14}
                />
              }
              label={`模型：${selectedModelLabel}`}
              labelText={selectedModelLabel}
              onClick={() => setOpenMenu((current) => current === 'model' ? null : 'model')}
            />
          </div>

          <div className="relative">
            <ToolbarMenuButton
              active={openMenu === 'reasoning'}
              disabled={!canEditSettings}
              icon={Brain}
              label={`思考强度：${REASONING_LABELS[reasoningEffort] ?? reasoningEffort}`}
              onClick={() => setOpenMenu((current) => current === 'reasoning' ? null : 'reasoning')}
            />
            {openMenu === 'reasoning' ? (
              <ToolbarPopover align="right" className="w-44">
                <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground/70">思考强度</div>
                {(bootstrap?.reasoningEfforts ?? ['high']).map((effort) => (
                  <ToolbarMenuItem
                    key={effort}
                    active={reasoningEffort === effort}
                    icon={Brain}
                    label={REASONING_LABELS[effort] ?? effort}
                    onClick={() => {
                      handleReasoningChange(effort);
                      setOpenMenu(null);
                    }}
                  />
                ))}
              </ToolbarPopover>
            ) : null}
          </div>

          <div className="ml-auto flex shrink-0 items-center pl-1">
            {running ? (
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--destructive)/0.12)] text-destructive transition-colors hover:bg-[hsl(var(--destructive)/0.18)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/35 disabled:pointer-events-none disabled:opacity-50"
                onClick={() => void onStop().catch((err) => setError(String(err)))}
                disabled={busy || offline}
                aria-label="停止运行"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                className={cn(
                  'inline-flex h-8 w-8 items-center justify-center rounded-xl transition-all duration-200 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45',
                  canSend
                    ? 'bg-primary text-primary-foreground shadow-[0_10px_24px_-15px_hsl(var(--primary)/0.58)] hover:bg-primary/94'
                    : 'cursor-not-allowed bg-[hsl(var(--surface-3))] text-muted-foreground/42',
                )}
                onClick={() => void submit()}
                disabled={!canSend}
                aria-label="发送"
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            )}
          </div>
        </div>
      </div>
      {openMenu === 'model' ? (
        <ModelBottomSheet onClose={() => setOpenMenu(null)}>
          <div className="px-2 pb-2">
            <div className="truncate text-xs font-semibold text-foreground">{selectedProviderLabel}</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{selectedModelLabel}</div>
          </div>
          {providers.length > 1 ? (
            <div className="flex gap-2 overflow-x-auto border-y border-border/45 px-2 py-2">
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  aria-pressed={provider.id === providerId}
                  onClick={() => handleProviderChange(provider.id)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                    provider.id === providerId
                      ? 'bg-foreground text-background'
                      : 'bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <ProviderBrandIcon
                    templateId={provider.templateId ?? provider.id}
                    name={provider.name}
                    className="h-4 w-4 rounded-sm"
                    size={12}
                  />
                  <span className="max-w-32 truncate">{provider.name}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="py-1">
            {models.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">没有可用模型</div>
            ) : (
              models.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={entry.id === model}
                  onClick={() => {
                    handleModelChange(entry.id);
                    setOpenMenu(null);
                  }}
                  className={cn(
                    'flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-muted/56 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45',
                    entry.id === model && 'bg-muted/66',
                  )}
                >
                  <ProviderBrandIcon
                    templateId={selectedProvider?.templateId ?? selectedProvider?.id}
                    name={selectedProvider?.name}
                    className="h-8 w-8 rounded-lg"
                    size={16}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{entry.name ?? entry.id}</span>
                    <span className="block truncate text-xs text-muted-foreground">{entry.id}</span>
                  </span>
                  {entry.id === model ? <Check className="h-4 w-4 shrink-0 text-foreground/75" /> : null}
                </button>
              ))
            )}
          </div>
        </ModelBottomSheet>
      ) : null}
      {error ? <div className="mt-1.5 px-1 text-xs text-destructive">{error}</div> : null}
      {contextOpen && activeTrigger && suggestions.length === 0 && !contextLoading ? (
        <div className="mt-1 px-1 text-xs text-muted-foreground">
          {activeTrigger.kind === 'file' ? '没有匹配的项目文件' : '没有匹配的命令'}
        </div>
      ) : null}
    </div>
  );
}
