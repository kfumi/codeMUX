import { useEffect, useRef } from 'react';
import { cn } from '../../lib/utils';
import { SlashCommand } from '../../lib/slashCommands';
import {
  MessageSquare, BarChart3, Info, Zap,
  Search, TestTube, Wrench, RefreshCw, Layers, Terminal
} from 'lucide-react';

interface SlashCommandMenuProps {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  visible: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  session: '会话',
  info: '信息',
  builtin: '内置',
  custom: '自定义',
  skill: 'Skill',
};

const CATEGORY_COLORS: Record<string, string> = {
  session: 'text-blue-500',
  info: 'text-amber-500',
  builtin: 'text-green-500',
  custom: 'text-purple-500',
  skill: 'text-orange-500',
};

function getCommandIcon(name: string) {
  const iconClass = 'h-3.5 w-3.5';
  switch (name) {
    case 'new': return <MessageSquare className={iconClass} />;
    case 'clear': return <Layers className={iconClass} />;
    case 'compact': return <Zap className={iconClass} />;
    case 'cost': return <BarChart3 className={iconClass} />;
    case 'status': return <Info className={iconClass} />;
    case 'init': return <Terminal className={iconClass} />;
    case 'review': case 'code-review': case 'security-review': return <Search className={iconClass} />;
    case 'explain': return <Info className={iconClass} />;
    case 'test': case 'verify': return <TestTube className={iconClass} />;
    case 'fix': case 'debug': return <Wrench className={iconClass} />;
    case 'refactor': case 'simplify': return <RefreshCw className={iconClass} />;
    case 'context': case 'usage': case 'insights': return <BarChart3 className={iconClass} />;
    case 'deep-research': return <Search className={iconClass} />;
    case 'run': return <Terminal className={iconClass} />;
    default: return <Terminal className={iconClass} />;
  }
}

export function SlashCommandMenu({ commands, selectedIndex, onSelect, visible }: SlashCommandMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // 滚动到选中项
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!visible || commands.length === 0) return null;

  // 按 category 分组
  const grouped: { category: string; items: (SlashCommand & { _globalIdx: number })[] }[] = [];
  let globalIdx = 0;
  const catOrder = ['session', 'info', 'builtin', 'custom', 'skill'];
  for (const cat of catOrder) {
    const items = commands
      .filter((c) => c.category === cat)
      .map((c) => ({ ...c, _globalIdx: globalIdx++ }));
    if (items.length > 0) {
      grouped.push({ category: cat, items });
    }
  }

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-50">
      <div
        ref={listRef}
        className={cn(
          'max-h-[280px] overflow-y-auto rounded-xl border',
          'bg-[hsl(var(--card))] shadow-[0_-4px_24px_-4px_hsl(var(--foreground)/0.08)]',
          'border-[hsl(var(--border))]',
          'backdrop-blur-xl'
        )}
      >
        <div className="py-1.5">
          {grouped.map((group) => (
            <div key={group.category}>
              <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                {CATEGORY_LABELS[group.category] || group.category}
              </div>
              {group.items.map((cmd) => {
                const isSelected = cmd._globalIdx === selectedIndex;
                return (
                  <button
                    key={cmd.name}
                    ref={isSelected ? selectedRef : undefined}
                    onClick={() => onSelect(cmd)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors duration-100',
                      isSelected
                        ? 'bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--foreground))]'
                        : 'text-[hsl(var(--foreground)/0.8)] hover:bg-[hsl(var(--muted))]'
                    )}
                  >
                    <span className={cn('shrink-0', CATEGORY_COLORS[cmd.category] || 'text-muted-foreground')}>
                      {getCommandIcon(cmd.name)}
                    </span>
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <span
                        className="text-[13px] font-medium shrink-0"
                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                      >
                        /{cmd.name}
                      </span>
                      {cmd.argsHint && (
                        <span className="text-[12px] text-muted-foreground/50 shrink-0">
                          {cmd.argsHint}
                        </span>
                      )}
                      <span className="text-[12px] text-muted-foreground truncate">
                        {cmd.description}
                      </span>
                    </div>
                    {cmd.category === 'builtin' && (
                      <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-green-500/10 text-green-500 font-medium">
                        内置
                      </span>
                    )}
                    {cmd.category === 'custom' && (
                      <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-purple-500/10 text-purple-500 font-medium">
                        自定义
                      </span>
                    )}
                    {cmd.category === 'skill' && (
                      <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-orange-500/10 text-orange-500 font-medium">
                        skill
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
