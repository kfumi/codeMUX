import { useState, useCallback, useRef, useEffect } from 'react';
import { usePreviewStore } from '../../stores/previewStore';
import { DiffView } from './DiffView';
import { FileView } from './FileView';
import { FileTree } from './FileTree';
import { X, FileCode, GitCompare, PanelLeft, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

function TabContextMenu({
  filePath,
  filePaths,
  onClose,
  onCloseOthers,
  onCloseAll,
  style,
}: {
  filePath: string;
  filePaths: string[];
  onClose: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onCloseAll: () => void;
  style: React.CSSProperties;
}) {
  return (
    <div
      className="fixed z-50 bg-[hsl(var(--popover))] border border-border/40 rounded-xl shadow-lg py-1.5 text-xs min-w-[140px] animate-scale-in"
      style={style}
    >
      <button
        className="w-full text-left px-3 py-1.5 hover:bg-muted/40 transition-colors"
        onClick={() => { onClose(filePath); }}
      >
        关闭
      </button>
      <button
        className="w-full text-left px-3 py-1.5 hover:bg-muted/40 transition-colors"
        onClick={() => { onCloseOthers(filePath); }}
      >
        关闭其他
      </button>
      {filePaths.length > 1 && (
        <button
          className="w-full text-left px-3 py-1.5 hover:bg-muted/40 transition-colors"
          onClick={onCloseAll}
        >
          关闭所有
        </button>
      )}
    </div>
  );
}

export function PreviewPanel() {
  const {
    isOpen, panelWidth, showFileTree, fileTreeWidth, openFiles, activeFilePath, viewMode,
    togglePanel, setActiveFile, setViewMode, closeFile, closeOtherFiles, closeAllFiles,
    toggleFileTree, setFileTreeWidth,
  } = usePreviewStore();

  const activeFile = openFiles.find((f) => f.path === activeFilePath);
  const hasOriginal = !!activeFile?.originalContent;

  const [contextMenu, setContextMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  const treeDragRef = useRef(false);
  const handleTreeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    treeDragRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const startX = e.clientX;
    const startWidth = fileTreeWidth;

    const onMove = (ev: MouseEvent) => {
      if (!treeDragRef.current) return;
      const delta = ev.clientX - startX;
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

  const handleTabContextMenu = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault();
    setContextMenu({ path, x: e.clientX, y: e.clientY });
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="border-l border-border/30 bg-muted/10 flex flex-col h-full shrink-0"
      style={{ width: panelWidth }}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/25">
        <div className="flex items-center gap-1">
          <button
            onClick={toggleFileTree}
            className={cn(
              'p-1.5 rounded-lg transition-all duration-200',
              showFileTree ? 'bg-muted text-foreground' : 'text-muted-foreground/40 hover:text-muted-foreground/70'
            )}
            title="文件树"
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex gap-0.5 bg-muted/30 rounded-lg p-0.5">
          <button
            onClick={() => setViewMode('diff')}
            disabled={!hasOriginal}
            className={cn(
              'px-2.5 py-1 text-xs rounded-md transition-all duration-200',
              viewMode === 'diff'
                ? 'bg-background text-foreground/80 shadow-sm font-medium'
                : hasOriginal
                  ? 'text-muted-foreground/50 hover:text-muted-foreground/70'
                  : 'text-muted-foreground/20 cursor-not-allowed'
            )}
            title={!hasOriginal ? '此文件未被修改' : undefined}
          >
            <GitCompare className="h-3 w-3 inline mr-1" />
            Diff
          </button>
          <button
            onClick={() => setViewMode('file')}
            className={cn(
              'px-2.5 py-1 text-xs rounded-md transition-all duration-200',
              viewMode === 'file'
                ? 'bg-background text-foreground/80 shadow-sm font-medium'
                : 'text-muted-foreground/50 hover:text-muted-foreground/70'
            )}
          >
            <FileCode className="h-3 w-3 inline mr-1" />
            文件
          </button>
        </div>

        <button
          onClick={togglePanel}
          className="text-muted-foreground/40 hover:text-muted-foreground transition-colors p-1 rounded-md hover:bg-muted/40"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Main content: file tree + tab/content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* File tree sidebar */}
        {showFileTree && (
          <>
            <div className="border-r border-border/25 overflow-hidden shrink-0" style={{ width: fileTreeWidth }}>
              <FileTree />
            </div>
            <div
              className="w-1 shrink-0 cursor-col-resize group relative"
              onMouseDown={handleTreeMouseDown}
            >
              <div className="absolute inset-y-0 -left-0.5 w-2 group-hover:bg-primary/15 transition-colors duration-200" />
            </div>
          </>
        )}

        {/* Tab + content area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tabs */}
          {openFiles.length > 0 && (
            <div className="flex overflow-x-auto border-b border-border/25 shrink-0">
              {openFiles.map((file) => {
                const fileName = file.path.split(/[/\\]/).pop() || file.path;
                const isActive = file.path === activeFilePath;
                const fileIsModified = file.originalContent && file.currentContent && file.originalContent !== file.currentContent;

                return (
                  <div
                    key={file.path}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono whitespace-nowrap border-r border-border/15 transition-all duration-200 cursor-pointer select-none relative',
                      isActive
                        ? 'bg-background text-foreground/80'
                        : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/20'
                    )}
                    onClick={() => setActiveFile(file.path)}
                    onContextMenu={(e) => handleTabContextMenu(e, file.path)}
                  >
                    {/* Active tab bottom indicator */}
                    {isActive && (
                      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[hsl(var(--primary)/0.6)]" />
                    )}
                    <span className="truncate max-w-[120px]">{fileName}</span>
                    {fileIsModified && <span className="text-[hsl(var(--warning))] text-[10px]">●</span>}
                    <button
                      className="ml-0.5 text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors rounded-sm hover:bg-muted/40 p-0.5"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeFile(file.path);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-auto">
            {activeFile ? (
              activeFile.isLoading ? (
                <div className="flex items-center justify-center h-full text-muted-foreground/40 gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">加载中...</span>
                </div>
              ) : activeFile.error ? (
                <div className="flex items-center justify-center h-full text-[hsl(var(--destructive))] text-sm p-4 text-center">
                  {activeFile.error}
                </div>
              ) : activeFile.currentContent ? (
                viewMode === 'diff' && activeFile.originalContent ? (
                  <DiffView oldContent={activeFile.originalContent} newContent={activeFile.currentContent} />
                ) : (
                  <FileView content={activeFile.currentContent} filePath={activeFile.path} />
                )
              ) : null
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground/30 gap-2">
                <FileCode className="h-8 w-8" />
                <span className="text-sm">点击文件路径预览内容</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <TabContextMenu
          filePath={contextMenu.path}
          filePaths={openFiles.map((f) => f.path)}
          onClose={closeFile}
          onCloseOthers={closeOtherFiles}
          onCloseAll={closeAllFiles}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        />
      )}
    </div>
  );
}
