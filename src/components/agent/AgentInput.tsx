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

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuVisible && menuCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % menuCommands.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + menuCommands.length) % menuCommands.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        handleSelectCommand(menuCommands[selectedIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuVisible(false);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
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
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  };

  const hasContent = input.trim().length > 0;

  return (
    <div className="px-5 pb-5 pt-2">
      <div className="relative mx-auto max-w-3xl">
        <SlashCommandMenu
          commands={menuCommands}
          selectedIndex={selectedIndex}
          onSelect={handleSelectCommand}
          visible={menuVisible}
        />

        <div
          className={cn(
            'composer-glow rounded-[20px] border border-border/70 bg-[hsl(var(--card))]/96 shadow-[0_1px_0_0_hsl(var(--foreground)/0.03),0_18px_34px_-24px_hsl(var(--foreground)/0.18)] transition-all duration-300',
            'focus-within:border-[hsl(var(--primary))/0.24] focus-within:shadow-[0_1px_0_0_hsl(var(--foreground)/0.03),0_24px_40px_-26px_hsl(var(--primary)/0.20)]',
          )}
        >
          <div className="px-4 pt-3.5 pb-1.5">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => handleChange(event.target.value)}
              onKeyDown={handleKeyDown}
              onInput={handleInput}
              placeholder="输入任务描述... (/ 查看命令, Enter 发送, Shift+Enter 换行)"
              className="min-h-12 max-h-50 w-full resize-none bg-transparent text-[14px] leading-[1.7] text-foreground focus:outline-none placeholder:text-muted-foreground/55"
              rows={2}
              disabled={isLoading}
            />
          </div>

          <div className="flex items-center justify-between px-3.5 pb-3 pt-0.5">
            <div className="flex items-center gap-1.5">
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
                  'rounded-lg px-2.5 py-1 text-[12px] font-medium transition-all duration-200',
                  'text-muted-foreground/46 hover:bg-muted/55 hover:text-muted-foreground',
                )}
                title="斜杠命令"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                /
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              {modelName && (
                <span
                  className="rounded-lg border border-border/55 bg-muted/28 px-2.5 py-1 text-[11px] font-medium text-muted-foreground/48"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {modelName}
                </span>
              )}

              <div className="mx-0.5 h-4 w-px bg-border/45" />

              {isLoading ? (
                <button
                  onClick={onStop}
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-all duration-200',
                    'bg-[hsl(var(--destructive)/0.10)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.16)]',
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
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-all duration-300',
                    hasContent
                      ? 'bg-primary text-primary-foreground shadow-[0_10px_24px_-14px_hsl(var(--primary)/0.65)] hover:brightness-105'
                      : 'cursor-not-allowed bg-muted/45 text-muted-foreground/28',
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
