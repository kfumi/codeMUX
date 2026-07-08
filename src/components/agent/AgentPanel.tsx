import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getStoredAgentCwd } from '../../lib/sessionCwd';
import { resolveAgentProviderConfig } from '../../lib/agentProvider';
import { getProviderModelList } from '../../lib/providerModels';
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
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { CodeMuxComposer } from './assistant-ui/CodeMuxComposer';
import { CodeMuxAssistantRuntimeProvider } from './assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxModelSelector } from './assistant-ui/CodeMuxModelSelector';
import { CodeMuxThread } from './assistant-ui/CodeMuxThread';
import { AgentPermissionSelector } from './AgentPermissionSelector';
import { formatModelDisplayName } from './modelDisplay';
import { MarkdownRenderer } from './MarkdownRenderer';

interface AgentPanelProps {
  sessionId: string;
}

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const { sessions, createSession, updateSessionPermissions } = useSessionStore();
  const { projects } = useProjectStore();
  const { startQuery, interrupt, loadSessionMessages, clearEvents } = useAgentStore();
  const { config, getActiveProvider, setProxyRunning } = useSettingsStore();
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
  const { provider: resolvedProvider, apiKey, baseUrl, model, runtimeModel, codexNeedsProxy } = resolveAgentProviderConfig({
    agentKind: session?.agent_kind ?? 'claude_code',
    config,
    sessionProviderId: session?.provider_id,
    sessionModel: session?.model,
  });
  const providerModels = useMemo(() => getProviderModelList(resolvedProvider), [resolvedProvider]);
  const availableProviders = config?.providers ?? [];
  const reasoningEffort = session?.reasoning_effort ?? 'medium';
  const agentKind = session?.agent_kind ?? 'claude_code';
  const formatSelectedProviderModel = useCallback((item: string) => formatModelDisplayName({
    model: item,
    agentKind,
    usesLargeContext: resolvedProvider?.context_1m,
  }), [agentKind, resolvedProvider?.context_1m]);
  const modelNameWithSuffix = useMemo(() => model ? formatSelectedProviderModel(model) : undefined, [model, formatSelectedProviderModel]);
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
      providerId: resolvedProvider?.id || null,
      model: runtimeModel || null,
      reasoningEffort,
      hasApiKey: Boolean(apiKey),
      baseUrl: baseUrl || null,
      codexNeedsProxy: codexNeedsProxy ?? null,
      permissionConfig: session?.permission_config || null,
      planMode,
    });

    if (ensuredSessionsRef.current.has(ensureKey)) {
      return;
    }

    ensuredSessionsRef.current.add(ensureKey);
    agentApi.ensureSession(sessionId, effectiveCwd, undefined, apiKey, baseUrl, runtimeModel, reasoningEffort, codexNeedsProxy).then(async () => {
      if (baseUrl && codexNeedsProxy) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 600));
          const port = await agentApi.getProxyPort().catch(() => null);
          setProxyRunning(true, port && port > 0 ? `http://127.0.0.1:${port}` : null);
        } catch {
          // Ignore invalid base URLs and let the runtime surface the real error.
        }
      }
    }).catch(() => {
      ensuredSessionsRef.current.delete(ensureKey);
    });
  }, [sessionId, cwd, project?.path, resolvedProvider?.id, apiKey, baseUrl, runtimeModel, reasoningEffort, codexNeedsProxy, session?.permission_config, planMode, setProxyRunning, isRunning]);

  const handleSend = async (input: AgentInputPayload, displayContent = input.text) => {
    const effectiveCwd = project?.path || cwd;
    const latestSession = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId) ?? session;
    const latestReasoningEffort = latestSession?.reasoning_effort ?? reasoningEffort;
    const latestAgentKind = latestSession?.agent_kind ?? session?.agent_kind ?? 'claude_code';
    const content = input.text;
    const latestProviderConfig = resolveAgentProviderConfig({
      agentKind: latestAgentKind,
      config,
      sessionProviderId: latestSession?.provider_id ?? session?.provider_id,
      sessionModel: latestSession?.model ?? session?.model ?? model,
    });
    const runtimeContent = content;

    if (latestSession && latestProviderConfig.provider?.id && latestProviderConfig.model) {
      sessionApi.updateProvider(sessionId, latestProviderConfig.provider.id, latestProviderConfig.model, latestReasoningEffort).catch(() => {});
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((entry) =>
          entry.id === sessionId
            ? {
                ...entry,
                provider_id: latestProviderConfig.provider!.id,
                model: latestProviderConfig.model!,
                reasoning_effort: latestReasoningEffort,
              }
            : entry,
        ),
      }));
    }

    try {
      await startQuery(
        sessionId,
        runtimeContent,
        effectiveCwd,
        latestProviderConfig.apiKey,
        latestProviderConfig.baseUrl,
        latestProviderConfig.runtimeModel,
        latestReasoningEffort,
        latestProviderConfig.codexNeedsProxy,
        displayContent,
        { ...input, text: runtimeContent },
      );
    } catch (error) {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    }
  };

  const handleModelChange = useCallback(async (nextModel: string) => {
    if (!session || !resolvedProvider?.id || !nextModel || nextModel === session.model) {
      return;
    }

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((entry) =>
        entry.id === sessionId ? { ...entry, provider_id: resolvedProvider.id, model: nextModel, reasoning_effort: reasoningEffort } : entry,
      ),
    }));

    try {
      await sessionApi.updateProvider(sessionId, resolvedProvider.id, nextModel, reasoningEffort);
    } catch (error) {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    }
  }, [model, reasoningEffort, resolvedProvider?.id, session, sessionId]);

  const handleProviderChange = useCallback(async (nextProviderId: string, nextModel: string) => {
    if (!session || !nextProviderId || !nextModel || (nextProviderId === resolvedProvider?.id && nextModel === model)) {
      return;
    }

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((entry) =>
        entry.id === sessionId ? { ...entry, provider_id: nextProviderId, model: nextModel, reasoning_effort: reasoningEffort } : entry,
      ),
    }));

    try {
      await sessionApi.updateProvider(sessionId, nextProviderId, nextModel, reasoningEffort);
    } catch (error) {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    }
  }, [model, reasoningEffort, resolvedProvider?.id, session, sessionId]);

  const handleReasoningEffortChange = useCallback(async (nextEffort: ReasoningEffort) => {
    const latestSession = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId);
    if (!latestSession || latestSession.reasoning_effort === nextEffort) {
      return;
    }

    const latestConfig = resolveAgentProviderConfig({
      agentKind: latestSession.agent_kind ?? 'claude_code',
      config,
      sessionProviderId: latestSession.provider_id,
      sessionModel: latestSession.model,
    });
    const nextModel = latestConfig.model || latestSession.model || '';

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((entry) =>
        entry.id === sessionId ? { ...entry, reasoning_effort: nextEffort } : entry,
      ),
    }));

    if (!latestConfig.provider?.id || !nextModel) {
      return;
    }

    try {
      await sessionApi.updateProvider(sessionId, latestConfig.provider.id, nextModel, nextEffort);
    } catch (error) {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    }
  }, [config, sessionId]);

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

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      <CodeMuxAssistantRuntimeProvider sessionId={sessionId} agentKind={agentKind} onSend={handleSend} onCommand={handleCommand}>
        <CodeMuxThread
          sessionId={sessionId}
          footer={(
            <div className="flex w-full flex-col gap-3">
              <CodeMuxComposer
                sessionId={sessionId}
                agentKind={agentKind}
                projectPath={project?.path}
                modelName={modelNameWithSuffix}
                modelSelector={(
                  <CodeMuxModelSelector
                    value={model || ''}
                    models={providerModels}
                    onChange={handleModelChange}
                    providers={availableProviders}
                    providerId={resolvedProvider?.id ?? null}
                    onProviderChange={handleProviderChange}
                    reasoningEffort={reasoningEffort}
                    onReasoningEffortChange={handleReasoningEffortChange}
                    getDisplayName={formatSelectedProviderModel}
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
                    compact={compact}
                  />
                )}
                onStop={() => interrupt(sessionId)}
                onActivatePlanMode={() => handleModeChange(mapExecutionModeToPermissionConfig(agentKind, 'plan'), 'on')}
              />
            </div>
          )}
        />
      </CodeMuxAssistantRuntimeProvider>

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
