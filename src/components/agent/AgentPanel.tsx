import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePreviewStore } from '../../stores/previewStore';
import { cn } from '../../lib/utils';
import { AgentMessageList } from './AgentMessageList';
import { AgentInput } from './AgentInput';
import { ContextProgress } from './ContextProgress';
import { TodoList } from './TodoList';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { MarkdownRenderer } from './MarkdownRenderer';
import { FolderOpen, MoreHorizontal, Pencil, PanelRightOpen, PanelRightClose } from 'lucide-react';
import type { SlashCommand, CommandContext } from '../../lib/slashCommands';
import { agentApi, sessionApi } from '../../lib/tauri';

interface AgentPanelProps {
  sessionId: string;
}

const EMPTY_EVENTS: import('../../stores/agentStore').AgentMessage[] = [];
const EMPTY_TODOS: import('../../types/agent').TodoItem[] = [];

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const { sessions, updateSessionTitle, createSession } = useSessionStore();
  const { projects } = useProjectStore();
  const { startQuery, isRunning, interrupt, loadSessionMessages, clearEvents, clearSavedEvents } = useAgentStore();
  const { config, getActiveProvider } = useSettingsStore();
  const { isOpen: previewOpen, togglePanel: togglePreview, loadFileTree, setProjectPath } = usePreviewStore();

  const todos = useAgentStore((s) => s.todos[sessionId] ?? EMPTY_TODOS);

  const session = sessions.find((s) => s.id === sessionId);
  const project = session?.project_id ? projects.find((p) => p.id === session.project_id) : null;
  const activeProvider = config?.providers.find((p) => p.id === config.active_provider_id) ?? null;

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoTitle, setInfoTitle] = useState('');
  const [infoContent, setInfoContent] = useState('');

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

  // Reset cwd when switching sessions
  useEffect(() => {
    if (project?.path) {
      // Project session: use project path
      setCwd(project.path);
    } else {
      // Non-project session: restore user's last manually-set cwd
      setCwd(localStorage.getItem('agent-user-cwd') || '.');
    }
  }, [sessionId, project?.path]);

  const events = useAgentStore((s) => s.events[sessionId] ?? EMPTY_EVENTS);

  // Compute context usage from events
  const contextUsage = useMemo(() => {
    let usedTokens = 0;

    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      if (usedTokens === 0 && evt.kind === 'assistant') {
        const data: any = evt.data;
        const usage = data?.message?.usage || data?.usage;
        if (usage) {
          const input = usage.input_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const cacheCreation = usage.cache_creation_input_tokens || 0;
          const total = input + cacheRead + cacheCreation;
          if (total > 0) usedTokens = total;
        }
      }
      if (usedTokens === 0 && evt.kind === 'result') {
        const data: any = evt.data;
        if (data?.usage) {
          const usage = data.usage;
          const input = usage.input_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const cacheCreation = usage.cache_creation_input_tokens || 0;
          const total = input + cacheRead + cacheCreation;
          if (total > 0) usedTokens = total;
        }
      }
      if (usedTokens > 0) break;
    }

    // 1M context if provider has context_1m enabled, otherwise 200k
    const totalTokens = activeProvider?.context_1m ? 1_000_000 : 200_000;

    return { usedTokens, totalTokens };
  }, [events, activeProvider]);

  const running = isRunning[sessionId] || false;

  const handleSend = async (content: string) => {
    // Determine which provider to use:
    // - Existing session with stored provider_id → use that provider (model consistency)
    // - New session or old session without provider_id → use active provider, then save it
    let provider = activeProvider;
    if (session?.provider_id) {
      const storedProvider = config?.providers.find((p) => p.id === session.provider_id);
      if (storedProvider) provider = storedProvider;
    }

    const apiKey = provider?.api_key || undefined;
    const baseUrl = provider?.anthropic_base_url || undefined;
    let model = provider?.default_model || undefined;
    if (model && provider?.context_1m && !model.includes('[1m]')) {
      model = model + '[1m]';
    }

    // Save provider_id and model to session on first message (for future consistency)
    if (session && !session.provider_id && provider?.id && model) {
      sessionApi.updateProvider(sessionId, provider.id, model).catch(() => {});
      // Update local session state
      useSessionStore.setState((s) => ({
        sessions: s.sessions.map(sess =>
          sess.id === sessionId ? { ...sess, provider_id: provider!.id, model } : sess
        ),
      }));
    }

    try {
      await startQuery(sessionId, content, cwd, apiKey, baseUrl, model);
    } catch (err) {
      useAgentStore.setState((s) => ({
        error: { ...s.error, [sessionId]: String(err) },
      }));
    }
  };

  // 弹窗展示信息
  const showInfoDialog = useCallback((title: string, content: string) => {
    setInfoTitle(title);
    setInfoContent(content);
    setInfoOpen(true);
  }, []);

  // 从 events 中提取费用信息
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

  // 斜杠命令处理
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
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border/40 bg-background/80 backdrop-blur-sm shrink-0">
        <h2 className="text-[13px] font-medium text-foreground/80 truncate">
          {session?.title || '新对话'}
        </h2>
        <DropdownMenu
          trigger={
            <button className="p-1 rounded-md hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          }
        >
          <DropdownMenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={handleRenameOpen}>
            重命名
          </DropdownMenuItem>
        </DropdownMenu>
        <div className="flex-1" />
        {contextUsage.usedTokens > 0 && (
          <ContextProgress usedTokens={contextUsage.usedTokens} totalTokens={contextUsage.totalTokens} />
        )}
        {project && (
          <div className="flex items-center gap-1.5 text-[12px] text-foreground bg-muted/40 rounded-lg px-2.5 py-1.5 border border-border/30 min-w-0 max-w-[300px]"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <FolderOpen className="h-3 w-3 text-foreground/70 shrink-0" />
            <span className="truncate">{project.path}</span>
          </div>
        )}
        <button
          onClick={togglePreview}
          className={cn(
            'p-1.5 rounded-md transition-colors shrink-0',
            previewOpen
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground'
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

      {/* Message area */}
      <AgentMessageList sessionId={sessionId} />

      {/* Todo list + Input composer */}
      <div className="relative">
        {todos.length > 0 && (
          <div className="px-5 pb-1">
            <div className="max-w-3xl mx-auto">
              <TodoList todos={todos} />
            </div>
          </div>
        )}
        <AgentInput
          onSend={handleSend}
          onCommand={handleCommand}
          onStop={() => interrupt(sessionId)}
          isLoading={running}
          modelName={session?.model || activeProvider?.default_model}
        />
      </div>

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

      {/* Info dialog (斜杠命令结果) */}
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{infoTitle}</DialogTitle>
          </DialogHeader>
          <div className="text-sm leading-relaxed max-h-[60vh] overflow-y-auto [&_p]:my-1.5 [&_strong]:text-foreground [&_strong]:font-semibold [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded-md [&_code]:bg-muted [&_code]:text-[13px] [&_code]:font-mono [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:py-1 [&_blockquote]:my-2 [&_blockquote]:text-muted-foreground [&_blockquote]:text-xs [&_ul]:my-1 [&_ul]:pl-4 [&_ul]:list-disc [&_li]:my-0.5 [&_hr]:my-3 [&_hr]:border-border">
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
