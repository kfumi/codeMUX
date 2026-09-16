import { Suspense, lazy, useMemo, useRef } from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

import { useSupportsRichCodeEditor } from '../../lib/monacoHost';
import { MonacoLoading } from '../code/MonacoLoading';

interface FileViewProps {
  content: string;
  filePath?: string;
}

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('go', go);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

// Monaco 是重资产,按需加载:模块 chunk 与 AMD 运行时的加载期都由 Suspense /
// 内置 loading 兜住。占位用统一的加载指示而不是 highlight.js 内容 —— 两套渲染器
// 先后出同一份内容会明显闪一下,Monaco 就绪后一次性呈现最终形态。
const MonacoCodeView = lazy(() => import('../code/MonacoCodeView'));

function escapeHtml(content: string): string {
  return content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getLangFromPath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const ext = filePath.split('.').pop()?.toLowerCase();
  const extMap: Record<string, string> = {
    c: 'c',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    h: 'c',
    hpp: 'cpp',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    md: 'markdown',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'bash',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  };
  return ext ? extMap[ext] : undefined;
}

function highlightFileContent(content: string, filePath?: string): string {
  const language = getLangFromPath(filePath);

  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(content, { language }).value;
    }

    return escapeHtml(content);
  } catch {
    return escapeHtml(content);
  }
}

function HighlightedLines({ highlighted }: { highlighted: string }) {
  const lines = useMemo(() => highlighted.split('\n'), [highlighted]);

  return (
    <>
      {lines.map((line, index) => (
        <div key={index} className="whitespace-pre px-4 transition-colors hover:bg-muted/30">
          <span className="mr-4 inline-block w-8 select-none text-right tabular-nums text-muted-foreground/40">
            {index + 1}
          </span>
          <span dangerouslySetInnerHTML={{ __html: line || '&nbsp;' }} />
        </div>
      ))}
    </>
  );
}

/**
 * highlight.js 只读视图:移动形态的代码展示(Monaco 官方不支持移动浏览器)。
 *
 * 主题不再从 cdnjs 运行时注入 —— src/styles/hljs-theme.css 已同时提供亮色与
 * `.dark` 两套规则,注入外链只会引入外网依赖,并与本地规则争抢 `.hljs-*` 命名空间。
 */
export function HighlightedFileView({ content, filePath }: FileViewProps) {
  const highlighted = useMemo(() => highlightFileContent(content, filePath), [content, filePath]);

  return (
    <div className="overflow-x-auto font-mono text-code leading-relaxed">
      <HighlightedLines highlighted={highlighted} />
    </div>
  );
}

export function FileView({ content, filePath }: FileViewProps) {
  const richEditor = useSupportsRichCodeEditor();

  if (!richEditor) {
    return <HighlightedFileView content={content} filePath={filePath} />;
  }

  return (
    <div data-testid="monaco-code-surface" className="h-full">
      <Suspense fallback={<MonacoLoading />}>
        <MonacoCodeView value={content} filePath={filePath} readOnly />
      </Suspense>
    </div>
  );
}

/** 移动形态的可编辑视图:透明文字 textarea 叠在高亮层上,仅支持 Tab 缩进。 */
export function HighlightedEditableFileView({
  content,
  filePath,
  onChange,
}: FileViewProps & { onChange: (content: string) => void }) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlighted = useMemo(() => highlightFileContent(content, filePath), [content, filePath]);
  const lineCount = content.split('\n').length;
  const longestLine = Math.max(...content.split('\n').map((line) => line.length), 1);
  const editorWidth = Math.max(640, longestLine * 8 + 80);
  const editorHeight = Math.max(80, lineCount * 21 + 24);

  return (
    <div className="h-full overflow-auto">
      <div
        className="relative font-mono text-code leading-relaxed"
        style={{ minWidth: editorWidth, minHeight: editorHeight }}
      >
        <div className="pointer-events-none absolute inset-0 select-none overflow-hidden py-3">
          <HighlightedLines highlighted={highlighted} />
        </div>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return;
            event.preventDefault();
            const target = event.currentTarget;
            const start = target.selectionStart;
            const end = target.selectionEnd;
            const nextContent = `${content.slice(0, start)}  ${content.slice(end)}`;
            onChange(nextContent);
            requestAnimationFrame(() => {
              textareaRef.current?.setSelectionRange(start + 2, start + 2);
            });
          }}
          spellCheck={false}
          wrap="off"
          aria-label={`编辑 ${filePath ?? '文件'}`}
          className="absolute inset-0 z-10 m-0 block resize-none overflow-hidden border-0 bg-transparent py-3 pl-16 pr-4 font-mono text-code leading-relaxed outline-none"
          style={{
            width: editorWidth,
            height: editorHeight,
            color: 'transparent',
            caretColor: 'hsl(var(--foreground))',
            WebkitTextFillColor: 'transparent',
          }}
        />
      </div>
    </div>
  );
}

export function EditableFileView({
  content,
  filePath,
  onChange,
}: FileViewProps & { onChange: (content: string) => void }) {
  const richEditor = useSupportsRichCodeEditor();

  if (!richEditor) {
    return <HighlightedEditableFileView content={content} filePath={filePath} onChange={onChange} />;
  }

  return (
    <div data-testid="monaco-code-surface" className="h-full">
      <Suspense fallback={<MonacoLoading />}>
        <MonacoCodeView
          value={content}
          filePath={filePath}
          readOnly={false}
          onChange={onChange}
        />
      </Suspense>
    </div>
  );
}
