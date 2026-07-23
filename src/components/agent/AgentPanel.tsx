import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getStoredAgentCwd } from '../../lib/sessionCwd';
import { getProfilePrimaryModel, profileToSelectorProvider } from '../../lib/agentProfileSelector';
import type { CommandContext, SlashCommand } from '../../lib/slashCommands';
import { formatCommandDisplay, renderCommandPrompt } from '../../lib/slashCommands';
import { mapExecutionModeToPermissionConfig, serializePermissionConfig, type AgentPermissionConfig, type AgentPlanMode } from '../../lib/agentPermissions';
import type { ReasoningEffort } from '../../types/session';
import type { AgentInputPayload } from '../../types/agentInput';
import { agentApi, sessionApi } from '../../lib/tauri';
import { useAgentStore } from '../../stores/agentStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
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
import { checkProfileModelSupports1m, formatModelDisplayName } from './modelDisplay';
import { MarkdownRenderer } from './MarkdownRenderer';

interface AgentPanelProps {
  sessionId: string;
}

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const { sessions, createSession, updateSessionPermissions, updateSessionModel } = useSessionStore();
  const { projects } = useProjectStore();
  const { startQuery, interrupt, loadSessionMessages, clearEvents, respondToPermission } = useAgentStore();
  const pendingPermission = useAgentStore((state) => state.pendingPermissions[sessionId] ?? null);
  const { config, getActiveProvider, setActiveAgentProfileModel } = useSettingsStore();
  const { loadFileTree, setProjectPath } = usePreviewStore();

  // 检测容器宽度，窄屏时启用紧凑模式
  const containerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCompact(entry.contentRect.width < 560);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);

  const session = sessions.find((entry) => entry.id === sessionId);
  const project = session?.project_id ? projects.find((entry) => entry.id === session.project_id) : null;
  const reasoningEffort = session?.reasoning_effort ?? 'medium';
  const agentKind = session?.agent_kind ?? 'claude_code';
  const isProfileAgent = agentKind === 'claude_code' || agentKind === 'codex' || agentKind === 'opencode';
  const profileRegistry = config?.agent_profile_registry;
  const availableProfiles = useMemo(
    () => isProfileAgent ? (profileRegistry?.profiles ?? []).filter((profile) => profile.agent_kind === agentKind) : [],
    [agentKind, isProfileAgent, profileRegistry?.profiles],
  );
  const activeProfileId = isProfileAgent ? profileRegistry?.active_profile_ids?.[agentKind] ?? null : null;
  const activeProfile = useMemo(
    () => availableProfiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, availableProfiles],
  );
  const sessionProfile = useMemo(
    () => availableProfiles.find((profile) => profile.id === session?.provider_id) ?? null,
    [availableProfiles, session?.provider_id],
  );
  const runtimeProfile = sessionProfile ?? activeProfile;
  const runtimeProvider = useMemo(() => runtimeProfile ? profileToSelectorProvider(runtimeProfile) : null, [runtimeProfile]);
  const stripSuffix = (s: string) => s.replace(/\[1m\]/gi, '').trim();
  const model = stripSuffix(session?.model ?? '') || runtimeProfile?.default_model.trim() || getProfilePrimaryModel(runtimeProfile) || activeProfile?.models[0]?.id.trim() || '';
  const [selectorModelState, setSelectorModelState] = useState(() => stripSuffix(session?.model ?? '') || activeProfile?.default_model.trim() || getProfilePrimaryModel(activeProfile) || '');
  const prevSessionIdRef = useRef<string | null>(null);
  const userModifiedRef = useRef(false);
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      userModifiedRef.current = false;
      setSelectorModelState(stripSuffix(session?.model ?? '') || activeProfile?.default_model.trim() || getProfilePrimaryModel(activeProfile) || '');
    } else if (!userModifiedRef.current) {
      const next = stripSuffix(session?.model ?? '') || activeProfile?.default_model.trim() || getProfilePrimaryModel(activeProfile) || '';
      if (next) {
        setSelectorModelState(next);
      }
    }
  }, [sessionId, session?.model, activeProfile]);
  const modelSupports1m = useCallback((modelId: string) => {
    return checkProfileModelSupports1m(runtimeProfile, modelId);
  }, [runtimeProfile]);
  const formatSelectedProviderModel = useCallback((item: string) => formatModelDisplayName({
    model: item,
    agentKind,
    usesLargeContext: runtimeProvider?.context_1m || modelSupports1m(item),
  }), [agentKind, runtimeProvider?.context_1m, modelSupports1m]);
  const modelNameWithSuffix = useMemo(() => model ? formatSelectedProviderModel(model) : undefined, [model, formatSelectedProviderModel]);
  const usesClaudeDefault = agentKind === 'claude_code' && !runtimeProfile && !activeProfileId;
  const usesOpenCodeFree = agentKind === 'opencode' && !runtimeProfile && !activeProfileId;
  const hasUsableProfile = usesClaudeDefault || usesOpenCodeFree || !isProfileAgent || Boolean(runtimeProfile && model);
  const rawPermissionConfig = useMemo(() => {
    if (!session?.permission_config) return null;
    try {
      return JSON.parse(session.permission_config) as unknown;
    } catch {
      return null;
    }
  }, [session?.permission_config]);
  const configuredPermissionConfig = agentKind === 'codex'
    ? config?.agent_configs.codex.permission_config
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
  const ensuredSessionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    loadSessionMessages(sessionId);
  }, [sessionId, loadSessionMessages]);

  useEffect(() => {
    if (project?.path) {
      setProjectPath(project.path);
      loadFileTree(project.path);
    } else {
      setProjectPath(null);
      usePreviewStore.setState({ treeRoot: null, treeRootPath: null });
    }
  }, [project?.path, setProjectPath, loadFileTree]);

  useEffect(() => {
    if (project?.path) {
      setCwd(project.path);
    } else {
      setCwd(getStoredAgentCwd());
    }
  }, [sessionId, project?.path]);

  useEffect(() => {
    if (isRunning) {
      return;
    }

    const effectiveCwd = project?.path || cwd;
    const ensureKey = JSON.stringify({
      sessionId,
      cwd: effectiveCwd,
      reasoningEffort,
      permissionConfig: session?.permission_config || null,
      planMode,
    });

    if (ensuredSessionsRef.current.has(ensureKey)) {
      return;
    }

    ensuredSessionsRef.current.add(ensureKey);
    agentApi.ensureSession(sessionId, effectiveCwd, undefined, reasoningEffort).catch(() => {
      ensuredSessionsRef.current.delete(ensureKey);
    });
  }, [sessionId, cwd, project?.path, reasoningEffort, session?.permission_config, planMode, isRunning]);

  const handleSend = async (input: AgentInputPayload, displayContent = input.text) => {
    if (!hasUsableProfile) {
      return;
    }
    const effectiveCwd = project?.path || cwd;
    const latestSession = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId) ?? session;
    const latestReasoningEffort = latestSession?.reasoning_effort ?? reasoningEffort;
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
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    }
  };

  const handleModelChange = useCallback(async (nextModel: string) => {
    if (!isProfileAgent || !nextModel || nextModel === selectorModelState) {
      return;
    }
    userModifiedRef.current = true;
    setSelectorModelState(nextModel);
    const suffixedModel = (runtimeProvider?.context_1m || modelSupports1m(nextModel))
      ? `${nextModel}[1m]`
      : nextModel;
    updateSessionModel(sessionId, suffixedModel);
    try {
      const isProfileModel = Boolean(activeProfile?.models.some((m) => m.id.trim() === nextModel));
      if (isProfileModel) {
        await setActiveAgentProfileModel(agentKind, nextModel);
      }
      await sessionApi.updateProvider(sessionId, isProfileModel ? (activeProfile?.id ?? null) : null, suffixedModel);
    } catch (error) {
      console.warn('[AgentPanel] handleModelChange failed:', error);
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    }
  }, [activeProfile, agentKind, isProfileAgent, modelSupports1m, sessionId, selectorModelState, runtimeProvider?.context_1m, setActiveAgentProfileModel, updateSessionModel]);

  const handleReasoningEffortChange = useCallback(async (nextEffort: ReasoningEffort) => {
    const latestSession = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId);
    if (!latestSession || latestSession.reasoning_effort === nextEffort) {
      return;
    }

    const nextModel = latestSession.model || model || '';

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((entry) =>
        entry.id === sessionId ? { ...entry, reasoning_effort: nextEffort } : entry,
      ),
    }));

    if (!latestSession.provider_id || !nextModel) {
      return;
    }

    try {
      await sessionApi.updateProvider(sessionId, latestSession.provider_id, nextModel, nextEffort);
    } catch (error) {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    }
  }, [model, sessionId]);

  const handlePermissionConfigChange = useCallback((nextPermissionConfig: AgentPermissionConfig) => {
    updateSessionPermissions(sessionId, nextPermissionConfig, planMode).catch((error) => {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    });
  }, [planMode, sessionId, updateSessionPermissions]);

  const handlePlanModeChange = useCallback((nextPlanMode: AgentPlanMode) => {
    updateSessionPermissions(sessionId, undefined, nextPlanMode).catch((error) => {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    });
  }, [sessionId, updateSessionPermissions]);

  // Atomic mode change — updates both config and plan mode in a single DB write
  // to avoid race conditions from two separate async calls.
  const handleModeChange = useCallback((nextConfig: AgentPermissionConfig, nextPlanMode: AgentPlanMode) => {
    updateSessionPermissions(sessionId, nextConfig, nextPlanMode).catch((error) => {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    });
  }, [sessionId, updateSessionPermissions]);

  // Migrate legacy Codex configs (e.g. workspace-write) to the current default.
  const handleLegacyConfigMigrate = useCallback((migratedConfig: AgentPermissionConfig) => {
    updateSessionPermissions(sessionId, migratedConfig).catch((error) => {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    });
  }, [sessionId, updateSessionPermissions]);

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
      const prompt = renderCommandPrompt(command, args);
      await handleSend({ text: prompt }, displayContent);
    }
  }, [sessionId, cwd, showInfoDialog, createSession, clearEvents, getActiveProvider, config, agentKind, handleSend]);

  const handleProfilerRender = useCallback(
    (_id: string, _phase: 'mount' | 'update' | 'nested-update', actualDuration: number, baseDuration: number) => {
      if (import.meta.env.DEV) {
        usePerfStore.getState().recordRender('MessageList', actualDuration, baseDuration);
      }
    },
    [],
  );

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      <Profiler id="MessageList" onRender={handleProfilerRender}>
      <CodeMuxAssistantRuntimeProvider sessionId={sessionId} agentKind={agentKind} onSend={handleSend} onCommand={handleCommand} sendDisabled={!hasUsableProfile}>
        <CodeMuxThread
          sessionId={sessionId}
          footer={(
            <div className="flex w-full flex-col gap-3">
              <CodeMuxComposer
                sessionId={sessionId}
                agentKind={agentKind}
                projectPath={project?.path}
                modelName={modelNameWithSuffix}
                disabled={!hasUsableProfile}
                modelSelector={(
                  <AgentModelSelector
                    agentKind={agentKind}
                    activeProfile={activeProfile}
                    activeProfileId={activeProfileId}
                    value={selectorModelState}
                    contextModel={sessionProfile ? model : undefined}
                    onChange={handleModelChange}
                    reasoningEffort={reasoningEffort}
                    onReasoningEffortChange={handleReasoningEffortChange}
                    disabled={isRunning}
                    compact={compact}
                  />
                )}
                permissionSelector={(
                  <AgentPermissionSelector
                    agentKind={agentKind}
                    permissionConfig={permissionConfig}
                    planMode={planMode}
                    onPermissionConfigChange={handlePermissionConfigChange}
                    onPlanModeChange={handlePlanModeChange}
                    onModeChange={handleModeChange}
                    onLegacyConfigMigrate={handleLegacyConfigMigrate}
                    pendingPermission={pendingPermission}
                    onPermissionResponse={(response) => { void respondToPermission(sessionId, response); }}
                    compact={compact}
                  />
                )}
                onStop={() => interrupt(sessionId)}
                onActivatePlanMode={agentKind === 'opencode' ? undefined : () => handleModeChange(mapExecutionModeToPermissionConfig(agentKind, 'plan'), 'on')}
              />
            </div>
          )}
        />
      </CodeMuxAssistantRuntimeProvider>
      </Profiler>

      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="sm:max-w-120">
          <DialogHeader>
            <DialogTitle>{infoTitle}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto text-sm leading-relaxed [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[hsl(var(--primary)/0.3)] [&_blockquote]:py-1 [&_blockquote]:pl-3 [&_blockquote]:text-xs [&_blockquote]:text-muted-foreground [&_code]:rounded-md [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_hr]:my-3 [&_li]:my-0.5 [&_p]:my-1.5 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4">
            <MarkdownRenderer content={infoContent} />
          </div>
          <DialogFooter>
            <Button onClick={() => setInfoOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
