import {
  ComposerPrimitive,
  useAui,
  useAuiState,
  type Unstable_DirectiveFormatter,
  type Unstable_DirectiveSegment,
  type Unstable_TriggerItem,
} from '@assistant-ui/react';
import { LexicalComposerInput } from '@assistant-ui/react-lexical';
import type { DirectiveChipProps } from '@assistant-ui/react-lexical';
import {
  ArrowUp,
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
import { useEffect, useMemo, useRef, useState, type FC, type KeyboardEvent, type ReactNode } from 'react';

import type { AgentMessage } from '../../../stores/agentStore';
import type { SlashCommand } from '../../../lib/slashCommands';
import { getAllCommands } from '../../../lib/slashCommands';
import { cn } from '../../../lib/utils';
import { useAgentStore } from '../../../stores/agentStore';
import { usePreviewStore, type FileTreeNodeData } from '../../../stores/previewStore';
import type { AgentKind } from '../../../types/session';
import { ContextDisplay } from '../../assistant-ui/context-display';
import { computeContextUsageFromEvents } from '../contextUsage';
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

const CATEGORY_ORDER = ['session', 'info', 'builtin', 'custom', 'skill'] as const;

const CATEGORY_LABELS: Record<string, string> = {
  session: '会话',
  info: '信息',
  builtin: '内置',
  custom: '自定义',
  skill: '技能',
};

const CODEMUX_FORMATTER: Unstable_DirectiveFormatter = {
  serialize: (item) => (item.type === 'file' || item.type === 'directory' ? `@${item.id} ` : `/${item.id} `),
  parse: parseComposerDirectives,
};

const MAX_FILE_RESULTS = 50;
const EMPTY_EVENTS: AgentMessage[] = [];
const TRIGGER_RE = /(^|\s)([/@])([^\s]*)$/;
const PARSE_DIRECTIVE_RE = /(^|\s)(\/[A-Za-z][\w-]*)(?=\s|$)|(@[^\s]+)/g;

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
  const events = useAgentStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);
  const contextUsage = useMemo(() => computeContextUsageFromEvents(events, {
    model: modelName,
    sessionProviderUsesLargeContext: false,
    activeProviderUsesLargeContext: false,
  }), [events, modelName]);
  const commands = useMemo(() => getAllCommands(agentKind), [agentKind]);

  const treeRoot = usePreviewStore((state) => state.treeRoot);
  const fileItemsRef = useRef<FileEntry[]>([]);
  if (projectPath && treeRoot) {
    fileItemsRef.current = flattenFileTree(treeRoot);
  } else {
    fileItemsRef.current = [];
  }

  const [manualTrigger, setManualTrigger] = useState<'/' | '@' | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const activeTrigger = useMemo(() => detectTrailingTrigger(composerText), [composerText]);
  const activeChar = activeTrigger?.char ?? manualTrigger;
  const activeQuery = activeTrigger?.query ?? '';
  const slashItemsByCategory = useMemo(() => groupCommands(commands, activeQuery), [commands, activeQuery]);
  const slashItems = useMemo(() => slashItemsByCategory.flatMap((group) => group.items), [slashItemsByCategory]);
  const fileItems = useMemo(() => {
    if (activeChar !== '@') return [];
    const items = fileItemsRef.current;
    const query = activeQuery.trim();
    if (!query) return items.slice(0, MAX_FILE_RESULTS).map(toFileTriggerItem);
    return items
      .filter((f) => matchFileName(query, f.name) || matchFileName(query, f.relativePath))
      .slice(0, MAX_FILE_RESULTS)
      .map(toFileTriggerItem);
  }, [activeChar, activeQuery, treeRoot]);
  const menuItems = activeChar === '/' ? slashItems : fileItems;
  const menuVisible = activeChar !== null && menuItems.length > 0;

  useEffect(() => {
    setHighlightedIndex(0);
  }, [activeChar, activeQuery, menuItems.length]);

  const hasInput = composerText.trim().length > 0;

  const insertSlash = () => {
    setManualTrigger('/');
    aui.composer().setText('/');
  };

  const selectTriggerItem = (item: Unstable_TriggerItem) => {
    setManualTrigger(null);
    aui.composer().setText(replaceActiveTrigger(composerText, activeTrigger, item));
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!menuVisible) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((index) => (index + 1) % menuItems.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((index) => (index - 1 + menuItems.length) % menuItems.length);
      return;
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault();
      const selected = menuItems[highlightedIndex] ?? menuItems[0];
      if (selected) selectTriggerItem(selected);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setManualTrigger(null);
    }
  };

  return (
    <div className="relative mx-auto flex w-full max-w-3xl flex-col" onKeyDownCapture={handleComposerKeyDown}>
      {menuVisible && (
        <TriggerMenu
          char={activeChar ?? '/'}
          slashGroups={slashItemsByCategory}
          fileItems={fileItems}
          highlightedIndex={highlightedIndex}
          onHighlight={setHighlightedIndex}
          onSelect={selectTriggerItem}
        />
      )}

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
              formatter={CODEMUX_FORMATTER}
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
                {contextUsage.usedTokens > 0 && (
                  <ContextDisplay
                    usedTokens={contextUsage.usedTokens}
                    totalTokens={contextUsage.totalTokens}
                    modelName={modelName}
                    inputTokens={contextUsage.inputTokens}
                    cachedTokens={contextUsage.cachedTokens}
                    outputTokens={contextUsage.outputTokens}
                  />
                )}
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
    </div>
  );
}

function TriggerMenu({
  char,
  slashGroups,
  fileItems,
  highlightedIndex,
  onHighlight,
  onSelect,
}: {
  char: '/' | '@';
  slashGroups: Array<{ category: TriggerCategory; items: Unstable_TriggerItem[] }>;
  fileItems: Unstable_TriggerItem[];
  highlightedIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (item: Unstable_TriggerItem) => void;
}) {
  let index = 0;

  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-3 max-h-[min(28rem,calc(100vh-6rem))] overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-2))]/98 shadow-[0_20px_54px_-30px_hsl(var(--foreground)/0.5)] backdrop-blur-lg">
      <div className="max-h-[inherit] overflow-y-auto py-2">
        {char === '/' ? (
          slashGroups.map((group) => (
            <div key={group.category.id}>
              <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-normal text-muted-foreground/60">
                {getCategoryIcon(group.category.id)}
                <span>{group.category.label}</span>
              </div>
              {group.items.map((item) => {
                const itemIndex = index++;
                return (
                  <TriggerMenuItem
                    key={item.id}
                    item={item}
                    index={itemIndex}
                    highlighted={itemIndex === highlightedIndex}
                    onHighlight={onHighlight}
                    onSelect={onSelect}
                  />
                );
              })}
            </div>
          ))
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 pb-1.5 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
              <FileCode2 className="h-3.5 w-3.5" />
              <span>引用文件</span>
            </div>
            {fileItems.map((item, itemIndex) => (
              <TriggerMenuItem
                key={item.id}
                item={item}
                index={itemIndex}
                highlighted={itemIndex === highlightedIndex}
                onHighlight={onHighlight}
                onSelect={onSelect}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function TriggerMenuItem({
  item,
  index,
  highlighted,
  onHighlight,
  onSelect,
}: {
  item: Unstable_TriggerItem;
  index: number;
  highlighted: boolean;
  onHighlight: (index: number) => void;
  onSelect: (item: Unstable_TriggerItem) => void;
}) {
  const isFile = item.type === 'file' || item.type === 'directory';

  return (
    <button
      type="button"
      data-command-id={item.type === 'command' ? item.id : undefined}
      data-file-id={isFile ? item.id : undefined}
      onMouseEnter={() => onHighlight(index)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(item)}
      className={cn(
        'flex w-full items-start gap-3 px-3 py-2 text-left transition-colors',
        highlighted ? 'bg-muted/56' : 'hover:bg-muted/46',
      )}
    >
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted/74 text-muted-foreground">
        {isFile ? (item.type === 'directory' ? <Folder className="h-4 w-4" /> : <FileCode2 className="h-4 w-4" />) : getCommandIcon(item.id)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {item.label}
          </span>
          {getItemArgsHint(item) && <span className="shrink-0 text-xs text-muted-foreground">{getItemArgsHint(item)}</span>}
        </div>
        {item.description && <div className="truncate text-xs text-muted-foreground">{item.description}</div>}
      </div>
    </button>
  );
}

function groupCommands(commands: SlashCommand[], query: string) {
  const q = query.trim().toLowerCase();
  return CATEGORY_ORDER.map((category) => ({
    category: { id: category, label: CATEGORY_LABELS[category] },
    items: commands.filter((command) => command.category === category && matchesCommand(command, q)).map(toTriggerItem),
  })).filter((group) => group.items.length > 0);
}

type ActiveTrigger = { char: '/' | '@'; start: number; query: string };

function detectTrailingTrigger(text: string): ActiveTrigger | null {
  const match = text.match(TRIGGER_RE);
  if (!match || (match[2] !== '/' && match[2] !== '@')) return null;
  return {
    char: match[2],
    start: (match.index ?? 0) + (match[1]?.length ?? 0),
    query: match[3] ?? '',
  };
}

function replaceActiveTrigger(text: string, active: ActiveTrigger | null, item: Unstable_TriggerItem) {
  const directive = CODEMUX_FORMATTER.serialize(item);
  if (!active) return directive;
  return `${text.slice(0, active.start)}${directive}`;
}

function parseComposerDirectives(text: string): Unstable_DirectiveSegment[] {
  const segments: Unstable_DirectiveSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(PARSE_DIRECTIVE_RE)) {
    const leading = match[1] ?? '';
    const raw = match[2] || match[3] || '';
    const start = match.index + leading.length;
    if (start > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, start) });
    }
    segments.push(toDirectiveMention(raw));
    lastIndex = start + raw.length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) });
  }

  return segments;
}

function toDirectiveMention(raw: string): Unstable_DirectiveSegment {
  if (raw.startsWith('/')) {
    return { kind: 'mention', type: 'command', label: raw, id: raw.slice(1) };
  }

  const id = raw.slice(1);
  return {
    kind: 'mention',
    type: id.endsWith('/') ? 'directory' : 'file',
    label: getPathLabel(id),
    id,
  };
}

function getPathLabel(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').filter(Boolean).pop() || path;
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
