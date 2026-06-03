import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
  onFileClick?: (path: string) => void;
}

export function MarkdownRenderer({ content, onFileClick: _onFileClick }: MarkdownRendererProps) {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // 动态加载对应的 highlight.js 主题
  useEffect(() => {
    const id = 'hljs-theme';
    let link = document.getElementById(id) as HTMLLinkElement;
    if (!link) {
      link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = isDark
      ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css'
      : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
  }, [isDark]);

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
          return (
            <div className="relative group my-3">
              <button
                onClick={() => handleCopy(codeText)}
                className="absolute top-2 right-2 px-2 py-1 text-xs bg-muted hover:bg-muted/80 text-muted-foreground rounded opacity-0 group-hover:opacity-100 transition-opacity"
              >
                复制
              </button>
              <pre {...props} className="overflow-x-auto rounded-lg bg-muted p-4 text-sm">
                {children}
              </pre>
            </div>
          );
        },
        code({ children, className, ...props }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
                {children}
              </code>
            );
          }
          return <code className={className} {...props}>{children}</code>;
        },
        hr() {
          return <hr className="my-6 border-border" />;
        },
        table({ children, ...props }) {
          return (
            <div className="my-4 overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm" {...props}>
                {children}
              </table>
            </div>
          );
        },
        thead({ children, ...props }) {
          return <thead className="bg-muted/50" {...props}>{children}</thead>;
        },
        tbody({ children, ...props }) {
          return <tbody className="divide-y divide-border" {...props}>{children}</tbody>;
        },
        tr({ children, ...props }) {
          return <tr className="hover:bg-muted/30 transition-colors" {...props}>{children}</tr>;
        },
        th({ children, ...props }) {
          return (
            <th className="px-4 py-2.5 text-left font-semibold text-foreground/80 border-b border-border" {...props}>
              {children}
            </th>
          );
        },
        td({ children, ...props }) {
          return (
            <td className="px-4 py-2.5 text-foreground/70 border-r border-border last:border-r-0" {...props}>
              {children}
            </td>
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
