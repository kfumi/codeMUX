import { useCallback, useRef } from 'react';
import { FileCode, GitCompare, Loader2, PanelLeft, X } from 'lucide-react';

import { usePreviewStore } from '../../stores/previewStore';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui/context-menu';
import { DiffView } from './DiffView';
import { FileView } from './FileView';
import { FileTree } from './FileTree';
import { cn } from '../../lib/utils';

export function PreviewPanel() {
  const {
    isOpen, panelWidth, showFileTree, fileTreeWidth, diffFiles, activeDiffPath, openFiles, activeFilePath, viewMode, isResizing,
    togglePanel, setActiveFile, setViewMode, closeFile, closeOtherFiles, closeAllFiles,
    toggleFileTree, setFileTreeWidth,
  } = usePreviewStore();

  // 根据 viewMode 决定显示哪个 tab 列表和活动文件
  const currentFiles = viewMode === 'diff' ? diffFiles : openFiles;
  const currentActivePath = viewMode === 'diff' ? activeDiffPath : activeFilePath;
  const activeFile = currentFiles.find((file) => file.path === currentActivePath);
  const hasOriginal = activeFile?.originalContent !== undefined;
  const isDiffView = viewMode === 'diff' && hasOriginal;

  const treeDragRef = useRef(false);
  const handleTreeMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    treeDragRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const startX = event.clientX;
    const startWidth = fileTreeWidth;

    const onMove = (moveEvent: MouseEvent) => {
      if (!treeDragRef.current) return;
      const delta = moveEvent.clientX - startX;
      setFileTreeWidth(startWidth + delta);
    };

    const onUp = () => {
      treeDragRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [fileTreeWidth, setFileTreeWidth]);

  return (
    <div
      className={cn(
        'animate-in fade-in slide-in-from-right-3 fill-mode-both animation-duration-[420ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] h-full shrink-0 overflow-hidden shadow-[-0.5px_0_0_0_hsl(var(--border)/0.3)]',
        isResizing ? 'transition-none' : 'transition-[width] duration-300 ease-in-out',
      )}
      style={{ width: isOpen ? panelWidth : 0 }}
    >
      <div
        className="surface-panel surface-panel-muted flex h-full w-full flex-col rounded-none bg-[hsl(var(--background))]"
      >
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))]/30 px-3.5 py-2.5">
          <div className="flex items-center gap-1">
            {!isDiffView && (
              <button
                onClick={toggleFileTree}
                className={cn(
                  'rounded-lg p-1.5 transition-all duration-200',
                  showFileTree ? 'bg-muted/70 text-foreground' : 'text-muted-foreground/45 hover:bg-muted/50 hover:text-foreground/72',
                )}
                title="文件树"
              >
                <PanelLeft className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="surface-panel flex gap-0.5 rounded-xl border border-border/50 bg-muted/28 p-0.5 dark:bg-[linear-gradient(180deg,hsl(var(--surface-3))/0.88,hsl(var(--surface-2))/0.8)]">
            <button
              onClick={() => setViewMode('diff')}
              disabled={!hasOriginal}
              className={cn(
                'rounded-lg px-2.5 py-1 text-xs transition-all duration-200',
                viewMode === 'diff'
                  ? 'bg-background/90 font-medium text-foreground shadow-[0_1px_0_0_hsl(var(--foreground)/0.03)]'
                  : hasOriginal
                    ? 'text-muted-foreground/58 hover:text-foreground/80'
                    : 'cursor-not-allowed text-muted-foreground/22',
              )}
              title={!hasOriginal ? '此文件未被修改' : undefined}
            >
              <GitCompare className="mr-1 inline h-3 w-3" />
              Diff
            </button>
            <button
              onClick={() => setViewMode('file')}
              className={cn(
                'rounded-lg px-2.5 py-1 text-xs transition-all duration-200',
                viewMode === 'file'
                  ? 'bg-background/90 font-medium text-foreground shadow-[0_1px_0_0_hsl(var(--foreground)/0.03)]'
                  : 'text-muted-foreground/58 hover:text-foreground/80',
              )}
            >
              <FileCode className="mr-1 inline h-3 w-3" />
              文件
            </button>
          </div>

          <button
            onClick={togglePanel}
            className="rounded-md p-1 text-muted-foreground/42 transition-colors hover:bg-muted/50 hover:text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {showFileTree && !isDiffView && (
            <>
              <div className="shrink-0 overflow-hidden shadow-[0.5px_0_0_0_hsl(var(--border)/0.25)] bg-muted/10 dark:bg-[hsl(var(--surface-3))/0.44]" style={{ width: fileTreeWidth }}>
                <FileTree />
              </div>
              <div className="group relative w-1 shrink-0 cursor-col-resize" onMouseDown={handleTreeMouseDown}>
                <div className="absolute inset-y-0 -left-0.5 w-2 transition-colors duration-200 group-hover:bg-primary/12" />
              </div>
            </>
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            {currentFiles.length > 0 && (
              <div className="flex shrink-0 overflow-x-auto border-b border-[hsl(var(--border))]/25 bg-muted/8 dark:bg-[hsl(var(--surface-3))/0.36]">
                {currentFiles.map((file) => {
                  const fileName = file.path.split(/[/\\]/).pop() || file.path;
                  const isActive = file.path === currentActivePath;
                  const fileIsModified = file.originalContent && file.currentContent && file.originalContent !== file.currentContent;

                  return (
                    <ContextMenu key={file.path}>
                      <ContextMenuTrigger asChild>
                        <div
                          className={cn(
                            'relative flex cursor-pointer select-none items-center gap-1.5 border-r border-border/20 px-3 py-2 text-xs font-mono whitespace-nowrap transition-all duration-200',
                            isActive
                              ? 'bg-background/90 text-foreground/84'
                              : 'text-muted-foreground/52 hover:bg-muted/20 hover:text-muted-foreground',
                          )}
                          onClick={() => setActiveFile(file.path)}
                        >
                          {isActive && (
                            <div className="absolute left-0 right-0 top-0 h-0.5 bg-primary/70" />
                          )}
                          <span className="max-w-35 truncate">{fileName}</span>
                          {fileIsModified && <span className="text-[hsl(var(--warning))] text-[10px]">●</span>}
                          <button
                            className="ml-0.5 rounded-sm p-0.5 text-muted-foreground/34 transition-colors hover:bg-muted/50 hover:text-muted-foreground/72"
                            onClick={(event) => {
                              event.stopPropagation();
                              closeFile(file.path);
                            }}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="min-w-37 rounded-xl border border-border/60 bg-popover/98 py-1.5 text-xs shadow-[0_18px_48px_-20px_hsl(var(--foreground)/0.35)] backdrop-blur-sm animate-in fade-in zoom-in-95 fill-mode-forwards animation-duration-[300ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)]">
                        <ContextMenuItem onClick={() => closeFile(file.path)}>
                          关闭
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => closeOtherFiles(file.path)}>
                          关闭其他
                        </ContextMenuItem>
                        {currentFiles.length > 1 && (
                          <ContextMenuItem onClick={closeAllFiles}>
                            关闭所有
                          </ContextMenuItem>
                        )}
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </div>
            )}

            <div className="flex-1 overflow-auto">
              {activeFile ? (
                activeFile.isLoading ? (
                  <div className="flex h-full items-center justify-center gap-2 text-muted-foreground/40">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm">加载中...</span>
                  </div>
                ) : activeFile.error ? (
                  <div className="flex h-full items-center justify-center p-4 text-center text-sm text-[hsl(var(--destructive))]">
                    {activeFile.error}
                  </div>
                ) : activeFile.currentContent ? (
                  viewMode === 'diff' && activeFile.originalContent != null ? (
                    <DiffView oldContent={activeFile.originalContent} newContent={activeFile.currentContent} />
                  ) : (
                    <FileView content={activeFile.currentContent} filePath={activeFile.path} />
                  )
                ) : null
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/30">
                  <FileCode className="h-8 w-8" />
                  <span className="text-sm">点击文件路径预览内容</span>
                </div>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
