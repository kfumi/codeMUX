import { AlertCircle, Check, Cloud, Code2, Eye, Loader2, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Streamdown } from 'streamdown';

import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '../assistant-ui/markdown-text';
import { cn } from '../../lib/utils';
import { useSidePanelStore, type SidePanelTab } from '../../stores/sidePanelStore';
import { FileTypeIcon } from '../assistant-ui/file-type-icon';
import { EditableFileView } from '../preview/FileView';

function getRelativePath(filePath: string, projectPath?: string): string {
  if (!projectPath) return filePath;
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  const normalizedProjectPath = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedFilePath.startsWith(`${normalizedProjectPath}/`)
    ? normalizedFilePath.slice(normalizedProjectPath.length + 1)
    : filePath;
}

function isMarkdownFile(filePath?: string): boolean {
  const extension = filePath?.replace(/[#?].*$/, '').split('.').pop()?.toLowerCase();
  return extension === 'md' || extension === 'markdown' || extension === 'mdx';
}

export function FileEditorPanel({ tab }: { tab: SidePanelTab }) {
  const updateFileContent = useSidePanelStore((state) => state.updateFileContent);
  const saveFileTab = useSidePanelStore((state) => state.saveFileTab);
  const content = tab.fileContent ?? '';
  const isDirty = tab.fileContent !== undefined && tab.fileContent !== tab.fileOriginalContent;
  const markdownFile = isMarkdownFile(tab.filePath ?? tab.title);
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview');

  useEffect(() => {
    if (!isDirty || tab.fileLoading || tab.fileError) return;

    const timeoutId = window.setTimeout(() => {
      void saveFileTab(tab.id);
    }, 700);

    return () => window.clearTimeout(timeoutId);
  }, [isDirty, saveFileTab, tab.fileContent, tab.fileError, tab.fileLoading, tab.id]);

  const relativePath = useMemo(
    () => getRelativePath(tab.filePath ?? tab.title, tab.projectPath),
    [tab.filePath, tab.projectPath, tab.title],
  );

  if (tab.fileLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-ui-compact text-muted-foreground/55">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在读取 {tab.title}
      </div>
    );
  }

  if (tab.fileError && tab.fileContent === undefined) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-ui-compact text-destructive/80">
        <AlertCircle className="h-5 w-5" />
        <span>无法打开文件</span>
        <span className="max-w-lg break-all text-ui-caption text-muted-foreground/60">{tab.fileError}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/25 bg-muted/8 px-3 py-1.5">
        <FileTypeIcon filePath={tab.filePath ?? tab.title} />
        <span className="min-w-0 flex-1 truncate font-mono text-code text-muted-foreground/62" title={tab.filePath}>
          {relativePath}
        </span>
        {markdownFile ? (
          <div className="flex shrink-0 items-center rounded-md border border-border/40 bg-muted/20 p-0.5" role="tablist" aria-label="Markdown 查看模式">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'preview'}
              onClick={() => setViewMode('preview')}
              className={cn(
                'flex items-center gap-1 rounded px-2 py-1 text-ui-caption transition-colors',
                viewMode === 'preview'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground/65 hover:text-foreground',
              )}
            >
              <Eye className="h-3 w-3" />
              预览
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'source'}
              onClick={() => setViewMode('source')}
              className={cn(
                'flex items-center gap-1 rounded px-2 py-1 text-ui-caption transition-colors',
                viewMode === 'source'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground/65 hover:text-foreground',
              )}
            >
              <Code2 className="h-3 w-3" />
              源码
            </button>
          </div>
        ) : null}
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 text-ui-caption transition-colors',
            tab.fileSaveState === 'error'
              ? 'text-destructive'
              : tab.fileSaveState === 'saving'
                ? 'text-muted-foreground/55'
                : isDirty
                  ? 'text-warning'
                  : 'text-success/75',
          )}
          aria-live="polite"
        >
          {tab.fileSaveState === 'saving' ? (
            <>
              <Save className="h-3 w-3 animate-pulse" />
              保存中
            </>
          ) : tab.fileSaveState === 'error' ? (
            <>
              <AlertCircle className="h-3 w-3" />
              保存失败
            </>
          ) : isDirty ? (
            <>
              <Cloud className="h-3 w-3" />
              自动保存中
            </>
          ) : (
            <>
              <Check className="h-3 w-3" />
              已保存
            </>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {markdownFile && viewMode === 'preview' ? (
          <div data-testid="markdown-file-preview" className="h-full overflow-auto">
            <div className="mx-auto w-full max-w-3xl px-6 py-5 text-ui-body leading-6 text-foreground/88">
              <Streamdown
                mode="static"
                className="aui-md min-w-0 max-w-full"
                components={CODEMUX_MARKDOWN_STREAMDOWN_PROPS.components}
                plugins={CODEMUX_MARKDOWN_STREAMDOWN_PROPS.plugins}
                shikiTheme={CODEMUX_MARKDOWN_STREAMDOWN_PROPS.shikiTheme}
                controls={CODEMUX_MARKDOWN_STREAMDOWN_PROPS.controls}
                rehypePlugins={CODEMUX_MARKDOWN_STREAMDOWN_PROPS.rehypePlugins}
                linkSafety={CODEMUX_MARKDOWN_STREAMDOWN_PROPS.linkSafety}
              >
                {content.trim()}
              </Streamdown>
            </div>
          </div>
        ) : (
          <EditableFileView
            content={content}
            filePath={tab.filePath}
            onChange={(value) => updateFileContent(tab.id, value)}
          />
        )}
      </div>
    </div>
  );
}
