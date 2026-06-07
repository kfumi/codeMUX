import { useState, useRef, useCallback, KeyboardEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { cn } from '../../lib/utils';
import { SlashCommandMenu } from './SlashCommandMenu';
import { filterCommands, findCommand, SlashCommand } from '../../lib/slashCommands';

interface AgentInputProps {
  onSend: (content: string) => Promise<void>;
  onCommand: (command: SlashCommand, args: string) => void | Promise<void>;
  onStop?: () => void;
  isLoading: boolean;
  modelName?: string;
}

export function AgentInput({ onSend, onCommand, onStop, isLoading, modelName }: AgentInputProps) {
  const [input, setInput] = useState('');
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuCommands, setMenuCommands] = useState<SlashCommand[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 检测斜杠命令并更新菜单
  const updateMenu = useCallback((value: string) => {
    if (value.startsWith('/')) {
      const spaceIdx = value.indexOf(' ');
      if (spaceIdx > 0) {
        setMenuVisible(false);
        return;
      }
      const prefix = value.slice(1);
      const filtered = filterCommands(prefix);
      if (filtered.length > 0) {
        setMenuCommands(filtered);
        setSelectedIndex(0);
        setMenuVisible(true);
      } else {
        setMenuVisible(false);
      }
    } else {
      setMenuVisible(false);
    }
  }, []);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || isLoading) return;

    if (content.startsWith('/')) {
      const spaceIdx = content.indexOf(' ');
      const cmdName = spaceIdx > 0 ? content.slice(1, spaceIdx) : content.slice(1);
      const args = spaceIdx > 0 ? content.slice(spaceIdx + 1).trim() : '';
      const command = findCommand(cmdName);
      if (command) {
        setInput('');
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        setMenuVisible(false);
        await onCommand(command, args);
        return;
      }
    }

    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    setMenuVisible(false);
    await onSend(content);
  };

  const handleSelectCommand = (command: SlashCommand) => {
    const value = `/${command.name} `;
    setInput(value);
    setMenuVisible(false);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(value.length, value.length);
      }
    }, 0);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuVisible && menuCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % menuCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + menuCommands.length) % menuCommands.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        handleSelectCommand(menuCommands[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuVisible(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChange = (value: string) => {
    setInput(value);
    updateMenu(value);
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
        {/* 斜杠命令菜单 */}
        <SlashCommandMenu
          commands={menuCommands}
          selectedIndex={selectedIndex}
          onSelect={handleSelectCommand}
          visible={menuVisible}
        />

        <div className={cn(
          'composer-glow rounded-2xl border transition-all duration-300',
          'bg-[hsl(var(--card))] shadow-[0_0_0_1px_hsl(var(--border)/0.6),0_2px_8px_-2px_hsl(var(--foreground)/0.04)]',
          'focus-within:shadow-[0_0_0_1px_hsl(var(--primary)/0.25),0_4px_20px_-4px_hsl(var(--primary)/0.12)]',
          'focus-within:border-[hsl(var(--primary)/0.25)]'
        )}>
          <div className="px-4 pt-3.5 pb-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onInput={handleInput}
              placeholder="输入任务描述... (/ 查看命令, Enter 发送, Shift+Enter 换行)"
              className="w-full resize-none bg-transparent text-[14px] leading-[1.65] focus:outline-none placeholder:text-muted-foreground/50 min-h-[48px] max-h-[200px]"
              rows={2}
              disabled={isLoading}
            />
          </div>

          <div className="flex items-center justify-between px-3 pb-2.5 pt-0.5">
            <div className="flex items-center gap-1.5">
              {/* 斜杠命令提示 */}
              <button
                onClick={() => {
                  if (textareaRef.current) {
                    const value = '/';
                    setInput(value);
                    textareaRef.current.focus();
                    updateMenu(value);
                  }
                }}
                className={cn(
                  'px-2.5 py-1 rounded-lg text-[12px] font-medium transition-all duration-200',
                  'text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50'
                )}
                title="斜杠命令"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                /
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              {/* Read-only model display */}
              {modelName && (
                <span
                  className="px-2.5 py-1 text-[11px] font-medium text-muted-foreground/40 rounded-md bg-muted/30"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {modelName}
                </span>
              )}

              <div className="w-px h-4 bg-border/40 mx-0.5" />

              {isLoading ? (
                <button
                  onClick={onStop}
                  className={cn(
                    'shrink-0 h-8 w-8 rounded-xl flex items-center justify-center transition-all duration-200',
                    'bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.18)] hover:scale-105 active:scale-95'
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
                      ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-[0_2px_10px_-2px_hsl(var(--primary)/0.4)] hover:shadow-[0_4px_16px_-2px_hsl(var(--primary)/0.5)] hover:scale-105 active:scale-95'
                      : 'bg-muted/40 text-muted-foreground/30 cursor-not-allowed'
                  )}
                  title="发送"
                >
                  <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
