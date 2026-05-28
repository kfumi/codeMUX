import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../types/chat';
import { MessageItem } from './MessageItem';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  isStreaming?: boolean;
  streamingContent?: string;
  onFileClick?: (path: string) => void;
}

export function MessageList({ messages, isLoading, isStreaming, streamingContent, onFileClick }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {messages.length === 0 && !isLoading && !isStreaming && (
        <div className="text-center text-muted-foreground py-8">
          <p>发送消息开始对话</p>
        </div>
      )}
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} onFileClick={onFileClick} />
      ))}
      {isStreaming && streamingContent && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-lg px-4 py-2 bg-muted">
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownRenderer content={streamingContent} onFileClick={onFileClick} />
            </div>
            <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5" />
          </div>
        </div>
      )}
      {isLoading && !isStreaming && (
        <div className="flex justify-center">
          <div className="animate-pulse text-muted-foreground">思考中...</div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
