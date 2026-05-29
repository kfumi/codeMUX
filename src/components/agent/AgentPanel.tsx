import { useState, useEffect } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { AgentMessageList } from './AgentMessageList';
import { ChatInput } from '../chat/ChatInput';
import { FolderOpen } from 'lucide-react';

interface AgentPanelProps {
  sessionId: string;
}

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const { sessions } = useSessionStore();
  const { projects } = useProjectStore();
  const { startQuery, isRunning, interrupt, loadSessionMessages } = useAgentStore();

  const session = sessions.find((s) => s.id === sessionId);
  const project = session?.project_id ? projects.find((p) => p.id === session.project_id) : null;

  const [cwd, setCwd] = useState(() => {
    return localStorage.getItem('agent-cwd') || '.';
  });

  const [model, setModel] = useState(() => {
    return localStorage.getItem('agent-model') || 'default';
  });

  useEffect(() => {
    loadSessionMessages(sessionId);
  }, [sessionId, loadSessionMessages]);

  useEffect(() => {
    if (project?.path) {
      setCwd(project.path);
      localStorage.setItem('agent-cwd', project.path);
    }
  }, [project?.path]);

  const running = isRunning[sessionId] || false;

  const handleModelChange = (value: string) => {
    setModel(value);
    localStorage.setItem('agent-model', value);
  };

  const handleSend = async (content: string) => {
    const apiKey = localStorage.getItem('agent-anthropic-api-key') || undefined;
    await startQuery(sessionId, content, cwd, apiKey);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border/40 bg-background/80 backdrop-blur-sm shrink-0">
        <h2 className="text-[13px] font-medium text-foreground/80 truncate">
          {session?.title || '新对话'}
        </h2>
        <div className="flex-1" />
        {project && (
          <div className="flex items-center gap-1.5 text-[12px] text-foreground bg-muted/40 rounded-lg px-2.5 py-1.5 border border-border/30"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <FolderOpen className="h-3 w-3 text-foreground/70 shrink-0" />
            <span className="truncate max-w-[200px]">{project.path}</span>
          </div>
        )}
      </div>

      {/* Message area */}
      <AgentMessageList sessionId={sessionId} />

      {/* Input composer */}
      <ChatInput
        onSend={handleSend}
        onStop={interrupt}
        isLoading={running}
        model={model}
        onModelChange={handleModelChange}
      />
    </div>
  );
}
