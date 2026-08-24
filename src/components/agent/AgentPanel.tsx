import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { getStoredAgentCwd, resolveSessionWorkingPath } from '../../lib/sessionCwd';
import { getProviderPrimaryModel } from '../../lib/agentProfileSelector';
import { getActiveModelProvider, isProviderUsable } from '../../lib/modelProviders';
import type { CommandContext, SlashCommand } from '../../lib/slashCommands';
import { formatCommandDisplay, renderCommandInput } from '../../lib/slashCommands';
import { mapExecutionModeToPermissionConfig, serializePermissionConfig, type AgentPermissionConfig, type AgentPlanMode } from '../../lib/agentPermissions';
import { normalizeReasoningEffort } from '../../lib/reasoningEffort';
import type { ReasoningEffort } from '../../types/session';
import type { AgentInputPayload } from '../../types/agentInput';
import type { AgentPermissionRequest, AgentPermissionResponse } from '../../types/agent';
import { agentApi, sessionApi } from '../../lib/tauri';
import { useAgentStore } from '../../stores/agentStore';
import type { AgentMessage } from '../../stores/agentStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { projectSkillCacheKey, useProjectSkillStore } from '@/stores/projectSkillStore';
import type { ProjectSkill } from '@/types/skill';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePerfStore } from '../../stores/perfStore';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { CodeMuxComposer } from './assistant-ui/CodeMuxComposer';
import { CodeMuxAssistantRuntimeProvider } from './assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxThread } from './assistant-ui/CodeMuxThread';
import { AgentPermissionSelector } from './AgentPermissionSelector';
import { AgentModelSelector } from './AgentModelSelector';
import { AgentSelector } from './AgentSelector';
import { getAgentDefinition } from '../../types/agentRegistry';
import type { AgentKind } from '../../types/session';
import {
  checkProfileModelSupports1m,
  formatModelDisplayName,
  getProfileModelContextWindow,
  stripContext1mSuffix,
} from './modelDisplay';
import { MarkdownRenderer } from './MarkdownRenderer';

interface AgentPanelProps {
  sessionId: string;
}

const EMPTY_PENDING_PERMISSIONS: AgentPermissionRequest[] = [];
const EMPTY_PROJECT_SKILLS: ProjectSkill[] = [];
const EMPTY_SESSION_EVENTS: AgentMessage[] = [];

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const { sessions, createSession, updateSessionPermissions, switchSessionAgentKind } = useSessionStore();
  const { projects } = useProjectStore();
  const startQuery = useAgentStore((state) => state.startQuery);
  const interrupt = useAgentStore((state) => state.interrupt);
  const loadSessionMessages = useAgentStore((state) => state.loadSessionMessages);
  const sessionsLoading = useSessionStore((state) => state.isLoading);
  const clearEvents = useAgentStore((state) => state.clearEvents);
  const respondToPermission = useAgentStore((state) => state.respondToPermission);
  const pendingPermissions = useAgentStore((state) => state.pendingPermissions[sessionId] ?? EMPTY_PENDING_PERMISSIONS);
  const { config, getActiveProvider } = useSettingsStore();
  const { setProjectPath } = usePreviewStore();
  const loadProjectSkills = useProjectSkillStore((state) => state.load);

  // 检测容器宽度，窄屏时启用紧凑模式
  const containerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCompact(entry.contentRect.width < 640);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);

  const session = sessions.find((entry) => entry.id === sessionId);
  const project = session?.project_id ? projects.find((entry) => entry.id === session.project_id) : null;
  const sessionEvents = useAgentStore((state) => state.events[sessionId] ?? EMPTY_SESSION_EVENTS);
  const rememberedWorkingPath = useAgentStore((state) => state.sessionWorkingPaths[sessionId] ?? null);
  const workingPath = useMemo(() => {
    if (!session) {
      return null;
    }
    return resolveSessionWorkingPath(session, projects, {
      events: sessionEvents,
      rememberedPath: rememberedWorkingPath,
    });
  }, [session, projects, sessionEvents, rememberedWorkingPath]);
  const isReadOnly = Boolean(session?.is_read_only);
  const reasoningEffort = normalizeReasoningEffort(session?.reasoning_effort);
  const agentKind = session?.agent_kind ?? 'claude_code';
  const projectSkillEntry = useProjectSkillStore((state) => (
    project?.path ? state.entries[projectSkillCacheKey(project.path, agentKind)] : undefined
  ));
  const projectSkills = projectSkillEntry?.skills ?? EMPTY_PROJECT_SKILLS;
  const isProviderAgent = agentKind === 'claude_code' || agentKind === 'codex' || agentKind === 'opencode';
  const modelProviders = config?.model_providers ?? [];
  const activeProviderId = config?.active_provider_id ?? null;
  const activeProvider = useMemo(
    () => getActiveModelProvider(modelProviders, activeProviderId),
    [activeProviderId, modelProviders],
  );
  const sessionProvider = useMemo(
    () => modelProviders.find((provider) => provider.id === session?.provider_id) ?? null,
    [modelProviders, session?.provider_id],
  );
  const runtimeProvider = sessionProvider ?? activeProvider;
  const model = stripContext1mSuffix(session?.model ?? '') || runtimeProvider?.default_model.trim() || getProviderPrimaryModel(runtimeProvider) || '';
  const configuredContextWindow = agentKind === 'codex' || agentKind === 'opencode'
    ? getProfileModelContextWindow(runtimeProvider, model)
    : null;
  const [selectorModelState, setSelectorModelState] = useState(() => stripContext1mSuffix(session?.model ?? '') || activeProvider?.default_model.trim() || getProviderPrimaryModel(activeProvider) || '');
  const prevSessionIdRef = useRef<string | null>(null);
  const userModifiedRef = useRef(false);
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      userModifiedRef.current = false;
      setSelectorModelState(stripContext1mSuffix(session?.model ?? '') || activeProvider?.default_model.trim() || getProviderPrimaryModel(activeProvider) || '');
    } else if (!userModifiedRef.current) {
      const next = stripContext1mSuffix(session?.model ?? '') || activeProvider?.default_model.trim() || getProviderPrimaryModel(activeProvider) || '';
      if (next) {
        setSelectorModelState(next);
      }
    }
  }, [sessionId, session?.model, activeProvider]);
  const modelSupports1m = useCallback((modelId: string) => {
    return checkProfileModelSupports1m(runtimeProvider, modelId);
  }, [runtimeProvider]);
  const formatSelectedProviderModel = useCallback((item: string) => formatModelDisplayName({
    model: item,
    agentKind,
    usesLargeContext: modelSupports1m(item),
  }), [agentKind, modelSupports1m]);
  const modelNameWithSuffix = useMemo(() => model ? formatSelectedProviderModel(model) : undefined, [model, formatSelectedProviderModel]);
  const hasUsableProvider = !isProviderAgent || Boolean(runtimeProvider && isProviderUsable(runtimeProvider, agentKind) && model);
  const rawPermissionConfig = useMemo(() => {
    if (!session?.permission_config) return null;
    try {
      return JSON.parse(session.permission_config) as unknown;
    } catch {
      return null;
    }
  }, [session?.permission_config]);
  const configuredPermissionConfig = agentKind === 'codex'
    ? config?.agent_configs.codex?.permission_config
    : config?.agent_configs.claude_code.permission_config;
  const permissionConfig = useMemo(
    () => serializePermissionConfig(agentKind, rawPermissionConfig ?? configuredPermissionConfig),
    [agentKind, configuredPermissionConfig, rawPermissionConfig],
  );
  const planMode: AgentPlanMode = session?.plan_mode === 'on' ? 'on' : 'off';

  const [infoOpen, setInfoOpen] = useState(false);
  const [infoTitle, setInfoTitle] = useState('');
  const [infoContent, setInfoContent] = useState('');
  const [cwd, setCwd] = useState(() => getStoredAgentCwd());
  const effectiveCwd = workingPath ?? cwd;
  const pendingWorkingPath = Boolean(session?.working_path?.trim() && !workingPath);
  const ensuredSessionsRef = useRef<Set<string>>(new Set());
  const [historyReady, setHistoryReady] = useState(false);
  const [pendingSwitchKind, setPendingSwitchKind] = useState<AgentKind | null>(null);
  const [isSwitchingAgent, setIsSwitchingAgent] = useState(false);
  const canSwitchAgent = !isRunning
    && pendingPermissions.length === 0
    && !isReadOnly
    && session?.origin !== 'imported'
    && (agentKind === 'claude_code' || agentKind === 'codex' || agentKind === 'opencode');

  useEffect(() => {
    setHistoryReady(false);
    void loadSessionMessages(sessionId).finally(() => {
      setHistoryReady(true);
    });
  }, [sessionId, loadSessionMessages]);

  useEffect(() => {
    if (workingPath) {
      setProjectPath(workingPath);
    } else if (project?.path) {
      setProjectPath(project.path);
    } else {
      setProjectPath(null);
      usePreviewStore.setState({ treeRoot: null, treeRootPath: null });
    }
  }, [workingPath, project?.path, setProjectPath]);

  useEffect(() => {
    if (workingPath) {
      setCwd(workingPath);
    } else if (project?.path) {
      setCwd(project.path);
    } else {
      setCwd(getStoredAgentCwd());
    }
  }, [sessionId, workingPath, project?.path]);

  useEffect(() => {
    void loadProjectSkills(project?.path, agentKind);
  }, [agentKind, loadProjectSkills, project?.path]);

  useEffect(() => {
    if (isRunning || isReadOnly || sessionsLoading || pendingWorkingPath || !historyReady) {
      return;
    }

    const ensureKey = JSON.stringify({
      sessionId,
      agentKind,
      cwd: effectiveCwd,
      reasoningEffort,
      permissionConfig: session?.permission_config || null,
      planMode,
      providerId: session?.provider_id ?? null,
      model: session?.model ?? null,
    });

    if (ensuredSessionsRef.current.has(ensureKey)) {
      return;
    }

    ensuredSessionsRef.current.add(ensureKey);
    agentApi.ensureSession(sessionId, effectiveCwd, undefined, reasoningEffort).catch(() => {
      ensuredSessionsRef.current.delete(ensureKey);
    });
  }, [
    sessionId,
    effectiveCwd,
    project?.path,
    reasoningEffort,
    session?.permission_config,
    session?.provider_id,
    session?.model,
    planMode,
    agentKind,
    isRunning,
    isReadOnly,
    sessionsLoading,
    pendingWorkingPath,
    historyReady,
  ]);

  const handleSend = async (input: AgentInputPayload, displayContent = input.text) => {
    if (!hasUsableProvider || isReadOnly) {
      return;
    }
    const latestSession = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId) ?? session;
    const latestReasoningEffort = normalizeReasoningEffort(latestSession?.reasoning_effort ?? reasoningEffort);
    const content = input.text;
    const runtimeContent = content;

    try {
      await startQuery(
        sessionId,
        runtimeContent,
        effectiveCwd,
        latestReasoningEffort,
        displayContent,
        { ...input, text: runtimeContent },
        latestSession?.model ?? model,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    }
  };

  const handleModelChange = useCallback(async (nextModel: string, providerId: string) => {
    const sameModel = nextModel === selectorModelState;
    const sameProvider = providerId === (runtimeProvider?.id ?? activeProviderId);
    if (sameModel && sameProvider) {
      return;
    }
    userModifiedRef.current = true;
    setSelectorModelState(nextModel);
    const nextProvider =
      modelProviders.find((provider) => provider.id === providerId) ?? runtimeProvider;
    const supports1m = checkProfileModelSupports1m(nextProvider, nextModel);
    const suffixedModel = agentKind === 'claude_code' && supports1m
      ? `${nextModel}[1m]`
      : nextModel;
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((entry) => (
        entry.id === sessionId
          ? { ...entry, model: suffixedModel, provider_id: providerId }
          : entry
      )),
    }));
    try {
      await sessionApi.updateProvider(sessionId, providerId, suffixedModel);
      // Re-ensure immediately so Codex resumes the same thread with the new
      // model before the next send, instead of waiting for startSession.
      if (!isRunning) {
        const effectiveCwd = workingPath ?? cwd;
        await agentApi.ensureSession(sessionId, effectiveCwd, undefined, reasoningEffort);
      }
    } catch (error) {
      console.warn('[AgentPanel] handleModelChange failed:', error);
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    }
  }, [
    activeProviderId,
    agentKind,
    cwd,
    workingPath,
    isProviderAgent,
    isReadOnly,
    isRunning,
    modelProviders,
    project?.path,
    reasoningEffort,
    runtimeProvider,
    selectorModelState,
    sessionId,
  ]);

  const handleConfirmAgentSwitch = useCallback(async () => {
    if (!pendingSwitchKind) {
      return;
    }
    const fallbackProvider = modelProviders.find((provider) => isProviderUsable(provider, pendingSwitchKind))
      ?? (activeProvider && isProviderUsable(activeProvider, pendingSwitchKind) ? activeProvider : null);
    if (!fallbackProvider) {
      toast.error('目标智能体没有可用的模型供应商，请先在设置中配置匹配协议端点。');
      return;
    }
    setIsSwitchingAgent(true);
    try {
      userModifiedRef.current = false;
      await switchSessionAgentKind(
        sessionId,
        pendingSwitchKind,
        fallbackProvider.id,
        fallbackProvider.default_model.trim() || getProviderPrimaryModel(fallbackProvider) || undefined,
        undefined,
      );
      setPendingSwitchKind(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSwitchingAgent(false);
    }
  }, [activeProvider, modelProviders, pendingSwitchKind, sessionId, switchSessionAgentKind]);

  const handleReasoningEffortChange = useCallback(async (nextEffort: ReasoningEffort) => {
    if (isReadOnly) return;
    const latestSession = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId);
    if (!latestSession || latestSession.reasoning_effort === nextEffort) {
      return;
    }

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((entry) =>
        entry.id === sessionId ? { ...entry, reasoning_effort: nextEffort } : entry,
      ),
    }));

    try {
      await sessionApi.updateReasoningEffort(sessionId, nextEffort);
    } catch (error) {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    }
  }, [isReadOnly, model, sessionId]);

  const handlePermissionConfigChange = useCallback((nextPermissionConfig: AgentPermissionConfig) => {
    if (isReadOnly) return;
    updateSessionPermissions(sessionId, nextPermissionConfig, planMode).catch((error) => {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    });
  }, [isReadOnly, planMode, sessionId, updateSessionPermissions]);

  const handlePlanModeChange = useCallback((nextPlanMode: AgentPlanMode) => {
    if (isReadOnly) return;
    updateSessionPermissions(sessionId, undefined, nextPlanMode).catch((error) => {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    });
  }, [isReadOnly, sessionId, updateSessionPermissions]);

  // Atomic mode change — updates both config and plan mode in a single DB write
  // to avoid race conditions from two separate async calls.
  const handleModeChange = useCallback((nextConfig: AgentPermissionConfig, nextPlanMode: AgentPlanMode) => {
    if (isReadOnly) return;
    updateSessionPermissions(sessionId, nextConfig, nextPlanMode).catch((error) => {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    });
  }, [isReadOnly, sessionId, updateSessionPermissions]);

  const handlePermissionResponse = useCallback(async (requestId: string, response: AgentPermissionResponse) => {
    const request = (useAgentStore.getState().pendingPermissions[sessionId] ?? [])
      .find((item) => item.request_id === requestId);
    const isExitPlanApproval = agentKind === 'claude_code' && request?.permission_type === 'ExitPlanMode';

    // ExitPlanMode 是原生权限审批，批准后需要同步切换会话下拉到完全访问。
    if (isExitPlanApproval && response !== 'reject') {
      await updateSessionPermissions(
        sessionId,
        mapExecutionModeToPermissionConfig('claude_code', 'full_access'),
        'off',
      );
    }

    await respondToPermission(sessionId, requestId, response);
  }, [agentKind, respondToPermission, sessionId, updateSessionPermissions]);

  const showInfoDialog = useCallback((title: string, content: string) => {
    setInfoTitle(title);
    setInfoContent(content);
    setInfoOpen(true);
  }, []);

  const handleCommand = useCallback(async (command: SlashCommand, args: string) => {
    if (command.handler === 'local' && command.action) {
      const context: CommandContext = {
        sessionId,
        cwd,
        showInfoDialog,
        createSession: async () => { await createSession('新对话', 'agent'); },
        clearEvents,
        resetSession: () => { agentApi.resetSession(sessionId); },
        deleteClaudeSessionFiles: () => agentApi.deleteClaudeSessionFiles(sessionId),
        getActiveProvider: () => getActiveProvider(),
        getTheme: () => config?.theme || 'System',
      };
      await command.action(context, args);
      return;
    }

    if (command.handler === 'prompt' && command.prompt) {
      const displayContent = formatCommandDisplay(command, args);
      const prompt = renderCommandInput(command, args, agentKind);
      await handleSend({ text: prompt }, displayContent);
    }
  }, [sessionId, cwd, showInfoDialog, createSession, clearEvents, getActiveProvider, config, agentKind, handleSend]);

  const pendingProfilerRenderRef = useRef<{
    id: string;
    commitCount: number;
    actualDuration: number;
    baseDuration: number;
  } | null>(null);
  const profilerFlushTimerRef = useRef<number | null>(null);
  const flushProfilerRender = useCallback(() => {
    profilerFlushTimerRef.current = null;
    const pending = pendingProfilerRenderRef.current;
    pendingProfilerRenderRef.current = null;
    if (!pending) return;

    usePerfStore.getState().recordRender(
      pending.id,
      pending.actualDuration,
      pending.baseDuration,
      pending.commitCount,
    );
  }, []);

  useEffect(() => () => {
    if (profilerFlushTimerRef.current !== null) {
      window.clearTimeout(profilerFlushTimerRef.current);
    }
    flushProfilerRender();
  }, [flushProfilerRender]);

  const handleProfilerRender = useCallback(
    (id: string, _phase: 'mount' | 'update' | 'nested-update', actualDuration: number, baseDuration: number) => {
      if (!import.meta.env.DEV) return;

      const pending = pendingProfilerRenderRef.current ?? {
        id,
        commitCount: 0,
        actualDuration: 0,
        baseDuration: 0,
      };
      pending.commitCount += 1;
      pending.actualDuration += actualDuration;
      pending.baseDuration += baseDuration;
      pendingProfilerRenderRef.current = pending;

      if (profilerFlushTimerRef.current === null) {
        profilerFlushTimerRef.current = window.setTimeout(flushProfilerRender, 250);
      }
    },
    [flushProfilerRender],
  );

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      <CodeMuxAssistantRuntimeProvider
        sessionId={sessionId}
        agentKind={agentKind}
        projectSkills={projectSkills}
        onSend={handleSend}
        onCommand={handleCommand}
        sendDisabled={!hasUsableProvider || isReadOnly}
      >
        <Profiler id="AgentThread" onRender={handleProfilerRender}>
          <CodeMuxThread
            sessionId={sessionId}
            footer={(
              <div className="flex w-full flex-col gap-3">
                <CodeMuxComposer
                  sessionId={sessionId}
                  agentKind={agentKind}
                  projectPath={project?.path}
                  projectSkills={projectSkills}
                  modelName={modelNameWithSuffix}
                  configuredContextWindow={configuredContextWindow}
                  disabled={!hasUsableProvider || isReadOnly}
                  modelSelector={(
                    <>
                      <AgentSelector
                        value={agentKind}
                        disabled={!canSwitchAgent || isSwitchingAgent}
                        onChange={(nextKind) => {
                          if (nextKind === agentKind || !canSwitchAgent) {
                            return;
                          }
                          setPendingSwitchKind(nextKind);
                        }}
                      />
                      <AgentModelSelector
                      agentKind={agentKind}
                      providers={modelProviders}
                      activeProviderId={runtimeProvider?.id ?? activeProviderId}
                      value={selectorModelState}
                      contextModel={sessionProvider ? model : undefined}
                      onChange={handleModelChange}
                      reasoningEffort={reasoningEffort}
                      onReasoningEffortChange={handleReasoningEffortChange}
                      disabled={isRunning || isReadOnly}
                      compact={compact}
                    />
                    </>
                  )}
                  permissionSelector={(
                    <AgentPermissionSelector
                      agentKind={agentKind}
                      permissionConfig={permissionConfig}
                      planMode={planMode}
                      onPermissionConfigChange={handlePermissionConfigChange}
                      onPlanModeChange={handlePlanModeChange}
                      onModeChange={handleModeChange}
                      disabled={isReadOnly}
                      compact={compact}
                    />
                  )}
                  pendingPermissions={pendingPermissions}
                  onPermissionResponse={handlePermissionResponse}
                  onStop={() => interrupt(sessionId)}
                  planMode={planMode}
                  onTogglePlanMode={isReadOnly ? undefined : () => {
                    // Issue 07: independent Plan toggle in the composer control
                    // area. Codex Plan Mode is orthogonal to the Workflow tier
                    // (ADR 0010) — only flip the toggle, never the tier config.
                    if (planMode === 'on') {
                      handlePlanModeChange('off');
                      return;
                    }
                    if (agentKind === 'codex') {
                      handlePlanModeChange('on');
                      return;
                    }
                    handleModeChange(mapExecutionModeToPermissionConfig(agentKind, 'plan'), 'on');
                  }}
                  onActivatePlanMode={() => {
                    if (agentKind === 'codex') {
                      handlePlanModeChange('on');
                      return;
                    }
                    handleModeChange(mapExecutionModeToPermissionConfig(agentKind, 'plan'), 'on');
                  }}
                />
              </div>
            )}
          />
        </Profiler>
      </CodeMuxAssistantRuntimeProvider>

      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="sm:max-w-120">
          <DialogHeader>
            <DialogTitle>{infoTitle}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto text-sm leading-relaxed [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[hsl(var(--primary)/0.3)] [&_blockquote]:py-1 [&_blockquote]:pl-3 [&_blockquote]:text-xs [&_blockquote]:text-muted-foreground [&_code]:rounded-md [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-code [&_hr]:my-3 [&_li]:my-0.5 [&_p]:my-1.5 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4">
            <MarkdownRenderer content={infoContent} />
          </div>
          <DialogFooter>
            <Button onClick={() => setInfoOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingSwitchKind !== null} onOpenChange={(open) => { if (!open && !isSwitchingAgent) setPendingSwitchKind(null); }}>
        <DialogContent overlayClassName="z-[240]" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>切换到 {pendingSwitchKind ? getAgentDefinition(pendingSwitchKind)?.label ?? pendingSwitchKind : ''}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            对话仍是这一条，但会新建原生会话并用摘要交接。不能重放工具或权限；此次切换按新会话计费。未发送的排队消息会保持暂停。
          </p>
          <DialogFooter>
            <Button variant="ghost" disabled={isSwitchingAgent} onClick={() => setPendingSwitchKind(null)}>取消</Button>
            <Button disabled={isSwitchingAgent} onClick={() => void handleConfirmAgentSwitch()}>
              {isSwitchingAgent ? '切换中…' : '确认切换'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
