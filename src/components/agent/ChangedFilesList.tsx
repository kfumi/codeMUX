import { useState, useCallback, useEffect, useRef } from 'react';
import { ChevronUp, ChevronDown, FileDiff, Eye, Undo2, Save, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { fileApi } from '../../lib/tauri';
import { useAgentStore } from '../../stores/agentStore';
import { usePreviewStore } from '../../stores/previewStore';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { diffLines } from 'diff';
import type { ChangedFile } from '../../types/agent';
import { createLogger, serializeError } from '../../lib/logger';

const EMPTY_FILES: ChangedFile[] = [];
const logger = createLogger('ChangedFilesList');

interface ChangedFilesListProps {
  sessionId: string;
  projectPath?: string;
  className?: string;
}

async function resolvePendingEdits(file: ChangedFile, projectPath?: string): Promise<ChangedFile> {
  if (!file._pendingEdits || file._pendingEdits.length === 0) return file;
  if (file.originalContent !== undefined) return file;

  try {
    const original = await fileApi.readFile(file.path, projectPath);
    let current = original;
    for (const edit of file._pendingEdits) {
      const idx = current.indexOf(edit.oldString);
      if (idx !== -1) {
        current = current.slice(0, idx) + edit.newString + current.slice(idx + edit.oldString.length);
      }
    }
    const changes = diffLines(original, current);
    let additions = 0;
    let deletions = 0;
    for (const change of changes) {
      const lines = change.value.split('\n').filter((_l: string, i: number, arr: string[]) =>
        i < arr.length - 1 || arr[arr.length - 1] !== ''
      );
      if (change.added) additions += lines.length;
      if (change.removed) deletions += lines.length;
    }
    return {
      ...file,
      originalContent: original,
      currentContent: current,
      additions,
      deletions,
      _pendingEdits: undefined,
    };
  } catch {
    return {
      ...file,
      originalContent: '',
      currentContent: file.currentContent || '',
      _pendingEdits: undefined,
    };
  }
}

function displayPath(filePath: string, projectPath?: string): string {
  if (projectPath) {
    const normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (normalizedPath.startsWith(normalized + '/')) {
      return normalizedPath.slice(normalized.length + 1);
    }
  }
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

export function ChangedFilesList({ sessionId, projectPath, className }: ChangedFilesListProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [resolvedFiles, setResolvedFiles] = useState<ChangedFile[]>([]);
  const [resolving, setResolving] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'single' | 'all'; filePath?: string } | null>(null);

  const changedFiles = useAgentStore((s) => s.changedFiles[sessionId] ?? EMPTY_FILES);
  const clearChangedFiles = useAgentStore((s) => s.clearChangedFiles);
  const { openFile } = usePreviewStore();

  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isExpanded) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsExpanded(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isExpanded]);

  useEffect(() => {
    if (changedFiles.length === 0) {
      setResolvedFiles([]);
      return;
    }

    const hasPending = changedFiles.some((f) => f._pendingEdits && f._pendingEdits.length > 0);
    if (!hasPending) {
      setResolvedFiles(changedFiles);
      return;
    }

    setResolving(true);
    Promise.all(changedFiles.map((f) => resolvePendingEdits(f, projectPath))).then((resolved) => {
      setResolvedFiles(resolved);
      setResolving(false);
    });
  }, [changedFiles, projectPath]);

  const totalAdditions = resolvedFiles.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = resolvedFiles.reduce((sum, f) => sum + f.deletions, 0);

  const handleViewDiff = useCallback((file: ChangedFile) => {
    // Only pass originalContent when it's actually available; undefined means genuinely new or snapshot not yet received
    openFile(file.path, file.originalContent);
  }, [openFile]);

  const handleOpenFile = useCallback((file: ChangedFile) => {
    openFile(file.path);
  }, [openFile]);

  const handleRevertSingle = useCallback(async (file: ChangedFile) => {
    try {
      if (file.isNew) {
        await fileApi.deleteFile(file.path, projectPath);
      } else if (file.originalContent !== undefined) {
        await fileApi.writeFile(file.path, file.originalContent, projectPath);
      }
      const updated = resolvedFiles.filter((f) => f.path !== file.path);
      useAgentStore.setState((s) => ({
        changedFiles: { ...s.changedFiles, [sessionId]: updated },
      }));
    } catch (err) {
      logger.error('Failed to revert file', { sessionId, path: file.path, isNew: file.isNew }, serializeError(err));
    }
    setConfirmAction(null);
  }, [resolvedFiles, sessionId, projectPath]);

  const handleRevertAll = useCallback(async () => {
    for (const file of resolvedFiles) {
      try {
        if (file.isNew) {
          await fileApi.deleteFile(file.path, projectPath);
        } else if (file.originalContent !== undefined) {
          await fileApi.writeFile(file.path, file.originalContent, projectPath);
        }
      } catch (err) {
        logger.error('Failed to revert file during bulk revert', { sessionId, path: file.path, isNew: file.isNew }, serializeError(err));
      }
    }
    clearChangedFiles(sessionId);
    setConfirmAction(null);
  }, [resolvedFiles, sessionId, projectPath, clearChangedFiles]);

  const handleSaveAll = useCallback(async () => {
    clearChangedFiles(sessionId);
  }, [sessionId, clearChangedFiles]);

  return (
    <div className={cn('relative', className)} ref={dropdownRef}>
      {isExpanded && (
        <div className="absolute bottom-full right-0 mb-2 w-[380px] max-h-[400px] rounded-xl border border-border/50 bg-[hsl(var(--card))] shadow-[0_-8px_34px_-24px_hsl(var(--foreground)/0.24)] z-50 animate-in fade-in zoom-in-95 fill-mode-forwards [animation-duration:240ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] flex flex-col">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/20">
            <span className="text-xs font-medium text-foreground/70">改动列表</span>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleSaveAll} className="p-1 rounded-md hover:bg-muted/40 text-muted-foreground/50 hover:text-foreground transition-colors">
                    <Save className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom"><p>保存全部</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={() => setConfirmAction({ type: 'all' })} className="p-1 rounded-md hover:bg-muted/40 text-muted-foreground/50 hover:text-foreground transition-colors">
                    <Undo2 className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom"><p>撤销全部</p></TooltipContent>
              </Tooltip>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {resolving ? (
              <div className="flex items-center justify-center py-6 text-muted-foreground/40 gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span className="text-xs">解析中...</span>
              </div>
            ) : resolvedFiles.length === 0 ? (
              <div className="flex items-center justify-center py-6 text-muted-foreground/40">
                <span className="text-xs">暂无改动</span>
              </div>
            ) : (
              <div className="py-1">
                {resolvedFiles.map((file) => (
                  <div key={file.path} className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/30 transition-colors group">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {file.isNew ? (
                        <span className="text-[10px] px-1 rounded bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary)/0.7)] font-medium shrink-0">新</span>
                      ) : (
                        <FileDiff className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button onClick={() => handleOpenFile(file)} className="text-xs text-foreground/80 hover:text-foreground hover:underline truncate min-w-0 flex-1 text-left">
                            {displayPath(file.path, projectPath)}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom"><p>{file.path}</p></TooltipContent>
                      </Tooltip>
                      <div className="flex items-center gap-1 shrink-0" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                        {file.additions > 0 && <span className="text-[10px] text-[hsl(var(--success))]">+{file.additions}</span>}
                        {file.deletions > 0 && <span className="text-[10px] text-[hsl(var(--destructive))]">-{file.deletions}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button onClick={() => handleViewDiff(file)} className="p-1 rounded-md hover:bg-muted/40 text-muted-foreground/50 hover:text-foreground transition-colors">
                            <Eye className="h-3 w-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom"><p>查看差异</p></TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button onClick={() => setConfirmAction({ type: 'single', filePath: file.path })} className="p-1 rounded-md hover:bg-muted/40 text-muted-foreground/50 hover:text-foreground transition-colors">
                            <Undo2 className="h-3 w-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom"><p>撤销更改</p></TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {resolvedFiles.length > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-border/20 text-[11px] text-muted-foreground/50">
              <span>共 {resolvedFiles.length} 个文件</span>
              <div className="flex items-center gap-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                <span className="text-[hsl(var(--success))]">+{totalAdditions}</span>
                <span className="text-[hsl(var(--destructive))]">-{totalDeletions}</span>
              </div>
            </div>
          )}

          {confirmAction && (
            <div className="absolute inset-0 bg-[hsl(var(--card))]/95 backdrop-blur-sm rounded-xl flex flex-col items-center justify-center gap-3 z-10">
              <p className="text-xs text-foreground/70 text-center px-4">
                {confirmAction.type === 'all'
                  ? `确定撤销全部 ${resolvedFiles.length} 个文件的更改？`
                  : '确定撤销此文件的更改？'}
              </p>
              <div className="flex items-center gap-2">
                <button onClick={() => setConfirmAction(null)} className="px-3 py-1.5 rounded-lg text-xs border border-border/40 hover:bg-muted/30 transition-colors">
                  取消
                </button>
                <button
                  onClick={() => {
                    if (confirmAction.type === 'all') {
                      handleRevertAll();
                    } else if (confirmAction.filePath) {
                      const file = resolvedFiles.find((f) => f.path === confirmAction.filePath);
                      if (file) handleRevertSingle(file);
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.18)] transition-colors"
                >
                  确定撤销
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-xl border transition-all duration-200 text-left',
          changedFiles.length > 0
            ? 'border-border/30 bg-[hsl(var(--card))]/50 hover:bg-muted/30'
            : 'border-border/20 bg-[hsl(var(--card))]/30 hover:bg-muted/20'
        )}
      >
        {isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        )}
        <FileDiff className="h-3.5 w-3.5 text-[hsl(var(--primary)/0.5)] shrink-0" />
        <span className="text-xs font-medium text-foreground/70">改动列表</span>
        <div className="flex items-center gap-1 ml-auto" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          <span className={cn('text-[11px] tabular-nums', totalAdditions > 0 ? 'text-[hsl(var(--success))]' : 'text-muted-foreground/30')}>
            +{totalAdditions}
          </span>
          <span className={cn('text-[11px] tabular-nums', totalDeletions > 0 ? 'text-[hsl(var(--destructive))]' : 'text-muted-foreground/30')}>
            -{totalDeletions}
          </span>
        </div>
      </button>
    </div>
  );
}
