import { useMemo } from 'react';
import hljs from 'highlight.js';

interface FileViewProps {
  content: string;
  filePath?: string;
}

function getLangFromPath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const ext = filePath.split('.').pop()?.toLowerCase();
  const extMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    rs: 'rust', py: 'python', go: 'go', rb: 'ruby', java: 'java',
    css: 'css', scss: 'scss', html: 'html', json: 'json', yaml: 'yaml',
    yml: 'yaml', md: 'markdown', sh: 'bash', sql: 'sql', toml: 'toml',
    xml: 'xml', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  };
  return ext ? extMap[ext] : undefined;
}

export function FileView({ content, filePath }: FileViewProps) {
  const highlighted = useMemo(() => {
    const lang = getLangFromPath(filePath);
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(content, { language: lang }).value;
      }
      return hljs.highlightAuto(content).value;
    } catch {
      return content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
  }, [content, filePath]);

  const lines = useMemo(() => highlighted.split('\n'), [highlighted]);

  return (
    <div className="font-mono text-sm leading-relaxed overflow-x-auto">
      {lines.map((line, index) => (
        <div key={index} className="px-4 hover:bg-muted/30 transition-colors whitespace-nowrap">
          <span className="text-muted-foreground/40 select-none mr-4 inline-block w-8 text-right">
            {index + 1}
          </span>
          <span dangerouslySetInnerHTML={{ __html: line || ' ' }} />
        </div>
      ))}
    </div>
  );
}
