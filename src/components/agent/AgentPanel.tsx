import { useState, useEffect, useMemo } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePreviewStore } from '../../stores/previewStore';
import { cn } from '../../lib/utils';
import { AgentMessageList } from './AgentMessageList';
import { AgentInput } from './AgentInput';
import { ContextProgress } from './ContextProgress';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { FolderOpen, MoreHorizontal, Pencil, PanelRightOpen, PanelRightClose } from 'lucide-react';

interface AgentPanelProps {
  sessionId: string;
}

const EMPTY_EVENTS: import('../../stores/agentStore').AgentMessage[] = [];

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const { sessions, updateSessionTitle } = useSessionStore();
  const { projects } = useProjectStore();
  const { startQuery, isRunning, interrupt, loadSessionMessages } = useAgentStore();
  const { config } = useSettingsStore();
  const { isOpen: previewOpen, togglePanel: togglePreview, loadFileTree, setProjectPath } = usePreviewStore();

  const session = sessions.find((s) => s.id === sessionId);
  const project = session?.project_id ? projects.find((p) => p.id === session.project_id) : null;
  const activeProvider = config?.providers.find((p) => p.id === config.active_provider_id) ?? null;

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

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
        if (usage?.input_tokens) {
          usedTokens = usage.input_tokens
            + (usage.cache_creation_input_tokens || 0)
            + (usage.cache_read_input_tokens || 0);
        }
      }
      if (usedTokens === 0 && evt.kind === 'result') {
        const data: any = evt.data;
        if (data?.usage?.input_tokens) {
          usedTokens = data.usage.input_tokens
            + (data.usage.cache_creation_input_tokens || 0)
            + (data.usage.cache_read_input_tokens || 0);
        }
      }
      if (usedTokens > 0) break;
    }

    // Provider configured context_window takes priority over SDK's modelUsage
    const totalTokens = activeProvider?.context_window || 200_000;

    return { usedTokens, totalTokens };
  }, [events, activeProvider]);

  const running = isRunning[sessionId] || false;

  const handleSend = async (content: string) => {
    const apiKey = activeProvider?.api_key || undefined;
    const baseUrl = activeProvider?.anthropic_base_url || undefined;
    const model = activeProvider?.default_model || undefined;
    await startQuery(sessionId, content, cwd, apiKey, baseUrl, model);
  };

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

      {/* Input composer */}
      <AgentInput
        onSend={handleSend}
        onStop={interrupt}
        isLoading={running}
        modelName={activeProvider?.default_model}
      />

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
    </div>
  );
}
