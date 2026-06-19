import {
  ComposerPrimitive,
  useAui,
  useAuiState,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
} from '@assistant-ui/react';
import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  FolderPlus,
  Info,
  Layers,
  Search,
  Sparkles,
  Square,
  Terminal,
  TestTube2,
  Wrench,
  Zap,
} from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';

import type { SlashCommand } from '../../../lib/slashCommands';
import { getAllCommands } from '../../../lib/slashCommands';
import { cn } from '../../../lib/utils';
import { useAgentStore } from '../../../stores/agentStore';

interface CodeMuxComposerProps {
  sessionId: string;
  modelName?: string;
  modelSelector?: ReactNode;
  onStop?: () => void | Promise<void>;
}

type TriggerCategory = {
  id: string;
  label: string;
};

type TriggerAdapter = {
  categories(): readonly TriggerCategory[];
  categoryItems(categoryId: string): readonly Unstable_TriggerItem[];
  search?(query: string): readonly Unstable_TriggerItem[];
};

const CATEGORY_ORDER = ['session', 'info', 'builtin', 'custom', 'skill'] as const;

const CATEGORY_LABELS: Record<string, string> = {
  session: '会话',
  info: '信息',
  builtin: '内置',
  custom: '自定义',
  skill: '技能',
};

const COMMAND_FORMATTER: Unstable_DirectiveFormatter = {
  serialize: (item) => `/${item.id} `,
  parse: (text) => (text ? [{ kind: 'text', text }] : []),
};

export function CodeMuxComposer({ sessionId, modelName, modelSelector, onStop }: CodeMuxComposerProps) {
  const aui = useAui();
  const composerRootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const composerText = useAuiState((state) => state.composer.text);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const commands = getAllCommands();
  const triggerDataRef = useRef<{
    itemsByCategory: Map<string, Unstable_TriggerItem[]>;
    categories: TriggerCategory[];
    commands: SlashCommand[];
  }>({
    itemsByCategory: new Map(),
    categories: [],
    commands: [],
  });

  const nextItemsByCategory = new Map<string, Unstable_TriggerItem[]>();
  for (const category of CATEGORY_ORDER) {
    nextItemsByCategory.set(
      category,
      commands
        .filter((command) => command.category === category)
        .map((command) => toTriggerItem(command)),
    );
  }

  triggerDataRef.current = {
    itemsByCategory: nextItemsByCategory,
    categories: CATEGORY_ORDER.filter(
      (category) => (nextItemsByCategory.get(category)?.length ?? 0) > 0,
    ).map((category) => ({
      id: category,
      label: CATEGORY_LABELS[category],
    })),
    commands,
  };

  const slashAdapter = useMemo<TriggerAdapter>(
    () => ({
      categories: () => triggerDataRef.current.categories,
      categoryItems: (categoryId: string) => triggerDataRef.current.itemsByCategory.get(categoryId) ?? [],
      search: (query: string) => {
        const lowered = query.trim().toLowerCase();
        return triggerDataRef.current.commands
          .filter((command) => matchesCommand(command, lowered))
          .map((command) => toTriggerItem(command));
      },
    }),
    [],
  );

  const hasInput = composerText.trim().length > 0;

  const insertSlash = () => {
    aui.composer().setText('/');
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(1, 1);
    });
  };

  return (
    <div className="relative mx-auto flex w-full max-w-3xl flex-col">
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Unstable_TriggerPopover
          char="/"
          adapter={slashAdapter}
          className="absolute bottom-full left-0 right-0 z-50 mb-3 flex max-h-[min(28rem,calc(100vh-6rem))] flex-col overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-2))]/98 shadow-[0_20px_54px_-30px_hsl(var(--foreground)/0.5)] backdrop-blur-lg"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={COMMAND_FORMATTER} />

          <ComposerPrimitive.Unstable_TriggerPopoverCategories className="min-h-0 overflow-y-auto py-2">
            {(categories) =>
              categories.map((category) => (
                <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
                  key={category.id}
                  categoryId={category.id}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/46 data-highlighted:bg-muted/56"
                >
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-muted/74 text-muted-foreground">
                    {getCategoryIcon(category.id)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">{category.label}</div>
                    <div className="text-xs text-muted-foreground">浏览{category.label}命令</div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
              ))
            }
          </ComposerPrimitive.Unstable_TriggerPopoverCategories>

          <ComposerPrimitive.Unstable_TriggerPopoverItems className="min-h-0 flex-1 overflow-y-auto py-2">
            {(items) => (
              <>
                <div className="flex items-center gap-2 px-3 pb-1.5">
                  <ComposerPrimitive.Unstable_TriggerPopoverBack className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
                    <ChevronLeft className="h-4 w-4" />
                  </ComposerPrimitive.Unstable_TriggerPopoverBack>
                  <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                    命令
                  </div>
                </div>

                {items.map((item) => (
                  <ComposerPrimitive.Unstable_TriggerPopoverItem
                    key={item.id}
                    item={item}
                    className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/46 data-highlighted:bg-muted/56"
                  >
                    <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-xl bg-muted/74 text-muted-foreground">
                      {getCommandIcon(item.id)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="text-sm font-medium text-foreground"
                          style={{ fontFamily: "'JetBrains Mono', monospace" }}
                        >
                          {item.label}
                        </span>
                        {getItemArgsHint(item) && (
                          <span className="text-xs text-muted-foreground">{getItemArgsHint(item)}</span>
                        )}
                      </div>
                      {item.description && (
                        <div className="truncate text-xs text-muted-foreground">{item.description}</div>
                      )}
                    </div>
                  </ComposerPrimitive.Unstable_TriggerPopoverItem>
                ))}
              </>
            )}
          </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>

        <ComposerPrimitive.Root className="relative flex w-full flex-col">
          <div
            ref={composerRootRef}
            onFocusCapture={() => setIsFocused(true)}
            onBlurCapture={() => {
              requestAnimationFrame(() => {
                setIsFocused(composerRootRef.current?.contains(document.activeElement) ?? false);
              });
            }}
            className={cn(
              'aui-composer-root flex w-full flex-col gap-2 overflow-hidden rounded-2xl border p-2.5 transition-all duration-200',
              isFocused
                ? 'border-[hsl(var(--primary)/0.38)] bg-[hsl(var(--surface-1))]/98 shadow-[0_18px_42px_-30px_hsl(var(--primary)/0.36),inset_0_1px_0_hsl(var(--foreground)/0.035)]'
                : 'border-border/82 bg-[hsl(var(--surface-1))]/94 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.026)]',
            )}
          >
            <ComposerPrimitive.Input
              ref={inputRef}
              submitMode="enter"
              minRows={1}
              maxRows={8}
              placeholder="输入消息..."
              className={cn(
                'max-h-32 min-h-10 w-full resize-none border-0 px-2 py-1 text-sm leading-6 text-foreground outline-none ring-0 shadow-none placeholder:text-muted-foreground/70',
                'rounded-none focus:border-0 focus:outline-none focus:ring-0 focus:shadow-none',
                'focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none',
                '[box-shadow:none] [-webkit-appearance:none] appearance-none',
                'bg-transparent',
              )}
            />

            <div className="relative flex items-center justify-between pl-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={insertSlash}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/40 bg-[hsl(var(--surface-2))]/70 text-[12px] font-medium leading-none text-muted-foreground/76 transition-all duration-200 hover:bg-muted/58 hover:text-foreground"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  title="插入斜杠命令"
                >
                  /
                </button>
              </div>

              <div className="flex items-center gap-2">
                {modelSelector ?? (
                  <span className="max-w-54 truncate rounded-full border border-border/45 bg-[hsl(var(--surface-2))]/64 px-2.5 py-1 text-[11px] text-muted-foreground/74">
                    {modelName ?? ''}
                  </span>
                )}

                {isRunning ? (
                  <button
                    type="button"
                    onClick={() => {
                      void onStop?.();
                    }}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--destructive)/0.12)] text-[hsl(var(--destructive))] transition-all duration-200 hover:scale-105 hover:bg-[hsl(var(--destructive)/0.18)] active:scale-95"
                    title="停止"
                  >
                    <Square className="h-3.5 w-3.5" fill="currentColor" />
                  </button>
                ) : (
                  <ComposerPrimitive.Send
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-all duration-200 active:scale-95',
                      hasInput
                        ? 'bg-primary text-primary-foreground shadow-[0_10px_24px_-15px_hsl(var(--primary)/0.58)] hover:bg-primary/94'
                        : 'cursor-not-allowed bg-[hsl(var(--surface-3))] text-muted-foreground/42',
                    )}
                    title="发送"
                  >
                    <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                  </ComposerPrimitive.Send>
                )}
              </div>
            </div>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </div>
  );
}

function toTriggerItem(command: SlashCommand): Unstable_TriggerItem {
  return {
    id: command.name,
    type: 'command',
    label: `/${command.name}`,
    description: command.description,
    metadata: {
      category: command.category,
      argsHint: command.argsHint ?? '',
    },
  };
}

function matchesCommand(command: SlashCommand, loweredQuery: string) {
  if (!loweredQuery) {
    return true;
  }

  return (
    command.name.includes(loweredQuery) ||
    command.description.toLowerCase().includes(loweredQuery) ||
    command.alias?.some((alias) => alias.toLowerCase().includes(loweredQuery)) === true
  );
}

function getItemArgsHint(item: Unstable_TriggerItem) {
  const hint = item.metadata?.argsHint;
  return typeof hint === 'string' && hint.length > 0 ? hint : undefined;
}

function getCategoryIcon(categoryId: string) {
  switch (categoryId) {
    case 'session':
      return <FolderPlus className="h-4 w-4" />;
    case 'info':
      return <Info className="h-4 w-4" />;
    case 'builtin':
      return <Sparkles className="h-4 w-4" />;
    case 'custom':
      return <Wrench className="h-4 w-4" />;
    case 'skill':
      return <Zap className="h-4 w-4" />;
    default:
      return <Terminal className="h-4 w-4" />;
  }
}

function getCommandIcon(commandId: string) {
  switch (commandId) {
    case 'new':
      return <FolderPlus className="h-4 w-4" />;
    case 'clear':
      return <Layers className="h-4 w-4" />;
    case 'compact':
      return <Zap className="h-4 w-4" />;
    case 'cost':
    case 'status':
    case 'explain':
      return <Info className="h-4 w-4" />;
    case 'review':
    case 'code-review':
    case 'security-review':
    case 'deep-research':
      return <Search className="h-4 w-4" />;
    case 'test':
    case 'verify':
      return <TestTube2 className="h-4 w-4" />;
    case 'fix':
    case 'debug':
    case 'refactor':
      return <Wrench className="h-4 w-4" />;
    case 'run':
    case 'init':
      return <Terminal className="h-4 w-4" />;
    default:
      return <Sparkles className="h-4 w-4" />;
  }
}
