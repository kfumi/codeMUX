import { useEffect, useState } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { AgentMessageList } from './AgentMessageList';
import { AgentStatusBar } from './AgentStatusBar';
import { ChatInput } from '../chat/ChatInput';

interface AgentPanelProps {
  sessionId: string;
}

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const { sessions } = useSessionStore();
  const { startQuery, isRunning } = useAgentStore();
  const [cwd, setCwd] = useState('');

  const session = sessions.find((s) => s.id === sessionId);
  const running = isRunning[sessionId] || false;

  useEffect(() => {
    if (!cwd) {
      setCwd('.'); // Default to current directory
    }
  }, [cwd]);

  const handleSend = async (content: string) => {
    await startQuery(sessionId, content, cwd);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-3 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">{session?.title || 'Agent 任务'}</h2>
          <div className="text-xs text-muted-foreground">
            工作目录: {cwd}
          </div>
        </div>
      </div>
      <AgentMessageList sessionId={sessionId} />
      <AgentStatusBar sessionId={sessionId} />
      <ChatInput onSend={handleSend} isLoading={running} />
    </div>
  );
}
