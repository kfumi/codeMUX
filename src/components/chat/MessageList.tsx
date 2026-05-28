import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../types/chat';
import { MessageItem } from './MessageItem';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
}

export function MessageList({ messages, isLoading }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {messages.length === 0 && !isLoading && (
        <div className="text-center text-muted-foreground py-8">
          <p>发送消息开始对话</p>
        </div>
      )}
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
      {isLoading && (
        <div className="flex justify-center">
          <div className="animate-pulse text-muted-foreground">思考中...</div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
