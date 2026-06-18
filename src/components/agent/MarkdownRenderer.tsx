import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { open } from '@tauri-apps/plugin-shell';

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
                className="absolute top-2 right-2 px-2 py-1 text-[11px] font-medium bg-muted/60 hover:bg-muted text-muted-foreground/60 hover:text-muted-foreground rounded-md opacity-0 group-hover:opacity-100 transition-all duration-200 backdrop-blur-sm"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                复制
              </button>
              <pre {...props} className="overflow-x-auto bg-muted/40 p-4 text-sm leading-relaxed rounded-none! border-0! m-0!">
                {children}
              </pre>
            </div>
          );
        },
        code({ children, className, ...props }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code className="bg-muted/50 px-1.5 py-0.5 rounded-md text-[13px] font-mono border border-border/20" {...props}>
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
            <th className="px-4 py-2.5 text-left font-semibold text-foreground/70 text-xs uppercase tracking-wider border-b border-border/30" {...props}>
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
                if (href) open(href);
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
