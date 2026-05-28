import { useState } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { AgentMessageList } from './AgentMessageList';
import { AgentStatusBar } from './AgentStatusBar';
import { ChatInput } from '../chat/ChatInput';
import { Input } from '../ui/input';
import { FolderOpen } from 'lucide-react';

interface AgentPanelProps {
  sessionId: string;
}

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const { sessions } = useSessionStore();
  const { startQuery, isRunning } = useAgentStore();
  const [cwd, setCwd] = useState(() => {
    // Try to get a sensible default from the app
    return localStorage.getItem('agent-cwd') || '.';
  });

  const session = sessions.find((s) => s.id === sessionId);
  const running = isRunning[sessionId] || false;

  const handleCwdChange = (value: string) => {
    setCwd(value);
    localStorage.setItem('agent-cwd', value);
  };

  const handleSend = async (content: string) => {
    await startQuery(sessionId, content, cwd);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-3 space-y-2">
        <h2 className="font-semibold">{session?.title || 'Agent 任务'}</h2>
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
          <Input
            value={cwd}
            onChange={(e) => handleCwdChange(e.target.value)}
            placeholder="工作目录路径 (如 D:\project\my-app)"
            className="h-7 text-xs"
          />
        </div>
      </div>
      <AgentMessageList sessionId={sessionId} />
      <AgentStatusBar sessionId={sessionId} />
      <ChatInput onSend={handleSend} isLoading={running} />
    </div>
  );
}
