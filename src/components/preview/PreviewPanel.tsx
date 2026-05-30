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
      className="fixed z-50 bg-background border border-border rounded-md shadow-lg py-1 text-xs min-w-[140px]"
      style={style}
    >
      <button
        className="w-full text-left px-3 py-1.5 hover:bg-muted/50 transition-colors"
        onClick={() => { onClose(filePath); }}
      >
        关闭
      </button>
      <button
        className="w-full text-left px-3 py-1.5 hover:bg-muted/50 transition-colors"
        onClick={() => { onCloseOthers(filePath); }}
      >
        关闭其他
      </button>
      {filePaths.length > 1 && (
        <button
          className="w-full text-left px-3 py-1.5 hover:bg-muted/50 transition-colors"
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

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  // File tree drag resize
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
      className="border-l border-border/50 bg-muted/20 flex flex-col h-full shrink-0"
      style={{ width: panelWidth }}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
        <div className="flex items-center gap-1">
          <button
            onClick={toggleFileTree}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              showFileTree ? 'bg-muted text-foreground' : 'text-muted-foreground/50 hover:text-muted-foreground/70'
            )}
            title="文件树"
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex gap-0.5">
          <button
            onClick={() => setViewMode('diff')}
            disabled={!hasOriginal}
            className={cn(
              'px-2.5 py-1 text-xs rounded-md transition-colors',
              viewMode === 'diff'
                ? 'bg-background text-foreground/80 shadow-sm'
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
              'px-2.5 py-1 text-xs rounded-md transition-colors',
              viewMode === 'file'
                ? 'bg-background text-foreground/80 shadow-sm'
                : 'text-muted-foreground/50 hover:text-muted-foreground/70'
            )}
          >
            <FileCode className="h-3 w-3 inline mr-1" />
            文件
          </button>
        </div>

        <button
          onClick={togglePanel}
          className="text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Main content: file tree + tab/content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* File tree sidebar */}
        {showFileTree && (
          <>
            <div className="border-r border-border/30 overflow-hidden shrink-0" style={{ width: fileTreeWidth }}>
              <FileTree />
            </div>
            {/* Drag handle between file tree and content */}
            <div
              className="w-1 shrink-0 cursor-col-resize group relative"
              onMouseDown={handleTreeMouseDown}
            >
              <div className="absolute inset-y-0 -left-0.5 w-2 group-hover:bg-primary/20 transition-colors" />
            </div>
          </>
        )}

        {/* Tab + content area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tabs */}
          {openFiles.length > 0 && (
            <div className="flex overflow-x-auto border-b border-border/30 shrink-0">
              {openFiles.map((file) => {
                const fileName = file.path.split(/[/\\]/).pop() || file.path;
                const isActive = file.path === activeFilePath;
                const fileIsModified = file.originalContent && file.currentContent && file.originalContent !== file.currentContent;

                return (
                  <div
                    key={file.path}
                    className={cn(
                      'flex items-center gap-1 px-3 py-1.5 text-xs font-mono whitespace-nowrap border-r border-border/20 transition-colors cursor-pointer select-none',
                      isActive
                        ? 'bg-background text-foreground/80'
                        : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30'
                    )}
                    onClick={() => setActiveFile(file.path)}
                    onContextMenu={(e) => handleTabContextMenu(e, file.path)}
                  >
                    <span className="truncate max-w-[120px]">{fileName}</span>
                    {fileIsModified && <span className="text-yellow-500 text-[10px]">●</span>}
                    <button
                      className="ml-1 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
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
                <div className="flex items-center justify-center h-full text-muted-foreground/50">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  <span className="text-sm">加载中...</span>
                </div>
              ) : activeFile.error ? (
                <div className="flex items-center justify-center h-full text-red-500 text-sm p-4 text-center">
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
              <div className="flex items-center justify-center h-full text-muted-foreground/40 text-sm">
                点击文件路径预览内容
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
