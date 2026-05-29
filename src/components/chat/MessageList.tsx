import { useEffect, useRef, useState, useCallback } from 'react';
import type { ChatMessage } from '../../types/chat';
import { MessageItem } from './MessageItem';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ArrowDown } from 'lucide-react';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  isStreaming?: boolean;
  streamingContent?: string;
  onFileClick?: (path: string) => void;
}

export function MessageList({ messages, isLoading, isStreaming, streamingContent, onFileClick }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isAtBottom = distanceFromBottom < 50;
    setShowScrollBtn(distanceFromBottom > 200);
    autoScrollRef.current = isAtBottom;
  }, []);

  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    autoScrollRef.current = true;
    setShowScrollBtn(false);
  };

  return (
    <div className="flex-1 relative overflow-hidden">
    <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-auto p-4 space-y-4 scroll-smooth">
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

      {/* Scroll to bottom button */}
      <div className="absolute bottom-0 left-0 right-0 flex justify-center pb-2 pointer-events-none">
        <button
          onClick={scrollToBottom}
          className={`
            pointer-events-auto
            h-9 w-9 rounded-full
            bg-background border border-border shadow-md
            flex items-center justify-center
            text-foreground/60 hover:text-foreground hover:shadow-lg
            transition-all duration-200
            ${showScrollBtn ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}
          `}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
