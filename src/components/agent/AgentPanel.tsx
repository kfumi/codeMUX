import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePreviewStore } from '../../stores/previewStore';
import { cn } from '../../lib/utils';
import { CodeMuxAssistantRuntimeProvider } from './assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxThread } from './assistant-ui/CodeMuxThread';
import { CodeMuxComposer } from './assistant-ui/CodeMuxComposer';
import { ContextDisplay } from '../assistant-ui/context-display';
import { TodoList } from './TodoList';
import { ChangedFilesList } from './ChangedFilesList';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { resolveAgentProviderConfig } from '../../lib/agentProvider';
import { MarkdownRenderer } from './MarkdownRenderer';
import { AgentStatusBar } from './AgentStatusBar';
import { FolderOpen, MoreHorizontal, Pencil, PanelRightOpen, PanelRightClose } from 'lucide-react';
import type { SlashCommand, CommandContext } from '../../lib/slashCommands';
import { agentApi, sessionApi } from '../../lib/tauri';
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
  const { startQuery, interrupt, loadSessionMessages, clearEvents, clearSavedEvents } = useAgentStore();
  const { config, getActiveProvider, setProxyRunning } = useSettingsStore();
  const { isOpen: previewOpen, togglePanel: togglePreview, loadFileTree, setProjectPath } = usePreviewStore();

  const todos = useAgentStore((s) => s.todos[sessionId] ?? EMPTY_TODOS);
  const mcpRuntimeStatus = useAgentStore((s) => s.mcpRuntimeStatus[sessionId] ?? null);

  const session = sessions.find((s) => s.id === sessionId);
  const project = session?.project_id ? projects.find((p) => p.id === session.project_id) : null;
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
  const lastEnsureKeyRef = useRef<string | null>(null);

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

  const [cwd, setCwd] = useState(() => {
    return localStorage.getItem('agent-user-cwd') || '.';
  });

  useEffect(() => {
    loadSessionMessages(sessionId);
  }, [sessionId, loadSessionMessages]);

  useEffect(() => {
    if (project?.path) {
      setProjectPath(project.path);
      loadFileTree(project.path);
    }
  }, [project?.path, setProjectPath, loadFileTree]);

  useEffect(() => {
    if (project?.path) {
      setCwd(project.path);
    } else {
      setCwd(localStorage.getItem('agent-user-cwd') || '.');
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

    if (lastEnsureKeyRef.current === ensureKey) {
      return;
    }

    lastEnsureKeyRef.current = ensureKey;
    agentApi.ensureSession(sessionId, effectiveCwd, undefined, apiKey, baseUrl, model).then(async () => {
      // If provider needs a compat proxy, mark it as running and fetch the port
      if (baseUrl) {
        try {
          if (new URL(baseUrl).host.toLowerCase() !== 'api.openai.com') {
            // Wait a bit for the proxy to start, then read the port
            await new Promise((r) => setTimeout(r, 600));
            const port = await agentApi.getProxyPort().catch(() => null);
            setProxyRunning(true, port && port > 0 ? `http://127.0.0.1:${port}` : null);
          }
        } catch { /* invalid URL */ }
      }
    }).catch(() => {
      if (lastEnsureKeyRef.current === ensureKey) {
        lastEnsureKeyRef.current = null;
      }
    });
  }, [sessionId, cwd, project?.path, resolvedProvider?.id, apiKey, baseUrl, model]);

  const events = useAgentStore((s) => s.events[sessionId] ?? EMPTY_EVENTS);

  const contextUsage = useMemo(() => {
    let usedTokens = 0;
    let inputTokens = 0;
    let cachedTokens = 0;
    let outputTokens = 0;

    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      if (usedTokens === 0 && evt.kind === 'assistant') {
        const data: any = evt.data;
        const usage = data?.message?.usage || data?.usage;
        if (usage) {
          const input = usage.input_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const cacheCreation = usage.cache_creation_input_tokens || 0;
          const output = usage.output_tokens || 0;
          const total = input + cacheRead + cacheCreation;
          if (total > 0 || output > 0) {
            inputTokens = input;
            cachedTokens = cacheRead + cacheCreation;
            outputTokens = output;
            usedTokens = total;
          }
        }
      }
      if (usedTokens === 0 && evt.kind === 'result') {
        const data: any = evt.data;
        if (data?.usage) {
          const usage = data.usage;
          const input = usage.input_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const cacheCreation = usage.cache_creation_input_tokens || 0;
          const output = usage.output_tokens || 0;
          const total = input + cacheRead + cacheCreation;
          if (total > 0 || output > 0) {
            inputTokens = input;
            cachedTokens = cacheRead + cacheCreation;
            outputTokens = output;
            usedTokens = total;
          }
        }
      }
      if (usedTokens > 0) break;
    }

    const totalTokens = getSessionContextLimit({
      model: session?.model,
      sessionProviderUsesLargeContext: !!resolvedProvider?.context_1m,
      activeProviderUsesLargeContext: !!resolvedProvider?.context_1m,
    });

    return { usedTokens, totalTokens, inputTokens, cachedTokens, outputTokens };
  }, [events, session?.model, resolvedProvider?.context_1m]);

  const handleSend = async (content: string) => {
    const effectiveCwd = project?.path || cwd;

    if (session && !session.provider_id && resolvedProvider?.id && model) {
      sessionApi.updateProvider(sessionId, resolvedProvider.id, model).catch(() => {});
      useSessionStore.setState((s) => ({
        sessions: s.sessions.map(sess =>
          sess.id === sessionId ? { ...sess, provider_id: resolvedProvider.id, model } : sess
        ),
      }));
    }

    try {
      await startQuery(sessionId, content, effectiveCwd, apiKey, baseUrl, model);
    } catch (err) {
      useAgentStore.setState((s) => ({
        error: { ...s.error, [sessionId]: String(err) },
      }));
    }
  };

  const showInfoDialog = useCallback((title: string, content: string) => {
    setInfoTitle(title);
    setInfoContent(content);
    setInfoOpen(true);
  }, []);

  const getCostInfo = useCallback((): string => {
    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      if (evt.kind === 'result' && evt.data) {
        const data = evt.data as any;
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
          const total = input + output + cacheRead + cacheCreation;
          lines.push(`**总计**　${total.toLocaleString()} tokens`);
        }
        if (data.total_cost) lines.push(`**费用**　$${data.total_cost.toFixed(4)}`);
        return lines.join('\n\n');
      }
    }
    return '暂无费用信息（当前会话还没有完成过对话）';
  }, [events]);

  const handleCommand = useCallback(async (command: SlashCommand, args: string) => {
    if (command.handler === 'local' && command.action) {
      const ctx: CommandContext = {
        sessionId,
        cwd,
        showInfoDialog,
        createSession: async () => { await createSession('新对话', 'agent'); },
        clearEvents,
        resetSession: () => { agentApi.resetSession(sessionId); },
        deleteClaudeSessionFiles: () => agentApi.deleteClaudeSessionFiles(sessionId),
        clearSavedEvents: (sid: string) => clearSavedEvents(sid),
        getActiveProvider: () => getActiveProvider(),
        getTheme: () => config?.theme || 'System',
        getCostInfo,
      };
      await command.action(ctx, args);
    } else if (command.handler === 'prompt' && command.prompt) {
      const prompt = command.prompt.replace(/\{args\}/g, args || '');
      await handleSend(prompt);
    }
  }, [sessionId, cwd, showInfoDialog, createSession, clearEvents, clearSavedEvents, getActiveProvider, config, getCostInfo, handleSend]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border/30 bg-background/80 backdrop-blur-sm shrink-0">
        <h2 className="text-[13px] font-medium text-foreground/86 truncate">
          {session?.title || '新对话'}
        </h2>
        <DropdownMenu
          trigger={
            <button className="p-1 rounded-lg hover:bg-muted/40 text-muted-foreground/72 hover:text-foreground transition-colors">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          }
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
          <div className="flex items-center gap-1.5 text-[12px] text-foreground/78 bg-muted/30 rounded-lg px-2.5 py-1.5 border border-border/20 min-w-0 max-w-[300px]"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <FolderOpen className="h-3 w-3 text-foreground/62 shrink-0" />
            <span className="truncate">{project.path}</span>
          </div>
        )}
        {mcpRuntimeStatus && mcpRuntimeStatus !== 'ready' && (
          <div className="text-[11px] text-muted-foreground bg-muted/30 rounded-lg px-2 py-1 border border-border/20">
            {mcpRuntimeStatus === 'warming' && 'MCP 正在后台预热'}
            {mcpRuntimeStatus === 'deferred' && 'MCP 将按需连接'}
            {mcpRuntimeStatus === 'fallback_live' && '对话已启动，MCP 继续后台接入'}
            {mcpRuntimeStatus === 'limited_provider' && '当前 Provider 的 MCP 工具发现能力受限'}
          </div>
        )}
        <button
          onClick={togglePreview}
          className={cn(
            'p-1.5 rounded-lg transition-all duration-200',
            previewOpen
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground/72 hover:text-foreground hover:bg-muted/30'
          )}
          title={previewOpen ? '收起预览面板' : '展开预览面板'}
        >
          {previewOpen ? (
            <PanelRightClose className="h-4 w-4" />
          ) : (
            <PanelRightOpen className="h-4 w-4" />
          )}
        </button>
      </div>

      <CodeMuxAssistantRuntimeProvider
        sessionId={sessionId}
        onSend={handleSend}
        onCommand={handleCommand}
      >
        <CodeMuxThread
          sessionId={sessionId}
          provider={resolvedProvider}
          footer={
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
          }
        />
      </CodeMuxAssistantRuntimeProvider>
      <AgentStatusBar sessionId={sessionId} />

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>重命名对话</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSave(); }}
            placeholder="输入对话名称"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>取消</Button>
            <Button onClick={handleRenameSave}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Info dialog */}
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{infoTitle}</DialogTitle>
          </DialogHeader>
          <div className="text-sm leading-relaxed max-h-[60vh] overflow-y-auto [&_p]:my-1.5 [&_strong]:text-foreground [&_strong]:font-semibold [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded-md [&_code]:bg-muted [&_code]:text-[13px] [&_code]:font-mono [&_blockquote]:border-l-2 [&_blockquote]:border-[hsl(var(--primary)/0.3)] [&_blockquote]:pl-3 [&_blockquote]:py-1 [&_blockquote]:my-2 [&_blockquote]:text-muted-foreground [&_blockquote]:text-xs [&_ul]:my-1 [&_ul]:pl-4 [&_ul]:list-disc [&_li]:my-0.5 [&_hr]:my-3">
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
}: {
  model?: string | null;
  sessionProviderUsesLargeContext: boolean;
  activeProviderUsesLargeContext: boolean;
}) {
  if (typeof model === 'string' && model.trim().length > 0) {
    return model.includes(LARGE_CONTEXT_MODEL_SUFFIX) ? LARGE_CONTEXT_TOKENS : DEFAULT_CONTEXT_TOKENS;
  }

  if (sessionProviderUsesLargeContext) {
    return LARGE_CONTEXT_TOKENS;
  }

  return activeProviderUsesLargeContext ? LARGE_CONTEXT_TOKENS : DEFAULT_CONTEXT_TOKENS;
}
