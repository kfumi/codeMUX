import {
  AttachmentPrimitive,
  ComposerPrimitive,
  useAui,
  useAuiState,
  type Unstable_DirectiveFormatter,
  type Unstable_DirectiveSegment,
  type Unstable_TriggerItem,
} from '@assistant-ui/react';
import type { DirectiveChipProps } from '@assistant-ui/react-lexical';
import {
  ArrowUp,
  Check,
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
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FC, type KeyboardEvent, type ReactNode } from 'react';

import type { AgentMessage } from '../../../stores/agentStore';
import type { SlashCommand } from '../../../lib/slashCommands';
import { findCommand, getAllCommands } from '../../../lib/slashCommands';
import { createLogger, serializeError } from '../../../lib/logger';
import { cn } from '../../../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Tooltip, TooltipContent, TooltipHint, TooltipProvider, TooltipTrigger } from '../../ui/tooltip';
import { useAgentStore } from '../../../stores/agentStore';
import { usePreviewStore, type FileTreeNodeData } from '../../../stores/previewStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { mapExecutionModeToPermissionConfig } from '../../../lib/agentPermissions';
import type { AgentKind } from '../../../types/session';
import { ContextDisplay } from '../../assistant-ui/context-display';
import { buildContextUsageViewModel } from '../contextUsage';
import { AskUserQuestionCard, type AskUserQuestion } from '../AskUserQuestionCard';
import { CodeMuxDirectiveChip, type CodeMuxDirectiveKind } from './CodeMuxDirectiveText';
import {
  CodeMuxLexicalComposerInput,
  type CodeMuxLexicalComposerInputHandle,
} from './CodeMuxLexicalComposerInput';
import { ImageAttachmentPreview } from './ImageAttachmentPreview';
import { parseProposedPlan, getProposedPlanTitle } from './proposedPlan';

interface CodeMuxComposerProps {
  sessionId: string;
  agentKind?: AgentKind;
  projectPath?: string | null;
  modelName?: string;
  placeholder?: string;
  modelSelector?: ReactNode;
  permissionSelector?: ReactNode;
  disabled?: boolean;
  onStop?: () => void | Promise<void>;
  onActivatePlanMode?: () => void;
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

export function createCodeMuxFormatter(agentKind: AgentKind = 'claude_code'): Unstable_DirectiveFormatter {
  return {
    serialize: (item) => {
      if (item.type === 'file' || item.type === 'directory') {
        const label = getPathLabel(item.id);
        return `[${label}](${item.id}) `;
      }

      const metadata = item.metadata ?? {};
      const command = item.type === 'command' ? findCommand(item.id, agentKind) : undefined;
      const filePath = typeof metadata.filePath === 'string' && metadata.filePath
        ? metadata.filePath
        : command?.filePath ?? '';
      const category = metadata.category ?? command?.category;
      const itemAgentKind = metadata.agentKind ?? agentKind;
      const path = category === 'skill'
        ? itemAgentKind === 'codex' && filePath
          ? appendSkillFilePath(filePath)
          : item.id
        : filePath || item.id;
      return '[$' + item.id + '](' + path + ') ';
    },
    parse: parseComposerDirectives,
  };
}

export const CODEMUX_FORMATTER = createCodeMuxFormatter();

const MAX_FILE_RESULTS = 50;
const EMPTY_EVENTS: AgentMessage[] = [];
const TRIGGER_RE = /(^|\s)([/@])([^\s]*)(?=\s|$)/g;
const PARSE_DIRECTIVE_RE = /(^|\s)(\/[A-Za-z][\w:-]*)(?=\s|$)|(^|\s)(@(?![A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s]+)|(^|\s)(\[[^\]]+\]\([^)]+\))/g;
const logger = createLogger('CodeMuxComposer');

type FileEntry = { name: string; relativePath: string; isDir: boolean };
type PendingUserQuestion = {
  toolUseId: string;
  questions: AskUserQuestion[];
};

type PendingProposedPlan = {
  key: string;
  title: string;
};

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

export const DIRECTIVE_CHIP: FC<DirectiveChipProps> = DirectiveChip;

export function CodeMuxComposer({
  sessionId,
  agentKind = 'claude_code',
  projectPath,
  modelName,
  placeholder = '输入消息... (@ 引用文件, / 命令)',
  modelSelector,
  permissionSelector,
  disabled = false,
  onStop,
  onActivatePlanMode,
}: CodeMuxComposerProps) {
  const aui = useAui();
  const composerRootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<CodeMuxLexicalComposerInputHandle>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Local text state maintained by the Lexical editor; avoids per-keystroke
  // sync to the runtime composer which caused long-text input jank.
  const [composerText, setComposerText] = useState('');
  const cursorOffsetRef = useRef<number>(0);
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const events = useAgentStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);
  const tokenUsage = useAgentStore((state) => state.tokenUsageBySession[sessionId] ?? null);
  const updateSessionPermissions = useSessionStore((state) => state.updateSessionPermissions);
  const [dismissedQuestionIds, setDismissedQuestionIds] = useState<Set<string>>(() => new Set());
  const [dismissedPlanKeys, setDismissedPlanKeys] = useState<Set<string>>(() => new Set());
  const contextUsage = useMemo(() => buildContextUsageViewModel({
    tokenUsage,
    model: modelName,
    sessionProviderUsesLargeContext: false,
    activeProviderUsesLargeContext: false,
  }), [tokenUsage, modelName]);
  const commands = useMemo(() => getAllCommands(agentKind), [agentKind]);
  const formatter = useMemo(() => createCodeMuxFormatter(agentKind), [agentKind]);

  const treeRoot = usePreviewStore((state) => state.treeRoot);
  // Flatten the file tree once per tree change instead of every render.
  const allFileEntries = useMemo(
    () => (projectPath && treeRoot ? flattenFileTree(treeRoot) : []),
    [projectPath, treeRoot],
  );

  const [manualTrigger, setManualTrigger] = useState<'/' | '@' | null>(null);
  const [suppressedTrigger, setSuppressedTrigger] = useState<ActiveTrigger | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const handleTextChange = useCallback((text: string) => {
    setComposerText(text);
  }, []);

  const handleCursorChange = useCallback((offset: number) => {
    cursorOffsetRef.current = offset;
  }, []);

  const activeTrigger = useMemo(() => {
    const trigger = detectActiveTrigger(composerText, cursorOffsetRef.current);
    if (!trigger || isSameTrigger(trigger, suppressedTrigger)) {
      return null;
    }
    return isCompletedTrigger(trigger, commands, allFileEntries) ? null : trigger;
  }, [allFileEntries, commands, composerText, suppressedTrigger]);
  const activeChar = activeTrigger?.char ?? manualTrigger;
  const activeQuery = activeTrigger?.query ?? '';
  const slashItemsByCategory = useMemo(() => groupCommands(commands, activeQuery, agentKind), [commands, activeQuery, agentKind]);
  const slashItems = useMemo(() => slashItemsByCategory.flatMap((group) => group.items), [slashItemsByCategory]);
  const pendingQuestion = useMemo(
    () => findLatestPendingUserQuestion(events, dismissedQuestionIds),
    [dismissedQuestionIds, events],
  );
  const pendingPlan = useMemo(
    () => findLatestPendingProposedPlan(events, dismissedPlanKeys),
    [dismissedPlanKeys, events],
  );
  const fileItems = useMemo(() => {
    if (activeChar !== '@') return [];
    const items = allFileEntries;
    const query = activeQuery.trim();
    if (!query) return items.slice(0, MAX_FILE_RESULTS).map(toFileTriggerItem);
    return items
      .filter((f) => matchFileName(query, f.name) || matchFileName(query, f.relativePath))
      .slice(0, MAX_FILE_RESULTS)
      .map(toFileTriggerItem);
  }, [activeChar, activeQuery, allFileEntries]);
  const menuItems = activeChar === '/' ? slashItems : fileItems;
  const menuVisible = activeChar !== null && !pendingQuestion && !pendingPlan;

  useEffect(() => {
    setHighlightedIndex(0);
  }, [activeChar, activeQuery, menuItems.length]);

  const fileTreeLoading = usePreviewStore((s) => s.fileTreeLoading);
  const loadFileTree = usePreviewStore((s) => s.loadFileTree);
  useEffect(() => {
    if (activeChar === '@' && projectPath && treeRoot === null && !fileTreeLoading) {
      loadFileTree(projectPath);
    }
  }, [activeChar, projectPath, treeRoot, fileTreeLoading, loadFileTree]);

  useEffect(() => {
    if (!menuVisible) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && composerRootRef.current?.contains(target)) {
        return;
      }

      setManualTrigger(null);
      setSuppressedTrigger((current) => activeTrigger ?? current);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [activeTrigger, menuVisible]);

  const hasInput = composerText.trim().length > 0 || attachmentCount > 0;

  // Save composer draft on text change (debounced)
  const saveComposerDraft = useAgentStore((s) => s.saveComposerDraft);
  const draftTextRef = useRef(composerText);
  draftTextRef.current = composerText;
  useEffect(() => {
    const timer = setTimeout(() => {
      saveComposerDraft(sessionId, composerText.trim());
    }, 500);
    return () => {
      clearTimeout(timer);
      // Save immediately on unmount
      saveComposerDraft(sessionId, draftTextRef.current.trim());
    };
  }, [composerText, sessionId, saveComposerDraft]);

  // Restore draft on mount
  const getComposerDraft = useAgentStore((s) => s.getComposerDraft);
  const consumeComposerDraft = useAgentStore((s) => s.consumeComposerDraft);
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const draft = getComposerDraft(sessionId);
    if (draft) {
      // Delay to ensure Lexical editor is ready
      setTimeout(() => {
        editorRef.current?.setText(draft);
        // Clear draft after successful restore
        consumeComposerDraft(sessionId);
      }, 150);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setDismissedQuestionIds(new Set());
    setDismissedPlanKeys(new Set());
  }, [sessionId]);

  useEffect(() => {
    setDismissedQuestionIds((current) => {
      const answeredIds = collectAnsweredToolUseIds(events);
      if (answeredIds.size === 0) return current;
      const next = new Set(current);
      let changed = false;
      for (const id of answeredIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [events]);


  const openFilePicker = () => {
    setAddMenuOpen(false);
    fileInputRef.current?.click();
  };

  const addSelectedFiles = async (files: File[]) => {
    const currentText = editorRef.current?.getText() ?? composerText;
    await addFilesToComposer(files, {
      addAttachment: (file) => aui.composer().addAttachment(file),
      insertReference: (reference) => editorRef.current?.setText(appendComposerReference(currentText, reference)),
      projectPath,
      fileItems: allFileEntries,
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
    const nextText = replaceActiveTrigger(composerText, activeTrigger, item, formatter);
    setManualTrigger(null);
    setSuppressedTrigger(getSelectedTrigger(activeTrigger, item));
    editorRef.current?.setText(nextText);
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!menuVisible) return;
    if (menuItems.length === 0) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setManualTrigger(null);
        setSuppressedTrigger((current) => activeTrigger ?? current);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      setHighlightedIndex((index) => (index + 1) % menuItems.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      setHighlightedIndex((index) => (index - 1 + menuItems.length) % menuItems.length);
      return;
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      const selected = menuItems[highlightedIndex] ?? menuItems[0];
      if (selected) selectTriggerItem(selected);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setManualTrigger(null);
      setSuppressedTrigger((current) => activeTrigger ?? current);
    }
  };

  return (
    <div ref={composerRootRef} className="relative mx-auto flex w-full flex-col" style={{ maxWidth: 'var(--content-width, 52rem)' }} onKeyDownCapture={handleComposerKeyDown}>
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
            <div className="mb-1.5 flex flex-wrap gap-2" data-testid="composer-attachment-list">
              <ComposerPrimitive.Attachments>
                {() => <ComposerAttachmentPreview />}
              </ComposerPrimitive.Attachments>
            </div>
            {pendingQuestion ? (
              <AskUserQuestionCard
                key={pendingQuestion.toolUseId}
                sessionId={sessionId}
                toolUseId={pendingQuestion.toolUseId}
                questions={pendingQuestion.questions}
                variant="composer"
                onSubmitted={() => {
                  setDismissedQuestionIds((current) => new Set(current).add(pendingQuestion.toolUseId));
                }}
              />
            ) : pendingPlan ? (
              <ProposedPlanApprovalCard
                title={pendingPlan.title}
                onSubmit={async (content, approved) => {
                  try {
                    if (approved) {
                      await updateSessionPermissions(
                        sessionId,
                        mapExecutionModeToPermissionConfig(agentKind, 'full_access'),
                        'off',
                      );
                    }
                    setDismissedPlanKeys((current) => new Set(current).add(pendingPlan.key));
                    aui.composer().setText(content);
                    aui.composer().send();
                  } catch (err) {
                    logger.error('Failed to approve proposed plan', { sessionId, approved }, serializeError(err));
                    throw err;
                  }
                }}
                onDismiss={() => {
                  setDismissedPlanKeys((current) => new Set(current).add(pendingPlan.key));
                }}
              />
            ) : (
              <CodeMuxLexicalComposerInput
                ref={editorRef}
                submitMode="enter"
                placeholder={placeholder}
                directiveChip={DIRECTIVE_CHIP}
                formatter={formatter}
                onPaste={handleComposerPaste}
                onTextChange={handleTextChange}
                onCursorChange={handleCursorChange}
                className="relative min-h-10 max-h-50 w-full overflow-y-auto text-sm leading-6 text-foreground outline-none [&_.aui-lexical-input]:min-h-10 [&_.aui-lexical-input]:max-h-50 [&_.aui-lexical-input]:overflow-y-auto [&_.aui-lexical-input]:border-0 [&_.aui-lexical-input]:bg-transparent [&_.aui-lexical-input]:px-2 [&_.aui-lexical-input]:py-1 [&_.aui-lexical-input]:text-sm [&_.aui-lexical-input]:leading-6 [&_.aui-lexical-input]:text-foreground [&_.aui-lexical-input]:shadow-none [&_.aui-lexical-input]:outline-none [&_.aui-lexical-input]:ring-0 [&_.aui-lexical-input]:focus-visible:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:left-2 [&_.aui-lexical-placeholder]:top-1 [&_.aui-lexical-placeholder]:text-sm [&_.aui-lexical-placeholder]:leading-6 [&_.aui-lexical-placeholder]:text-muted-foreground/70"
              />
            )}

            {!pendingQuestion && !pendingPlan && <div className="relative flex items-center justify-between pl-1">
              <div className="flex items-center gap-2">
                <Popover open={addMenuOpen} onOpenChange={setAddMenuOpen}>
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            disabled={disabled}
                            aria-label="添加附件或功能"
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/40 bg-[hsl(var(--surface-2))]/70 text-muted-foreground/76 transition-all duration-200 hover:bg-muted/58 hover:text-foreground"
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent>添加附件或功能</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                <PopoverContent
                  side="top"
                  sideOffset={8}
                  align="start"
                  className="w-44 overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-2))]/98 p-1 shadow-[0_18px_46px_-28px_hsl(var(--surface-shadow-strong)/0.48)] backdrop-blur-lg"
                >
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => { openFilePicker(); }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted/56"
                  >
                    <FilePlus2 className="h-4 w-4 text-muted-foreground" />
                    <span>选择文件</span>
                  </button>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => { onActivatePlanMode?.(); setAddMenuOpen(false); }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/46 hover:text-foreground"
                  >
                    <ListTodo className="h-4 w-4" />
                    <span>计划模式</span>
                  </button>
                </PopoverContent>
              </Popover>
                {permissionSelector}
              </div>
              <div className="flex items-center gap-2">
                {contextUsage ? (
                  <ContextDisplay
                    usedTokens={contextUsage.usedTokens}
                    totalTokens={contextUsage.totalTokens}
                    modelName={modelName}
                    inputTokens={contextUsage.inputTokens}
                    cachedTokens={contextUsage.cachedTokens}
                    outputTokens={contextUsage.outputTokens}
                  />
                ) : null}
                {modelSelector ?? (
                  <span className="max-w-54 truncate rounded-full border border-border/45 bg-[hsl(var(--surface-2))]/64 px-2.5 py-1 text-[11px] text-muted-foreground/74">
                    {modelName ?? ''}
                  </span>
                )}
                {isRunning ? (
                  <TooltipHint content="停止">
                    <button
                      type="button"
                      onClick={() => void onStop?.()}
                      aria-label="停止"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--destructive)/0.12)] text-[hsl(var(--destructive))] transition-all duration-200 hover:scale-105 hover:bg-[hsl(var(--destructive)/0.18)] active:scale-95"
                    >
                      <Square className="h-3.5 w-3.5" fill="currentColor" />
                    </button>
                  </TooltipHint>
                ) : (
                  <TooltipHint content="发送">
                    <button
                      type="button"
                      onClick={() => {
                        if (!disabled && hasInput) {
                          editorRef.current?.send();
                        }
                      }}
                      disabled={disabled || !hasInput}
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-all duration-200 active:scale-95',
                        hasInput && !disabled
                          ? 'bg-primary text-primary-foreground shadow-[0_10px_24px_-15px_hsl(var(--primary)/0.58)] hover:bg-primary/94'
                          : 'cursor-not-allowed bg-[hsl(var(--surface-3))] text-muted-foreground/42',
                      )}
                      aria-label="发送"
                    >
                      <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                    </button>
                  </TooltipHint>
                )}
              </div>
            </div>}
          </div>
        </ComposerPrimitive.AttachmentDropzone>
        </ComposerPrimitive.Root>
    </div>
  );
}

function ProposedPlanApprovalCard({
  title,
  onSubmit,
  onDismiss,
}: {
  title: string;
  onSubmit: (content: string, approved: boolean) => void | Promise<void>;
  onDismiss: () => void;
}) {
  const [mode, setMode] = useState<'approve' | 'adjust'>('approve');
  const [adjustment, setAdjustment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const content = mode === 'approve' ? '是，实施此计划' : adjustment.trim();
  const canSubmit = content.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(content, mode === 'approve');
    } catch {
      setError('权限切换失败，计划尚未发送。请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-2xl bg-[hsl(var(--surface-2))]/66 p-3">
      <div>
        <p className="px-1 text-[13px] font-semibold text-foreground">实施此计划？</p>
        <p className="mt-0.5 line-clamp-1 px-1 text-xs text-muted-foreground/70">{title}</p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/18 bg-[hsl(var(--surface-3))]/22">
        <button
          type="button"
          onClick={() => {
            if (submitting) return;
            setMode('approve');
            setError(null);
          }}
          disabled={submitting}
          className={cn(
            'flex w-full items-center gap-2 border-b border-border/12 px-3 py-2 text-left text-sm transition-colors',
            mode === 'approve' ? 'bg-muted/62 text-foreground' : 'text-muted-foreground hover:bg-muted/42 hover:text-foreground',
            submitting && 'cursor-wait opacity-70',
          )}
        >
          <span className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
            mode === 'approve' ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground/30 text-muted-foreground',
          )}>
            1
          </span>
          <span className="font-medium">是，实施此计划</span>
        </button>
        <button
          type="button"
          onClick={() => {
            if (submitting) return;
            setMode('adjust');
            setError(null);
          }}
          disabled={submitting}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
            mode === 'adjust' ? 'bg-muted/62 text-foreground' : 'text-muted-foreground hover:bg-muted/42 hover:text-foreground',
            submitting && 'cursor-wait opacity-70',
          )}
        >
          <span className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
            mode === 'adjust' ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground/30 text-muted-foreground',
          )}>
            2
          </span>
          <span className="font-medium">否，请告知 Codex 如何调整</span>
        </button>
        {mode === 'adjust' ? (
          <div className="border-t border-border/12 p-2">
            <input
              value={adjustment}
              onChange={(event) => {
                setAdjustment(event.target.value);
                setError(null);
              }}
              placeholder="告诉 Codex 需要怎样调整计划..."
              autoFocus
              disabled={submitting}
              className="w-full rounded-md border border-border/35 bg-background/80 px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/55 focus:border-primary/45"
            />
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="px-1 text-xs text-destructive">{error}</p>
      ) : null}
      <div className="flex items-center justify-end gap-2 px-1">
        <button
          type="button"
          onClick={onDismiss}
          disabled={submitting}
          className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/46 hover:text-foreground"
        >
          忽略
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
            canSubmit
              ? 'bg-primary text-primary-foreground hover:bg-primary/92'
              : 'cursor-not-allowed bg-muted/40 text-muted-foreground',
          )}
        >
          <span>{submitting ? '提交中...' : '提交'}</span>
          <Check className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function findLatestPendingUserQuestion(events: AgentMessage[], dismissedIds: Set<string>): PendingUserQuestion | null {
  const answeredIds = collectAnsweredToolUseIds(events);
  const expiredIds = collectExpiredQuestionIds(events);

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'user') {
      return null;
    }
    if (event.kind !== 'ask_user_question') {
      continue;
    }

    const toolUseId = event.data.tool_use_id;
    if (answeredIds.has(toolUseId) || expiredIds.has(toolUseId) || dismissedIds.has(toolUseId)) {
      continue;
    }

    return {
      toolUseId,
      questions: event.data.questions,
    };
  }

  return null;
}

function collectExpiredQuestionIds(events: AgentMessage[]): Set<string> {
  const ids = new Set<string>();

  for (const event of events) {
    if (event.kind === 'ask_user_question_timeout') {
      ids.add(event.data.tool_use_id);
    }
  }

  return ids;
}

export function findLatestPendingProposedPlan(events: AgentMessage[], dismissedKeys: Set<string>): PendingProposedPlan | null {
  let hasResultAfterAssistant = false;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'user') {
      return null;
    }
    if (event.kind === 'result') {
      hasResultAfterAssistant = true;
      continue;
    }
    if (event.kind !== 'assistant' || !hasResultAfterAssistant) {
      continue;
    }

    const text = getAssistantText(event);
    const parsed = parseProposedPlan(text);
    if (!parsed) {
      return null;
    }

    const key = `${index}:${parsed.planMarkdown}`;
    if (dismissedKeys.has(key)) {
      return null;
    }

    return {
      key,
      title: getProposedPlanTitle(parsed.planMarkdown),
    };
  }

  return null;
}

function getAssistantText(event: Extract<AgentMessage, { kind: 'assistant' }>): string {
  return event.data.message.content
    .filter((block): block is { type: 'text'; text: string } =>
      block?.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

function collectAnsweredToolUseIds(events: AgentMessage[]): Set<string> {
  const ids = new Set<string>();

  for (const event of events) {
    if (event.kind !== 'tool_result') {
      continue;
    }

    const message = (event.data as unknown as { message?: { content?: unknown[] } }).message;
    for (const part of message?.content ?? []) {
      if (isToolResultPart(part)) {
        ids.add(part.tool_use_id);
      }
    }
  }

  return ids;
}

function isToolResultPart(value: unknown): value is { type: 'tool_result'; tool_use_id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'tool_result' &&
    typeof (value as { tool_use_id?: unknown }).tool_use_id === 'string'
  );
}

export function ComposerAttachmentPreview() {
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
    <AttachmentPrimitive.Root className="flex">
      <div className="group relative flex h-18 w-18">
        {imageSrc ? (
          <ImageAttachmentPreview
            src={imageSrc}
            alt={attachment?.name ?? 'Attachment'}
            thumbnailClassName="h-18 w-18"
          />
        ) : (
          <div className="flex h-18 w-18 overflow-hidden rounded-lg border border-border/70 bg-[hsl(var(--surface-2))] shadow-[0_8px_22px_-18px_hsl(var(--surface-shadow-strong)/0.45)]">
            <AttachmentPrimitive.unstable_Thumb className="flex h-full w-full items-center justify-center text-xs text-muted-foreground" />
          </div>
        )}
        <TooltipHint content="移除附件">
          <AttachmentPrimitive.Remove
            className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-background/92 text-muted-foreground opacity-100 shadow-sm ring-1 ring-border/50 transition-colors hover:text-foreground"
            aria-label="移除附件"
          >
            <X className="h-3.5 w-3.5" />
          </AttachmentPrimitive.Remove>
        </TooltipHint>
      </div>
    </AttachmentPrimitive.Root>
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
  const label = getPathLabel(reference);
  return `${prefix}[${label}](${reference}) `;
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
  const totalItems = char === '/' ? slashGroups.reduce((sum, g) => sum + g.items.length, 0) : fileItems.length;
  let index = 0;

  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-3 max-h-[min(28rem,calc(100vh-6rem))] overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-2))]/98 shadow-[0_20px_54px_-30px_hsl(var(--surface-shadow-strong)/0.5)] backdrop-blur-lg">
      <div className="max-h-[inherit] overflow-y-auto py-2">
        {totalItems === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground/60">
            {char === '/' ? '没有匹配的命令' : '没有匹配的文件'}
          </div>
        ) : char === '/' ? (
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

function groupCommands(commands: SlashCommand[], query: string, agentKind: AgentKind) {
  const q = query.trim().toLowerCase();
  return CATEGORY_ORDER.map((category) => ({
    category: { id: category, label: CATEGORY_LABELS[category] },
    items: commands
      .filter((command) => command.category === category && matchesCommand(command, q))
      .map((command) => toTriggerItem(command, agentKind)),
  })).filter((group) => group.items.length > 0);
}

type ActiveTrigger = { char: '/' | '@'; start: number; query: string };

function detectActiveTrigger(text: string, cursorOffset: number): ActiveTrigger | null {
  for (const m of text.matchAll(TRIGGER_RE)) {
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    const query = m[3] ?? '';
    // Only consider the trigger if the cursor is within the query range
    // (after the trigger char, at or before the end of the query).
    if (cursorOffset < start + 1 || cursorOffset > start + 1 + query.length) {
      continue;
    }
    if (m[2] !== '/' && m[2] !== '@') return null;
    return {
      char: m[2],
      start,
      query,
    };
  }
  return null;
}

function isSameTrigger(a: ActiveTrigger, b: ActiveTrigger | null) {
  return b !== null && a.char === b.char && a.start === b.start && a.query === b.query;
}

function getSelectedTrigger(active: ActiveTrigger | null, item: Unstable_TriggerItem): ActiveTrigger {
  const isFile = item.type === 'file' || item.type === 'directory';
  return {
    char: isFile ? '@' : '/',
    start: active?.start ?? 0,
    query: item.id,
  };
}

function isCompletedTrigger(trigger: ActiveTrigger, commands: SlashCommand[], files: FileEntry[]): boolean {
  if (!trigger.query) {
    return false;
  }

  if (trigger.char === '/') {
    return commands.some((command) => command.name === trigger.query);
  }

  return files.some((file) => file.relativePath === trigger.query || file.name === trigger.query);
}

function replaceActiveTrigger(
  text: string,
  active: ActiveTrigger | null,
  item: Unstable_TriggerItem,
  formatter: Unstable_DirectiveFormatter,
) {
  const directive = formatter.serialize(item);
  if (!active) return directive;
  const end = active.start + active.char.length + active.query.length;
  const suffix = text.slice(end).replace(/^[ \t]+/, '');
  return `${text.slice(0, active.start)}${directive}${suffix}`;
}

export function parseComposerDirectives(text: string): Unstable_DirectiveSegment[] {
  const segments: Unstable_DirectiveSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(PARSE_DIRECTIVE_RE)) {
    const leading = match[1] ?? match[3] ?? match[5] ?? '';
    const raw = match[2] || match[4] || match[6] || '';
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
  if (raw.startsWith('[')) {
    const linkMatch = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(raw);
    if (linkMatch) {
      const label = linkMatch[1];
      const path = linkMatch[2];
      if (label.startsWith('$')) {
        return { kind: 'mention', type: 'command', label: label.slice(1), id: label.slice(1) };
      }
      return {
        kind: 'mention',
        type: path.endsWith('/') ? 'directory' : 'file',
        label: label || getPathLabel(path),
        id: path,
      };
    }
  }

  if (raw.startsWith('@')) {
    const id = raw.slice(1);
    return {
      kind: 'mention',
      type: id.endsWith('/') ? 'directory' : 'file',
      label: getPathLabel(id),
      id,
    };
  }

  if (raw.startsWith('/')) {
    return { kind: 'mention', type: 'command', label: raw.slice(1), id: raw.slice(1) };
  }

  return { kind: 'mention', type: 'file', label: raw, id: raw };
}

function appendSkillFilePath(directoryPath: string): string {
  const normalized = directoryPath.replace(/[\\/]+$/, '');
  const separator = directoryPath.includes('\\') ? '\\' : '/';
  return normalized + separator + 'SKILL.md';
}
function getPathLabel(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').filter(Boolean).pop() || path;
}

function toTriggerItem(command: SlashCommand, agentKind: AgentKind): Unstable_TriggerItem {
  return {
    id: command.name,
    type: 'command',
    label: `/${command.name}`,
    description: command.description,
    metadata: {
      category: command.category,
      agentKind,
      argsHint: command.argsHint ?? '',
      filePath: command.filePath ?? '',
    },
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
    case 'status': case 'explain': return <Info className="h-4 w-4" />;
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
