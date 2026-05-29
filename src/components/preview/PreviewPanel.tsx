import { usePreviewStore } from '../../stores/previewStore';
import { DiffView } from './DiffView';
import { FileView } from './FileView';
import { X, FileCode, GitCompare } from 'lucide-react';
import { cn } from '../../lib/utils';

export function PreviewPanel() {
  const { isOpen, files, activeFile, fileContent, viewMode, setOpen, selectFile, setViewMode } = usePreviewStore();

  if (!isOpen) return null;

  return (
    <div className="w-[400px] border-l border-border/50 bg-muted/20 flex flex-col h-full shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
        <div className="flex gap-0.5">
          <button
            onClick={() => setViewMode('diff')}
            className={cn(
              'px-2.5 py-1 text-xs rounded-md transition-colors',
              viewMode === 'diff'
                ? 'bg-background text-foreground/80 shadow-sm'
                : 'text-muted-foreground/50 hover:text-muted-foreground/70'
            )}
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
          onClick={() => setOpen(false)}
          className="text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* File tabs */}
      {files.length > 0 && (
        <div className="flex overflow-x-auto border-b border-border/30">
          {files.map((file) => (
            <button
              key={file.path}
              onClick={() => selectFile(file.path)}
              className={cn(
                'px-3 py-2 text-xs font-mono whitespace-nowrap border-r border-border/20 transition-colors',
                activeFile === file.path
                  ? 'bg-background text-foreground/80'
                  : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30'
              )}
            >
              {file.path.split('/').pop()}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeFile && fileContent ? (
          viewMode === 'file' ? (
            <FileView content={fileContent} />
          ) : (
            <DiffView oldContent="" newContent={fileContent} />
          )
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground/50 text-sm">
            {files.length > 0 ? '选择文件查看内容' : '暂无文件引用'}
          </div>
        )}
      </div>
    </div>
  );
}
