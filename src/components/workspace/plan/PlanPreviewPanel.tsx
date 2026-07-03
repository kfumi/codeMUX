import { FileText } from 'lucide-react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';

import { CODEMUX_MARKDOWN_REHYPE_PLUGINS, CodeMuxMarkdownLink } from '../../assistant-ui/markdown-link';
import { FileView } from '../../preview/FileView';

function displayName(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path || '文件';
}

function getExtension(path?: string) {
  return path?.replace(/[#?].*$/, '').split('.').pop()?.toLowerCase() ?? '';
}

function isMarkdownFile(path?: string) {
  return ['md', 'markdown', 'mdx'].includes(getExtension(path));
}

export function PlanPreviewPanel({
  planFilePath,
  planContent,
}: {
  planFilePath?: string;
  planContent?: string;
}) {
  const content = planContent ?? '';
  const markdown = isMarkdownFile(planFilePath);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-15 shrink-0 items-center gap-3 border-b border-border/25 bg-[hsl(var(--surface-2))]/45 px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/45 text-muted-foreground/80">
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground/88">
            {displayName(planFilePath ?? '')}
          </div>
          {planFilePath ? (
            <div className="mt-0.5 truncate text-xs text-muted-foreground/58" title={planFilePath}>
              {planFilePath}
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {content.trim() ? (
          markdown ? (
            <div
              data-testid="file-preview-markdown"
              className="mx-auto w-full max-w-3xl px-6 py-5 text-sm leading-6 text-foreground/88"
            >
              <Streamdown
                mode="static"
                className="aui-md"
                components={{ a: CodeMuxMarkdownLink } as never}
                plugins={{ code }}
                shikiTheme={['github-light', 'github-dark']}
                controls={{ code: { copy: true, download: false }, table: false } as never}
                rehypePlugins={CODEMUX_MARKDOWN_REHYPE_PLUGINS}
                linkSafety={{ enabled: false }}
              >
                {content.trim()}
              </Streamdown>
            </div>
          ) : (
            <div data-testid="file-preview-code" className="min-w-max py-3">
              <FileView content={content} filePath={planFilePath} />
            </div>
          )
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground/55">
            暂无文件内容
          </div>
        )}
      </div>
    </div>
  );
}
