import { useEffect } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';

interface ChatPanelProps {
  sessionId: string;
}

export function ChatPanel({ sessionId }: ChatPanelProps) {
  const { messages, isLoading, fetchMessages, sendMessage } = useChatStore();
  const { sessions } = useSessionStore();

  const session = sessions.find((s) => s.id === sessionId);
  const sessionMessages = messages[sessionId] || [];

  useEffect(() => {
    fetchMessages(sessionId);
  }, [sessionId, fetchMessages]);

  const handleSend = async (content: string) => {
    await sendMessage(sessionId, content);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-3">
        <h2 className="font-semibold">{session?.title || '对话'}</h2>
      </div>
      <MessageList messages={sessionMessages} isLoading={isLoading} />
      <ChatInput onSend={handleSend} isLoading={isLoading} />
    </div>
  );
}
