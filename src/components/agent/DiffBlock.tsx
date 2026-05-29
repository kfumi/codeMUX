import { useMemo, useState } from 'react';
import { diffLines, type Change } from 'diff';
import { ChevronDown, ChevronRight } from 'lucide-react';

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
    <div className="border rounded-md my-2">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/40 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="font-medium">{fileName}</span>
        <span className="text-muted-foreground text-xs truncate">{filePath}</span>
      </button>
      {isExpanded && (
        <div className="border-t font-mono text-xs overflow-auto max-h-80">
          {changes.map((change: Change, i: number) => {
            const lines = change.value.split('\n').filter((l, idx, arr) =>
              idx < arr.length - 1 || l !== ''
            );
            return lines.map((line, j) => {
              let bgClass = '';
              let prefix = ' ';
              if (change.added) {
                bgClass = 'bg-green-500/10';
                prefix = '+';
              } else if (change.removed) {
                bgClass = 'bg-red-500/10';
                prefix = '-';
              }
              return (
                <div key={`${i}-${j}`} className={`px-3 py-0.5 ${bgClass}`}>
                  <span className="text-muted-foreground select-none mr-2">{prefix}</span>
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
