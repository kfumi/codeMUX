import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getStoredAgentCwd } from '../../lib/sessionCwd';
import { resolveAgentProviderConfig } from '../../lib/agentProvider';
import { getProviderModelList } from '../../lib/providerModels';
import type { CommandContext, SlashCommand } from '../../lib/slashCommands';
import { findCommand, formatCommandDisplay, renderCommandPrompt } from '../../lib/slashCommands';
import type { ReasoningEffort } from '../../types/session';
import { agentApi, sessionApi } from '../../lib/tauri';
import { useAgentStore } from '../../stores/agentStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { ChangedFilesList } from './ChangedFilesList';
import { CodeMuxComposer } from './assistant-ui/CodeMuxComposer';
import { CodeMuxAssistantRuntimeProvider } from './assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxModelSelector } from './assistant-ui/CodeMuxModelSelector';
import { CodeMuxThread } from './assistant-ui/CodeMuxThread';
import { formatModelDisplayName } from './modelDisplay';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TodoList } from './TodoList';

interface AgentPanelProps {
  sessionId: string;
}

const EMPTY_EVENTS: import('../../stores/agentStore').AgentMessage[] = [];
const EMPTY_TODOS: import('../../types/agent').TodoItem[] = [];

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const { sessions, createSession } = useSessionStore();
  const { projects } = useProjectStore();
  const { startQuery, interrupt, loadSessionMessages, clearEvents } = useAgentStore();
  const { config, getActiveProvider, setProxyRunning } = useSettingsStore();
  const { loadFileTree, setProjectPath } = usePreviewStore();

  const todos = useAgentStore((state) => state.todos[sessionId] ?? EMPTY_TODOS);
  const events = useAgentStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);
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
  const reasoningEffort = session?.reasoning_effort ?? 'medium';
  const agentKind = session?.agent_kind ?? 'claude_code';
  const formatSelectedProviderModel = useCallback((item: string) => formatModelDisplayName({
    model: item,
    agentKind,
    usesLargeContext: resolvedProvider?.context_1m,
  }), [agentKind, resolvedProvider?.context_1m]);
  const modelNameWithSuffix = useMemo(() => model ? formatSelectedProviderModel(model) : undefined, [model, formatSelectedProviderModel]);

  const [infoOpen, setInfoOpen] = useState(false);
  const [infoTitle, setInfoTitle] = useState('');
  const [infoContent, setInfoContent] = useState('');
  const [cwd, setCwd] = useState(() => getStoredAgentCwd());
  const [codexPlanMode, setCodexPlanMode] = useState(false);
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
    setCodexPlanMode(false);
  }, [sessionId, agentKind]);

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
  }, [sessionId, cwd, project?.path, resolvedProvider?.id, apiKey, baseUrl, runtimeModel, reasoningEffort, codexNeedsProxy, setProxyRunning, isRunning]);

  const handleSend = async (content: string, displayContent = content, options?: { skipCommandMode?: boolean }) => {
    const effectiveCwd = project?.path || cwd;
    const latestSession = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId) ?? session;
    const latestReasoningEffort = latestSession?.reasoning_effort ?? reasoningEffort;
    const latestAgentKind = latestSession?.agent_kind ?? session?.agent_kind ?? 'claude_code';
    const latestProviderConfig = resolveAgentProviderConfig({
      agentKind: latestAgentKind,
      config,
      sessionProviderId: latestSession?.provider_id ?? session?.provider_id,
      sessionModel: latestSession?.model ?? session?.model ?? model,
    });
    const runtimeContent = !options?.skipCommandMode && latestAgentKind === 'codex' && codexPlanMode
      ? renderCommandPrompt(findCommand('plan', 'codex')!, content)
      : content;

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

  const showInfoDialog = useCallback((title: string, content: string) => {
    setInfoTitle(title);
    setInfoContent(content);
    setInfoOpen(true);
  }, []);

  const getCostInfo = useCallback((): string => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.kind === 'result' && event.data) {
        const data = event.data as any;
        const usage = data.usage;
        const duration = data.duration_ms;
        const turns = data.num_turns;
        const lines: string[] = [];

        if (turns) lines.push(`**对话轮次**　${turns}`);
        if (duration) lines.push(`**耗时**　${(duration / 1000).toFixed(1)}s`);
        if (usage) {
          const input = usage.input_tokens || 0;
          const output = usage.output_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const cacheCreation = usage.cache_creation_input_tokens || 0;
          lines.push(`**输入 tokens**　${input.toLocaleString()}`);
          lines.push(`**输出 tokens**　${output.toLocaleString()}`);
          if (cacheRead) lines.push(`**缓存命中**　${cacheRead.toLocaleString()}`);
          if (cacheCreation) lines.push(`**缓存创建**　${cacheCreation.toLocaleString()}`);
          lines.push(`**总计**　${(input + output).toLocaleString()} tokens`);
        }
        if (data.total_cost) lines.push(`**费用**　$${data.total_cost.toFixed(4)}`);

        return lines.join('\n\n');
      }
    }

    return '暂无费用信息（当前会话还没有完成过对话）';
  }, [events]);

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
        getCostInfo,
      };
      await command.action(context, args);
      return;
    }

    if (command.handler === 'prompt' && command.prompt) {
      const displayContent = formatCommandDisplay(command, args);
      if (agentKind === 'codex' && command.name === 'plan') {
        setCodexPlanMode(true);
        if (!args) {
          return;
        }
      }

      const prompt = renderCommandPrompt(command, args);
      await handleSend(prompt, displayContent, { skipCommandMode: true });
    }
  }, [sessionId, cwd, showInfoDialog, createSession, clearEvents, getActiveProvider, config, getCostInfo, agentKind, handleSend]);

  return (
    <div className="flex h-full flex-col">
      <CodeMuxAssistantRuntimeProvider sessionId={sessionId} agentKind={agentKind} onSend={handleSend} onCommand={handleCommand}>
        <CodeMuxThread
          sessionId={sessionId}
          provider={resolvedProvider}
          footer={(
            <div className="flex w-full flex-col gap-3">
              <div className="flex items-end justify-between gap-3">
                {todos.length > 0 && <TodoList todos={todos} />}
                <div className="flex-1" />
                {project && <ChangedFilesList sessionId={sessionId} projectPath={project.path} />}
              </div>
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
                    reasoningEffort={reasoningEffort}
                    onReasoningEffortChange={handleReasoningEffortChange}
                    getDisplayName={formatSelectedProviderModel}
                    disabled={isRunning}
                  />
                )}
                onStop={() => interrupt(sessionId)}
                activeCommandMode={agentKind === 'codex' && codexPlanMode ? { id: 'plan', label: '计划' } : null}
                onClearCommandMode={() => setCodexPlanMode(false)}
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
