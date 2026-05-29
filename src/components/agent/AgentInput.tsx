import { useState, useRef, KeyboardEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { cn } from '../../lib/utils';

interface AgentInputProps {
  onSend: (content: string) => Promise<void>;
  onStop?: () => void;
  isLoading: boolean;
  modelName?: string;
}

export function AgentInput({ onSend, onStop, isLoading, modelName }: AgentInputProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || isLoading) return;
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    await onSend(content);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
  };

  const hasContent = input.trim().length > 0;

  return (
    <div className="px-5 pb-5 pt-2">
      <div className="relative max-w-3xl mx-auto">
        <div className={cn(
          'composer-glow rounded-2xl border transition-all duration-300',
          'bg-[hsl(var(--card))] shadow-[0_0_0_1px_hsl(var(--border)),0_2px_8px_-2px_hsl(var(--foreground)/0.05)]',
          'focus-within:shadow-[0_0_0_1px_hsl(var(--primary)/0.3),0_4px_16px_-4px_hsl(var(--primary)/0.1)]',
          'focus-within:border-[hsl(var(--primary)/0.3)]'
        )}>
          <div className="px-4 pt-3 pb-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onInput={handleInput}
              placeholder="输入任务描述... (Enter 发送, Shift+Enter 换行)"
              className="w-full resize-none bg-transparent text-[14px] leading-[1.6] focus:outline-none placeholder:text-muted-foreground min-h-[48px] max-h-[200px]"
              rows={2}
              disabled={isLoading}
            />
          </div>

          <div className="flex items-center justify-between px-3 pb-2.5 pt-0.5">
            <div className="flex items-center gap-1.5" />

            <div className="flex items-center gap-1.5">
              {/* Read-only model display */}
              {modelName && (
                <span
                  className="px-2 py-1.5 text-[12px] font-medium text-foreground/50 truncate max-w-[160px]"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {modelName}
                </span>
              )}

              <div className="w-px h-4 bg-border/60" />

              {isLoading ? (
                <button
                  onClick={onStop}
                  className={cn(
                    'shrink-0 h-8 w-8 rounded-xl flex items-center justify-center transition-all duration-200',
                    'bg-red-500/10 text-red-500 hover:bg-red-500/20 hover:scale-105 active:scale-95'
                  )}
                  title="停止"
                >
                  <Square className="h-3.5 w-3.5" fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!hasContent}
                  className={cn(
                    'shrink-0 h-8 w-8 rounded-xl flex items-center justify-center transition-all duration-300',
                    hasContent
                      ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.4)] hover:shadow-[0_4px_12px_-2px_hsl(var(--primary)/0.5)] hover:scale-105 active:scale-95'
                      : 'bg-muted/60 text-muted-foreground/50 cursor-not-allowed'
                  )}
                  title="发送"
                >
                  <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>

        <p className="text-center text-[11px] text-muted-foreground/50 mt-2.5 select-none">
          Claude Agent 将自主完成编码任务
        </p>
      </div>
    </div>
  );
}
