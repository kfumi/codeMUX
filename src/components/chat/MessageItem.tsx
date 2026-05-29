import type { ChatMessage } from '../../types/chat';
import { cn } from '../../lib/utils';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageItemProps {
  message: ChatMessage;
  isStreaming?: boolean;
  onFileClick?: (path: string) => void;
}

export function MessageItem({ message, isStreaming, onFileClick }: MessageItemProps) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-4 py-2',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'
        )}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownRenderer content={message.content} onFileClick={onFileClick} />
          </div>
        )}
        {isStreaming && !isUser && (
          <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5" />
        )}
      </div>
    </div>
  );
}
