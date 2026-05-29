import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { ArrowUp, Square, ChevronDown, Check } from 'lucide-react';
import { cn } from '../../lib/utils';

const MODELS = [
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
  { id: 'claude-haiku-4-20250514', label: 'Claude Haiku 4' },
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Latest)' },
  { id: 'default', label: '默认 (跟随配置)' },
];

interface ChatInputProps {
  onSend: (content: string) => Promise<void>;
  onStop?: () => void;
  isLoading: boolean;
  model?: string;
  onModelChange?: (model: string) => void;
}

export function ChatInput({ onSend, onStop, isLoading, model = 'default', onModelChange }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [showModels, setShowModels] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowModels(false);
      }
    };
    if (showModels) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showModels]);

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
  const currentModel = MODELS.find((m) => m.id === model) || MODELS[MODELS.length - 1];

  return (
    <div className="px-5 pb-5 pt-2">
      <div className="relative max-w-3xl mx-auto">
        {/* Composer container */}
        <div className={cn(
          'composer-glow rounded-2xl border transition-all duration-300',
          'bg-[hsl(var(--card))] shadow-[0_0_0_1px_hsl(var(--border)),0_2px_8px_-2px_hsl(var(--foreground)/0.05)]',
          'focus-within:shadow-[0_0_0_1px_hsl(var(--primary)/0.3),0_4px_16px_-4px_hsl(var(--primary)/0.1)]',
          'focus-within:border-[hsl(var(--primary)/0.3)]'
        )}>
          {/* Textarea area */}
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

          {/* Bottom action bar */}
          <div className="flex items-center justify-between px-3 pb-2.5 pt-0.5">
            {/* Left side - reserved for future actions */}
            <div className="flex items-center gap-1.5" />

            {/* Right side - model selector + send/stop */}
            <div className="flex items-center gap-1.5">
              {/* Model selector */}
              <div className="relative" ref={dropdownRef}>
                <button
                  onClick={() => setShowModels(!showModels)}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1.5 rounded-lg text-[12px] font-medium transition-colors',
                    'text-foreground/70 hover:text-foreground hover:bg-muted/60'
                  )}
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  <span className="max-w-[120px] truncate">{currentModel.label}</span>
                  <ChevronDown className={cn('h-3 w-3 transition-transform', showModels && 'rotate-180')} />
                </button>

                {/* Dropdown */}
                {showModels && (
                  <div className="absolute bottom-full right-0 mb-1.5 w-56 bg-background border border-border rounded-xl shadow-lg py-1 z-50 animate-fade-in">
                    {MODELS.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => {
                          onModelChange?.(m.id);
                          setShowModels(false);
                        }}
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
                          'hover:bg-muted/50',
                          m.id === model && 'text-primary'
                        )}
                      >
                        <span className="flex-1 truncate">{m.label}</span>
                        {m.id === model && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Divider */}
              <div className="w-px h-4 bg-border/60" />

              {/* Send / Stop button */}
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

        {/* Subtle hint text */}
        <p className="text-center text-[11px] text-muted-foreground/50 mt-2.5 select-none">
          Claude Agent 将自主完成编码任务
        </p>
      </div>
    </div>
  );
}
