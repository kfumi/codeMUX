import { FolderOpen, MoreHorizontal, PanelRightClose, PanelRightOpen, Pencil } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getStoredAgentCwd } from '../../lib/sessionCwd';
import { resolveAgentProviderConfig } from '../../lib/agentProvider';
import { cn } from '../../lib/utils';
import type { CommandContext, SlashCommand } from '../../lib/slashCommands';
import { agentApi, sessionApi } from '../../lib/tauri';
import { useAgentStore } from '../../stores/agentStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { ContextDisplay } from '../assistant-ui/context-display';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { ChangedFilesList } from './ChangedFilesList';
import { CodeMuxComposer } from './assistant-ui/CodeMuxComposer';
import { CodeMuxAssistantRuntimeProvider } from './assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxThread } from './assistant-ui/CodeMuxThread';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TodoList } from './TodoList';
import { supportsCapability } from './agentCapabilities';

interface AgentPanelProps {
  sessionId: string;
}

const EMPTY_EVENTS: import('../../stores/agentStore').AgentMessage[] = [];
const EMPTY_TODOS: import('../../types/agent').TodoItem[] = [];
const DEFAULT_CONTEXT_TOKENS = 200_000;
const LARGE_CONTEXT_TOKENS = 1_000_000;
const LARGE_CONTEXT_MODEL_SUFFIX = '[1m]';

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const { sessions, updateSessionTitle, createSession } = useSessionStore();
  const { projects } = useProjectStore();
  const { startQuery, interrupt, loadSessionMessages, clearEvents } = useAgentStore();
  const { config, getActiveProvider, setProxyRunning } = useSettingsStore();
  const { isOpen: previewOpen, togglePanel: togglePreview, loadFileTree, setProjectPath } = usePreviewStore();

  const todos = useAgentStore((state) => state.todos[sessionId] ?? EMPTY_TODOS);
  const mcpRuntimeStatus = useAgentStore((state) => state.mcpRuntimeStatus[sessionId] ?? null);
  const events = useAgentStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);

  const session = sessions.find((entry) => entry.id === sessionId);
  const project = session?.project_id ? projects.find((entry) => entry.id === session.project_id) : null;
  const { provider: resolvedProvider, apiKey, baseUrl, model } = resolveAgentProviderConfig({
    agentKind: session?.agent_kind ?? 'claude_code',
    config,
    sessionProviderId: session?.provider_id,
  });

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoTitle, setInfoTitle] = useState('');
  const [infoContent, setInfoContent] = useState('');
  const [cwd, setCwd] = useState(() => getStoredAgentCwd());
  const ensuredSessionsRef = useRef<Set<string>>(new Set());

  const handleRenameOpen = () => {
    setRenameValue(session?.title || '');
    setRenameOpen(true);
  };

  const handleRenameSave = async () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== session?.title) {
      await updateSessionTitle(sessionId, trimmed);
    }
    setRenameOpen(false);
  };

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
    const effectiveCwd = project?.path || cwd;
    const ensureKey = JSON.stringify({
      sessionId,
      cwd: effectiveCwd,
      providerId: resolvedProvider?.id || null,
      model: model || null,
      hasApiKey: Boolean(apiKey),
      baseUrl: baseUrl || null,
    });

    if (ensuredSessionsRef.current.has(ensureKey)) {
      return;
    }

    ensuredSessionsRef.current.add(ensureKey);
    agentApi.ensureSession(sessionId, effectiveCwd, undefined, apiKey, baseUrl, model).then(async () => {
      if (baseUrl) {
        try {
          if (new URL(baseUrl).host.toLowerCase() !== 'api.openai.com') {
            await new Promise((resolve) => setTimeout(resolve, 600));
            const port = await agentApi.getProxyPort().catch(() => null);
            setProxyRunning(true, port && port > 0 ? `http://127.0.0.1:${port}` : null);
          }
        } catch {
          // Ignore invalid base URLs and let the runtime surface the real error.
        }
      }
    }).catch(() => {
      ensuredSessionsRef.current.delete(ensureKey);
    });
  }, [sessionId, cwd, project?.path, resolvedProvider?.id, apiKey, baseUrl, model, setProxyRunning]);

  const contextUsage = useMemo(() => {
    let usedTokens = 0;
    let inputTokens = 0;
    let cachedTokens = 0;
    let outputTokens = 0;
    let modelContextWindow: number | undefined;

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (usedTokens === 0 && event.kind === 'assistant') {
        const data: any = event.data;
        const usage = data?.last_token_usage || data?.message?.usage || data?.usage;
        if (usage) {
          const input = usage.input_tokens || 0;
          const cacheRead = usage.cached_input_tokens || usage.cache_read_input_tokens || 0;
          const output = usage.output_tokens || 0;
          const total = input + output;
          if (total > 0) {
            inputTokens = input;
            cachedTokens = cacheRead;
            outputTokens = output;
            usedTokens = total;
          }
        }
        if (!modelContextWindow && data?.model_context_window) {
          modelContextWindow = data.model_context_window;
        }
      }

      if (usedTokens === 0 && event.kind === 'result') {
        const data: any = event.data;
        const usage = data?.last_token_usage || data?.usage;
        if (usage) {
          const input = usage.input_tokens || 0;
          const cacheRead = usage.cached_input_tokens || usage.cache_read_input_tokens || 0;
          const output = usage.output_tokens || 0;
          const total = input + output;
          if (total > 0) {
            inputTokens = input;
            cachedTokens = cacheRead;
            outputTokens = output;
            usedTokens = total;
          }
        }
        if (!modelContextWindow && data?.model_context_window) {
          modelContextWindow = data.model_context_window;
        }
      }

      if (usedTokens > 0 && modelContextWindow) {
        break;
      }
    }

    const totalTokens = getSessionContextLimit({
      model: session?.model,
      sessionProviderUsesLargeContext: !!resolvedProvider?.context_1m,
      activeProviderUsesLargeContext: !!resolvedProvider?.context_1m,
      modelContextWindow,
    });

    return { usedTokens, totalTokens, inputTokens, cachedTokens, outputTokens };
  }, [events, session?.model, resolvedProvider?.context_1m]);

  const handleSend = async (content: string) => {
    const effectiveCwd = project?.path || cwd;

    if (session && !session.provider_id && resolvedProvider?.id && model) {
      sessionApi.updateProvider(sessionId, resolvedProvider.id, model).catch(() => {});
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((entry) =>
          entry.id === sessionId ? { ...entry, provider_id: resolvedProvider.id, model } : entry,
        ),
      }));
    }

    try {
      await startQuery(sessionId, content, effectiveCwd, apiKey, baseUrl, model);
    } catch (error) {
      useAgentStore.setState((state) => ({
        error: { ...state.error, [sessionId]: String(error) },
      }));
    }
  };

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
          lines.push(`**总计**　${(input + output + cacheRead + cacheCreation).toLocaleString()} tokens`);
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
      const prompt = command.prompt.replace(/\{args\}/g, args || '');
      await handleSend(prompt);
    }
  }, [sessionId, cwd, showInfoDialog, createSession, clearEvents, getActiveProvider, config, getCostInfo]);

  return (
    <div className="flex h-full flex-col">
      <div className="surface-panel surface-panel-muted animate-in fade-in zoom-in-95 slide-in-from-bottom-2 fill-mode-both animation-duration-[340ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] flex shrink-0 items-center gap-3 rounded-none border-x-0 border-t-0 border-b border-border/45 bg-[hsl(var(--background))]/82 px-6 py-3.5 backdrop-blur-xl dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.92,hsl(var(--surface-1))/0.84)]">
        <h2 className="truncate text-[13px] font-semibold text-foreground/88">{session?.title || '新对话'}</h2>
        <DropdownMenu
          trigger={(
            <button className="rounded-lg p-1 text-muted-foreground/66 transition-colors hover:bg-muted/55 hover:text-foreground">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          )}
        >
          <DropdownMenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={handleRenameOpen}>
            重命名
          </DropdownMenuItem>
        </DropdownMenu>
        <div className="flex-1" />
        {contextUsage.usedTokens > 0 && supportsCapability(session?.agent_kind ?? 'claude_code', 'supports_cost') && (
          <ContextDisplay
            usedTokens={contextUsage.usedTokens}
            totalTokens={contextUsage.totalTokens}
            modelName={session?.model || resolvedProvider?.default_model}
            inputTokens={contextUsage.inputTokens}
            cachedTokens={contextUsage.cachedTokens}
            outputTokens={contextUsage.outputTokens}
          />
        )}
        {project && (
          <div
            className="surface-panel flex min-w-0 max-w-75 items-center gap-1.5 rounded-lg border border-border/45 bg-muted/24 px-2.5 py-1.5 text-[12px] text-foreground/78 dark:bg-[linear-gradient(180deg,hsl(var(--surface-3))/0.84,hsl(var(--surface-2))/0.74)]"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <FolderOpen className="h-3 w-3 shrink-0 text-foreground/62" />
            <span className="truncate">{project.path}</span>
          </div>
        )}
        {mcpRuntimeStatus && mcpRuntimeStatus !== 'ready' && (
          <div className="surface-panel rounded-lg border border-border/45 bg-muted/24 px-2 py-1 text-[11px] text-muted-foreground dark:bg-[linear-gradient(180deg,hsl(var(--surface-3))/0.8,hsl(var(--surface-2))/0.7)]">
            {mcpRuntimeStatus === 'warming' && 'MCP 正在后台预热'}
            {mcpRuntimeStatus === 'deferred' && 'MCP 将按需连接'}
            {mcpRuntimeStatus === 'fallback_live' && '对话已启动，MCP 继续后台接入'}
            {mcpRuntimeStatus === 'limited_provider' && '当前 Provider 的 MCP 工具发现能力受限'}
          </div>
        )}
        <button
          onClick={togglePreview}
          className={cn(
            'rounded-lg p-1.5 transition-all duration-200',
            previewOpen ? 'bg-muted/70 text-foreground' : 'text-muted-foreground/66 hover:bg-muted/45 hover:text-foreground',
          )}
          title={previewOpen ? '收起预览面板' : '展开预览面板'}
        >
          {previewOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </button>
      </div>

      <CodeMuxAssistantRuntimeProvider sessionId={sessionId} onSend={handleSend} onCommand={handleCommand}>
        <CodeMuxThread
          sessionId={sessionId}
          provider={resolvedProvider}
          footer={(
            <div className="flex w-full flex-col gap-3">
              <div className="flex items-end justify-between gap-3">
                {todos.length > 0 && <TodoList todos={todos} />}
                <div className="flex-1" />
                <ChangedFilesList sessionId={sessionId} projectPath={project?.path} />
              </div>
              <CodeMuxComposer
                sessionId={sessionId}
                modelName={session?.model || resolvedProvider?.default_model}
                onStop={() => interrupt(sessionId)}
              />
            </div>
          )}
        />
      </CodeMuxAssistantRuntimeProvider>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-100">
          <DialogHeader>
            <DialogTitle>重命名对话</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void handleRenameSave(); }}
            placeholder="输入对话名称"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>取消</Button>
            <Button onClick={() => void handleRenameSave()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

function getSessionContextLimit({
  model,
  sessionProviderUsesLargeContext,
  activeProviderUsesLargeContext,
  modelContextWindow,
}: {
  model?: string | null;
  sessionProviderUsesLargeContext: boolean;
  activeProviderUsesLargeContext: boolean;
  modelContextWindow?: number;
}) {
  // Codex: use the real context window from the API if available
  if (modelContextWindow && modelContextWindow > 0) {
    return modelContextWindow;
  }

  if (typeof model === 'string' && model.trim().length > 0) {
    return model.includes(LARGE_CONTEXT_MODEL_SUFFIX) ? LARGE_CONTEXT_TOKENS : DEFAULT_CONTEXT_TOKENS;
  }

  if (sessionProviderUsesLargeContext) {
    return LARGE_CONTEXT_TOKENS;
  }

  return activeProviderUsesLargeContext ? LARGE_CONTEXT_TOKENS : DEFAULT_CONTEXT_TOKENS;
}
