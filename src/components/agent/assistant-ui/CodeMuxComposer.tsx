import {
  ComposerPrimitive,
  useAui,
  useAuiState,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
} from '@assistant-ui/react';
import { LexicalComposerInput } from '@assistant-ui/react-lexical';
import type { DirectiveChipProps } from '@assistant-ui/react-lexical';
import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  Folder,
  FolderPlus,
  Info,
  Layers,
  ListTodo,
  Search,
  Sparkles,
  Square,
  Terminal,
  TestTube2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useMemo, useRef, useState, type FC, type ReactNode } from 'react';

import type { SlashCommand } from '../../../lib/slashCommands';
import { getAllCommands } from '../../../lib/slashCommands';
import { cn } from '../../../lib/utils';
import { useAgentStore } from '../../../stores/agentStore';
import { usePreviewStore, type FileTreeNodeData } from '../../../stores/previewStore';
import type { AgentKind } from '../../../types/session';
import { CodeMuxDirectiveChip, type CodeMuxDirectiveKind } from './CodeMuxDirectiveText';

interface CodeMuxComposerProps {
  sessionId: string;
  agentKind?: AgentKind;
  projectPath?: string | null;
  modelName?: string;
  placeholder?: string;
  modelSelector?: ReactNode;
  onStop?: () => void | Promise<void>;
  activeCommandMode?: { id: 'plan'; label: string } | null;
  onClearCommandMode?: () => void;
}

type TriggerCategory = { id: string; label: string };

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

const FILE_FORMATTER: Unstable_DirectiveFormatter = {
  serialize: (item) => `@${item.id} `,
  parse: (text) => (text ? [{ kind: 'text', text }] : []),
};

const MAX_FILE_RESULTS = 50;

type FileEntry = { name: string; relativePath: string; isDir: boolean };

function flattenFileTree(nodes: FileTreeNodeData[], prefix = ''): FileEntry[] {
  const result: FileEntry[] = [];
  for (const node of nodes) {
    const rel = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.isDir) {
      result.push({ name: node.name, relativePath: rel, isDir: true });
      if (node.children) result.push(...flattenFileTree(node.children, rel));
    } else {
      result.push({ name: node.name, relativePath: rel, isDir: false });
    }
  }
  return result;
}

function matchFileName(query: string, fileName: string): boolean {
  const q = query.toLowerCase();
  const n = fileName.toLowerCase();
  if (n.includes(q)) return true;
  if (q.includes(' ') || q.includes('-') || q.includes('_')) {
    return q.split(/[\s\-_]+/).filter(Boolean).every((seg) => n.includes(seg));
  }
  return false;
}

/** Custom inline chip for directives rendered by Lexical */
function DirectiveChip({ directiveType, label }: DirectiveChipProps) {
  return <CodeMuxDirectiveChip kind={getDirectiveKind(directiveType)} value={label} label={label} />;
}

const DIRECTIVE_CHIP: FC<DirectiveChipProps> = DirectiveChip;

export function CodeMuxComposer({
  sessionId,
  agentKind = 'claude_code',
  projectPath,
  modelName,
  placeholder = '输入消息... (@ 引用文件, / 命令)',
  modelSelector,
  onStop,
  activeCommandMode,
  onClearCommandMode,
}: CodeMuxComposerProps) {
  const aui = useAui();
  const composerRootRef = useRef<HTMLDivElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const composerText = useAuiState((state) => state.composer.text);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const commands = getAllCommands(agentKind);
  const triggerDataRef = useRef<{
    itemsByCategory: Map<string, Unstable_TriggerItem[]>;
    categories: TriggerCategory[];
    commands: SlashCommand[];
  }>({ itemsByCategory: new Map(), categories: [], commands: [] });

  const nextItemsByCategory = new Map<string, Unstable_TriggerItem[]>();
  for (const category of CATEGORY_ORDER) {
    nextItemsByCategory.set(
      category,
      commands.filter((c) => c.category === category).map((c) => toTriggerItem(c)),
    );
  }
  triggerDataRef.current = {
    itemsByCategory: nextItemsByCategory,
    categories: CATEGORY_ORDER.filter((c) => (nextItemsByCategory.get(c)?.length ?? 0) > 0)
      .map((c) => ({ id: c, label: CATEGORY_LABELS[c] })),
    commands,
  };

  const slashAdapter = useMemo<TriggerAdapter>(
    () => ({
      categories: () => triggerDataRef.current.categories,
      categoryItems: (id) => triggerDataRef.current.itemsByCategory.get(id) ?? [],
      search: (query) => {
        const q = query.trim().toLowerCase();
        return triggerDataRef.current.commands
          .filter((c) => matchesCommand(c, q))
          .map((c) => toTriggerItem(c));
      },
    }),
    [],
  );

  const treeRoot = usePreviewStore((state) => state.treeRoot);
  const fileItemsRef = useRef<FileEntry[]>([]);
  if (projectPath && treeRoot) {
    fileItemsRef.current = flattenFileTree(treeRoot);
  } else {
    fileItemsRef.current = [];
  }

  const fileAdapter = useMemo<TriggerAdapter>(
    () => ({
      categories: () => [],
      categoryItems: () => [],
      search: (query) => {
        const items = fileItemsRef.current;
        if (items.length === 0) return [];
        const t = query.trim();
        if (!t) return items.slice(0, MAX_FILE_RESULTS).map(toFileTriggerItem);
        return items
          .filter((f) => matchFileName(t, f.name) || matchFileName(t, f.relativePath))
          .slice(0, MAX_FILE_RESULTS)
          .map(toFileTriggerItem);
      },
    }),
    [],
  );

  const hasInput = composerText.trim().length > 0;

  const insertSlash = () => {
    aui.composer().setText('/');
  };

  return (
    <div className="relative mx-auto flex w-full max-w-3xl flex-col">
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        {/* ── Slash command popover ── */}
        <ComposerPrimitive.Unstable_TriggerPopover
          char="/"
          adapter={slashAdapter}
          className="absolute bottom-full left-0 right-0 z-50 mb-3 flex max-h-[min(28rem,calc(100vh-6rem))] flex-col overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-2))]/98 shadow-[0_20px_54px_-30px_hsl(var(--foreground)/0.5)] backdrop-blur-lg"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={COMMAND_FORMATTER} />
          <ComposerPrimitive.Unstable_TriggerPopoverCategories className="min-h-0 overflow-y-auto py-2">
            {(cats) =>
              cats.map((cat) => (
                <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
                  key={cat.id}
                  categoryId={cat.id}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/46 data-highlighted:bg-muted/56"
                >
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-muted/74 text-muted-foreground">
                    {getCategoryIcon(cat.id)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">{cat.label}</div>
                    <div className="text-xs text-muted-foreground">浏览{cat.label}命令</div>
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
                  <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">命令</div>
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
                        <span className="text-sm font-medium text-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                          {item.label}
                        </span>
                        {getItemArgsHint(item) && <span className="text-xs text-muted-foreground">{getItemArgsHint(item)}</span>}
                      </div>
                      {item.description && <div className="truncate text-xs text-muted-foreground">{item.description}</div>}
                    </div>
                  </ComposerPrimitive.Unstable_TriggerPopoverItem>
                ))}
              </>
            )}
          </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>

        {/* ── File mention popover ── */}
        <ComposerPrimitive.Unstable_TriggerPopover
          char="@"
          adapter={fileAdapter}
          className="absolute bottom-full left-0 right-0 z-50 mb-3 flex max-h-[min(20rem,calc(100vh-6rem))] flex-col overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-2))]/98 shadow-[0_20px_54px_-30px_hsl(var(--foreground)/0.5)] backdrop-blur-lg"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={FILE_FORMATTER} />
          <ComposerPrimitive.Unstable_TriggerPopoverItems className="min-h-0 overflow-y-auto py-2">
            {(items) => (
              <>
                <div className="flex items-center gap-2 px-3 pb-1.5">
                  <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
                  <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">引用文件</div>
                </div>
                {items.length === 0 && <div className="px-3 py-4 text-center text-xs text-muted-foreground/60">无匹配文件</div>}
                {items.map((item) => (
                  <ComposerPrimitive.Unstable_TriggerPopoverItem
                    key={item.id}
                    item={item}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/46 data-highlighted:bg-muted/56"
                  >
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/74 text-muted-foreground">
                      {item.type === 'directory' ? <Folder className="h-3.5 w-3.5" /> : <FileCode2 className="h-3.5 w-3.5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="truncate text-sm font-medium text-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                        {item.label}
                      </span>
                      {item.description && item.description !== item.label && (
                        <div className="truncate text-xs text-muted-foreground/60">{item.description}</div>
                      )}
                    </div>
                  </ComposerPrimitive.Unstable_TriggerPopoverItem>
                ))}
              </>
            )}
          </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>

        {/* ── Composer ── */}
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
            <LexicalComposerInput
              submitMode="enter"
              placeholder={placeholder}
              directiveChip={DIRECTIVE_CHIP}
              className="relative min-h-10 max-h-50 w-full overflow-y-auto text-sm leading-6 text-foreground outline-none [&_.aui-lexical-input]:min-h-10 [&_.aui-lexical-input]:max-h-50 [&_.aui-lexical-input]:overflow-y-auto [&_.aui-lexical-input]:border-0 [&_.aui-lexical-input]:bg-transparent [&_.aui-lexical-input]:px-2 [&_.aui-lexical-input]:py-1 [&_.aui-lexical-input]:text-sm [&_.aui-lexical-input]:leading-6 [&_.aui-lexical-input]:text-foreground [&_.aui-lexical-input]:shadow-none [&_.aui-lexical-input]:outline-none [&_.aui-lexical-input]:ring-0 [&_.aui-lexical-input]:focus-visible:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:left-2 [&_.aui-lexical-placeholder]:top-1 [&_.aui-lexical-placeholder]:text-sm [&_.aui-lexical-placeholder]:leading-6 [&_.aui-lexical-placeholder]:text-muted-foreground/70"
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
                {activeCommandMode && (
                  <span
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[hsl(var(--accent)/0.42)] bg-[hsl(var(--accent)/0.16)] px-2 text-xs font-medium text-[hsl(var(--accent))]"
                    data-active-command-mode={activeCommandMode.id}
                  >
                    <ListTodo className="h-3.5 w-3.5" />
                    <span>{activeCommandMode.label}</span>
                    <button
                      type="button"
                      onClick={onClearCommandMode}
                      className="-mr-0.5 inline-flex h-4 w-4 items-center justify-center rounded-sm text-[hsl(var(--accent)/0.82)] transition-colors hover:bg-[hsl(var(--accent)/0.16)] hover:text-[hsl(var(--accent))]"
                      title={`关闭${activeCommandMode.label}模式`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
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
                    onClick={() => void onStop?.()}
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
    metadata: { category: command.category, argsHint: command.argsHint ?? '' },
  };
}

function toFileTriggerItem(file: FileEntry): Unstable_TriggerItem {
  return {
    id: file.relativePath,
    type: file.isDir ? 'directory' : 'file',
    label: file.name,
    description: file.relativePath,
  };
}

function matchesCommand(command: SlashCommand, q: string) {
  if (!q) return true;
  return (
    command.name.includes(q) ||
    command.description.toLowerCase().includes(q) ||
    command.alias?.some((a) => a.toLowerCase().includes(q)) === true
  );
}

function getItemArgsHint(item: Unstable_TriggerItem) {
  const h = item.metadata?.argsHint;
  return typeof h === 'string' && h.length > 0 ? h : undefined;
}

function getCategoryIcon(id: string) {
  switch (id) {
    case 'session': return <FolderPlus className="h-4 w-4" />;
    case 'info': return <Info className="h-4 w-4" />;
    case 'builtin': return <Sparkles className="h-4 w-4" />;
    case 'custom': return <Wrench className="h-4 w-4" />;
    case 'skill': return <Zap className="h-4 w-4" />;
    default: return <Terminal className="h-4 w-4" />;
  }
}

function getCommandIcon(id: string) {
  switch (id) {
    case 'new': return <FolderPlus className="h-4 w-4" />;
    case 'clear': return <Layers className="h-4 w-4" />;
    case 'compact': return <Zap className="h-4 w-4" />;
    case 'cost': case 'status': case 'explain': return <Info className="h-4 w-4" />;
    case 'review': case 'code-review': case 'security-review': case 'deep-research': return <Search className="h-4 w-4" />;
    case 'test': case 'verify': return <TestTube2 className="h-4 w-4" />;
    case 'fix': case 'debug': case 'refactor': return <Wrench className="h-4 w-4" />;
    case 'run': case 'init': return <Terminal className="h-4 w-4" />;
    default: return <Sparkles className="h-4 w-4" />;
  }
}

function getDirectiveKind(type: string): CodeMuxDirectiveKind {
  if (type === 'file' || type === 'directory') {
    return type;
  }
  return 'command';
}
