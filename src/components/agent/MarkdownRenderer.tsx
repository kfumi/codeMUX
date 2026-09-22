import { useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { shellFacade } from '../../lib/facades/shell-facade';
import { useIsNarrowViewport } from '../../hooks/useIsNarrowViewport';
import { cn } from '../../lib/utils';

interface MarkdownRendererProps {
  content: string;
  onFileClick?: (path: string) => void;
}

export function MarkdownRenderer({ content, onFileClick: _onFileClick }: MarkdownRendererProps) {
  // 窄屏没有 hover:代码块复制按钮常显,否则触屏上无法复制。
  const isNarrow = useIsNarrowViewport();

  // highlight.js 主题不再从 cdnjs 运行时注入:src/styles/hljs-theme.css 已同时提供
  // 亮色与 `.dark` 两套规则,外链只会带来外网依赖,并与本地规则争抢 `.hljs-*`。
  const handleCopy = useCallback((code: string) => {
    navigator.clipboard.writeText(code);
  }, []);

  return (
    <ReactMarkdown
      remarkPlugins={[[remarkGfm, { breaks: true }]]}
      rehypePlugins={[rehypeHighlight, rehypeRaw]}
      components={{
        pre({ children, ...props }) {
          const codeText = extractCodeText(children);
          const lang = extractLanguage(children);
          return (
            <div className="relative group my-3 rounded-xl overflow-hidden border border-border/25">
              {lang && (
                <div className="code-lang-badge">
                  {lang}
                </div>
              )}
              <button
                onClick={() => handleCopy(codeText)}
                className={cn(
                  'absolute top-2 right-2 px-2 py-1 text-ui-caption font-medium bg-muted/60 hover:bg-muted text-muted-foreground/60 hover:text-muted-foreground rounded-md transition-all duration-normal backdrop-blur-sm',
                  isNarrow ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                复制
              </button>
              <pre {...props} className="overflow-x-auto bg-muted/40 p-4 text-code leading-relaxed rounded-none! border-0! m-0!">
                {children}
              </pre>
            </div>
          );
        },
        code({ children, className, ...props }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code className="bg-muted/50 px-1.5 py-0.5 rounded-md text-code font-mono border border-border/20" {...props}>
                {children}
              </code>
            );
          }
          return <code className={className} {...props}>{children}</code>;
        },
        hr() {
          return (
            <div className="my-6 flex items-center gap-3">
              <div className="flex-1 h-px bg-linear-to-r from-transparent via-border to-transparent" />
            </div>
          );
        },
        table({ children, ...props }) {
          return (
            <div className="my-4 overflow-x-auto rounded-xl border border-border/30">
              <table className="w-full text-sm" {...props}>
                {children}
              </table>
            </div>
          );
        },
        thead({ children, ...props }) {
          return <thead className="bg-muted/30" {...props}>{children}</thead>;
        },
        tbody({ children, ...props }) {
          return <tbody className="divide-y divide-border/30" {...props}>{children}</tbody>;
        },
        tr({ children, ...props }) {
          return <tr className="hover:bg-muted/20 transition-colors" {...props}>{children}</tr>;
        },
        th({ children, ...props }) {
          return (
            <th className="px-4 py-2.5 text-left font-semibold text-foreground/70 text-xs uppercase tracking-normal border-b border-border/30" {...props}>
              {children}
            </th>
          );
        },
        td({ children, ...props }) {
          return (
            <td className="px-4 py-2.5 text-foreground/70 border-r border-border/20 last:border-r-0" {...props}>
              {children}
            </td>
          );
        },
        a({ children, href, ...props }) {
          return (
            <a
              href={href}
              className="text-[hsl(var(--primary))] hover:underline underline-offset-2"
              onClick={(e) => {
                e.preventDefault();
                // 外链走壳桥 openExternal(main 侧 shell.openExternal,仅 http/https)。
                if (href) void shellFacade.openExternal(href).catch(() => {});
              }}
              {...props}
            >
              {children}
            </a>
          );
        },
        blockquote({ children, ...props }) {
          return (
            <blockquote className="border-l-2 border-[hsl(var(--primary)/0.3)] pl-4 py-1 my-3 text-muted-foreground/70 italic" {...props}>
              {children}
            </blockquote>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function extractCodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(extractCodeText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return extractCodeText((children as React.ReactElement).props.children);
  }
  return '';
}

function extractLanguage(children: React.ReactNode): string | null {
  if (children && typeof children === 'object' && 'props' in children) {
    const props = (children as React.ReactElement).props;
    if (props.className) {
      const match = props.className.match(/language-(\w+)/);
      if (match) return match[1];
    }
  }
  return null;
}
