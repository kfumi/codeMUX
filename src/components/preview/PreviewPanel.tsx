import { usePreviewStore } from '../../stores/previewStore';
import { DiffView } from './DiffView';
import { FileView } from './FileView';
import { X, FileCode, GitCompare } from 'lucide-react';
import { cn } from '../../lib/utils';

export function PreviewPanel() {
  const { isOpen, files, activeFile, fileContent, viewMode, setOpen, selectFile, setViewMode } = usePreviewStore();

  if (!isOpen) return null;

  return (
    <div className="w-[400px] border-l bg-zinc-950 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <div className="flex gap-1">
          <button
            onClick={() => setViewMode('diff')}
            className={cn(
              'px-2 py-1 text-xs rounded',
              viewMode === 'diff' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
            )}
          >
            <GitCompare className="h-3 w-3 inline mr-1" />
            Diff
          </button>
          <button
            onClick={() => setViewMode('file')}
            className={cn(
              'px-2 py-1 text-xs rounded',
              viewMode === 'file' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
            )}
          >
            <FileCode className="h-3 w-3 inline mr-1" />
            文件
          </button>
        </div>
        <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-300">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* File tabs */}
      {files.length > 0 && (
        <div className="flex overflow-x-auto border-b border-zinc-800">
          {files.map((file) => (
            <button
              key={file.path}
              onClick={() => selectFile(file.path)}
              className={cn(
                'px-3 py-2 text-xs font-mono whitespace-nowrap border-r border-zinc-800',
                activeFile === file.path
                  ? 'bg-zinc-900 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50'
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
          <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
            {files.length > 0 ? '选择文件查看内容' : '暂无文件引用'}
          </div>
        )}
      </div>
    </div>
  );
}
