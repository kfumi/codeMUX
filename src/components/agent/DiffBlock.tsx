import { useMemo, useState } from 'react';
import { diffLines, type Change } from 'diff';
import { ChevronDown, ChevronRight, FileCode } from 'lucide-react';

interface DiffBlockProps {
  filePath: string;
  oldContent: string;
  newContent: string;
}

export function DiffBlock({ filePath, oldContent, newContent }: DiffBlockProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const changes = useMemo(() => diffLines(oldContent, newContent), [oldContent, newContent]);

  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  return (
    <div className="rounded-xl border border-border/30 my-2 overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/20 transition-colors duration-200"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <FileCode className="h-3.5 w-3.5 text-[hsl(var(--primary)/0.5)] shrink-0" />
        <span className="font-medium text-[13px]">{fileName}</span>
        <span className="text-muted-foreground/40 text-xs truncate">{filePath}</span>
      </button>
      {isExpanded && (
        <div className="border-t border-border/20 font-mono text-xs overflow-auto max-h-80">
          {changes.map((change: Change, i: number) => {
            const lines = change.value.split('\n').filter((l, idx, arr) =>
              idx < arr.length - 1 || l !== ''
            );
            return lines.map((line, j) => {
              let bgClass = '';
              let prefix = ' ';
              let prefixClass = 'text-muted-foreground/25';
              if (change.added) {
                bgClass = 'bg-[hsl(var(--success)/0.06)]';
                prefix = '+';
                prefixClass = 'text-[hsl(var(--success)/0.6)]';
              } else if (change.removed) {
                bgClass = 'bg-[hsl(var(--destructive)/0.06)]';
                prefix = '-';
                prefixClass = 'text-[hsl(var(--destructive)/0.6)]';
              }
              return (
                <div key={`${i}-${j}`} className={`px-3 py-0.5 ${bgClass}`}>
                  <span className={`select-none mr-2 ${prefixClass}`}>{prefix}</span>
                  {line}
                </div>
              );
            });
          })}
        </div>
      )}
    </div>
  );
}
