import {
  AttachmentPrimitive,
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
  FilePlus2,
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
  Plus,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FC, type KeyboardEvent, type ReactNode } from 'react';

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
import { ImageAttachmentPreview } from './ImageAttachmentPreview';

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const composerText = useAuiState((state) => state.composer.text);
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
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

  const hasInput = composerText.trim().length > 0 || attachmentCount > 0;

  const insertSlash = () => {
    setManualTrigger('/');
    setAddMenuOpen(false);
    aui.composer().setText('/');
  };

  const openFilePicker = () => {
    setAddMenuOpen(false);
    fileInputRef.current?.click();
  };

  const addSelectedFiles = async (files: File[]) => {
    await addFilesToComposer(files, {
      addAttachment: (file) => aui.composer().addAttachment(file),
      insertReference: (reference) => aui.composer().setText(appendComposerReference(composerText, reference)),
      projectPath,
      fileItems: fileItemsRef.current,
    });
  };

  const handleFileSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    await addSelectedFiles(files);
  };

  const handleComposerPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void addSelectedFiles(files);
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
        <ComposerPrimitive.AttachmentDropzone className="relative flex w-full flex-col">
          <div
            ref={composerRootRef}
            onFocusCapture={() => setIsFocused(true)}
            onBlurCapture={() => {
              requestAnimationFrame(() => {
                setIsFocused(composerRootRef.current?.contains(document.activeElement) ?? false);
              });
            }}
            className={cn(
              'aui-composer-root flex w-full flex-col gap-2 overflow-visible rounded-2xl border p-2.5 transition-all duration-200',
              isFocused
                ? 'border-[hsl(var(--primary)/0.38)] bg-[hsl(var(--surface-1))]/98 shadow-[0_18px_42px_-30px_hsl(var(--primary)/0.36),inset_0_1px_0_hsl(var(--foreground)/0.035)]'
                : 'border-border/82 bg-[hsl(var(--surface-1))]/94 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.026)]',
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple
              onChange={(event) => void handleFileSelection(event)}
            />
            <ComposerPrimitive.Attachments>
              {() => <ComposerAttachmentPreview />}
            </ComposerPrimitive.Attachments>
            <LexicalComposerInput
              submitMode="enter"
              placeholder={placeholder}
              directiveChip={DIRECTIVE_CHIP}
              formatter={CODEMUX_FORMATTER}
              onPaste={handleComposerPaste}
              className="relative min-h-10 max-h-50 w-full overflow-y-auto text-sm leading-6 text-foreground outline-none [&_.aui-lexical-input]:min-h-10 [&_.aui-lexical-input]:max-h-50 [&_.aui-lexical-input]:overflow-y-auto [&_.aui-lexical-input]:border-0 [&_.aui-lexical-input]:bg-transparent [&_.aui-lexical-input]:px-2 [&_.aui-lexical-input]:py-1 [&_.aui-lexical-input]:text-sm [&_.aui-lexical-input]:leading-6 [&_.aui-lexical-input]:text-foreground [&_.aui-lexical-input]:shadow-none [&_.aui-lexical-input]:outline-none [&_.aui-lexical-input]:ring-0 [&_.aui-lexical-input]:focus-visible:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:left-2 [&_.aui-lexical-placeholder]:top-1 [&_.aui-lexical-placeholder]:text-sm [&_.aui-lexical-placeholder]:leading-6 [&_.aui-lexical-placeholder]:text-muted-foreground/70"
            />

            <div className="relative flex items-center justify-between pl-1">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setAddMenuOpen((value) => !value)}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/40 bg-[hsl(var(--surface-2))]/70 text-muted-foreground/76 transition-all duration-200 hover:bg-muted/58 hover:text-foreground"
                    title="添加附件或功能"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  {addMenuOpen ? (
                    <AddMenu
                      onSelectFile={openFilePicker}
                      onClose={() => setAddMenuOpen(false)}
                    />
                  ) : null}
                </div>
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
        </ComposerPrimitive.AttachmentDropzone>
        </ComposerPrimitive.Root>
    </div>
  );
}

function ComposerAttachmentPreview() {
  const attachment = useAuiState((state) => state.attachment);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const imagePart = attachment?.content?.find((part): part is { type: 'image'; image: string } =>
    part.type === 'image' && typeof (part as { image?: unknown }).image === 'string',
  );
  const imageSrc = imagePart?.image ?? objectUrl;

  useEffect(() => {
    if (!attachment?.file || !attachment.type.startsWith('image')) {
      setObjectUrl(null);
      return;
    }

    const nextUrl = URL.createObjectURL(attachment.file);
    setObjectUrl(nextUrl);

    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [attachment?.file, attachment?.type]);

  return (
    <AttachmentPrimitive.Root className="mb-1.5 flex flex-wrap gap-2">
      <div className="group relative flex h-18 w-18">
        {imageSrc ? (
          <ImageAttachmentPreview
            src={imageSrc}
            alt={attachment?.name ?? 'Attachment'}
            thumbnailClassName="h-18 w-18"
          />
        ) : (
          <div className="flex h-18 w-18 overflow-hidden rounded-lg border border-border/70 bg-[hsl(var(--surface-2))] shadow-[0_8px_22px_-18px_hsl(var(--foreground)/0.45)]">
            <AttachmentPrimitive.unstable_Thumb className="flex h-full w-full items-center justify-center text-xs text-muted-foreground" />
          </div>
        )}
        <AttachmentPrimitive.Remove
          className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-background/92 text-muted-foreground opacity-100 shadow-sm ring-1 ring-border/50 transition-colors hover:text-foreground"
          title="移除附件"
        >
          <X className="h-3.5 w-3.5" />
        </AttachmentPrimitive.Remove>
      </div>
    </AttachmentPrimitive.Root>
  );
}

function AddMenu({
  onSelectFile,
  onClose,
}: {
  onSelectFile: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute bottom-full left-0 z-50 mb-2 w-44 overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-2))]/98 p-1 shadow-[0_18px_46px_-28px_hsl(var(--foreground)/0.48)] backdrop-blur-lg">
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onSelectFile}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted/56"
      >
        <FilePlus2 className="h-4 w-4 text-muted-foreground" />
        <span>选择文件</span>
      </button>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClose}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/46 hover:text-foreground"
      >
        <ListTodo className="h-4 w-4" />
        <span>计划模式</span>
      </button>
    </div>
  );
}

type AddFilesOptions = {
  addAttachment: (file: File) => Promise<unknown>;
  insertReference: (reference: string) => void;
  projectPath?: string | null;
  fileItems: FileEntry[];
};

async function addFilesToComposer(files: File[], options: AddFilesOptions): Promise<void> {
  for (const file of files) {
    const imageFile = normalizeImageFile(file);
    if (imageFile) {
      await options.addAttachment(imageFile);
      continue;
    }

    const reference = getProjectRelativeReference(file, options.projectPath, options.fileItems);
    if (reference) {
      options.insertReference(reference);
    }
  }
}

function normalizeImageFile(file: File): File | null {
  if (file.type.startsWith('image/')) {
    return file;
  }

  const mediaType = inferImageMediaType(file.name);
  if (!mediaType) {
    return null;
  }

  return new File([file], file.name, {
    type: mediaType,
    lastModified: file.lastModified,
  });
}

function inferImageMediaType(name: string): string | null {
  const extension = name.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'apng':
      return 'image/apng';
    case 'avif':
      return 'image/avif';
    case 'gif':
      return 'image/gif';
    case 'jpg':
    case 'jpeg':
    case 'jfif':
    case 'pjpeg':
    case 'pjp':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

function getProjectRelativeReference(file: File, projectPath: string | null | undefined, fileItems: FileEntry[]): string | null {
  const webkitRelativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  const candidate = normalizeReferencePath(webkitRelativePath || file.name);
  if (fileItems.some((item) => normalizeReferencePath(item.relativePath) === candidate)) {
    return candidate;
  }

  if (!projectPath) {
    return null;
  }

  return fileItems.find((item) => item.name === file.name)?.relativePath ?? null;
}

function appendComposerReference(text: string, reference: string): string {
  const prefix = text.length === 0 || /\s$/.test(text) ? text : `${text} `;
  return `${prefix}@${reference} `;
}

function normalizeReferencePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
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
