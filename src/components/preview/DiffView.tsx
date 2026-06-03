import { useMemo } from 'react';
import { diffLines, Change } from 'diff';

interface DiffViewProps {
  oldContent: string;
  newContent: string;
}

export function DiffView({ oldContent, newContent }: DiffViewProps) {
  const changes: Change[] = useMemo(() => diffLines(oldContent, newContent), [oldContent, newContent]);

  const stats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const change of changes) {
      const lines = change.value.split('\n').filter((_l, i, arr) =>
        i < arr.length - 1 || arr[arr.length - 1] !== ''
      );
      if (change.added) additions += lines.length;
      if (change.removed) deletions += lines.length;
    }
    return { additions, deletions };
  }, [changes]);

  // Build lines with line numbers
  const diffLinesData = useMemo(() => {
    const result: Array<{
      type: 'added' | 'removed' | 'unchanged';
      content: string;
      oldLineNum: number | null;
      newLineNum: number | null;
    }> = [];

    let oldLine = 1;
    let newLine = 1;

    for (const change of changes) {
      const lines = change.value.split('\n').filter((_l, i, arr) =>
        i < arr.length - 1 || arr[arr.length - 1] !== ''
      );
      for (const line of lines) {
        if (change.added) {
          result.push({ type: 'added', content: line, oldLineNum: null, newLineNum: newLine++ });
        } else if (change.removed) {
          result.push({ type: 'removed', content: line, oldLineNum: oldLine++, newLineNum: null });
        } else {
          result.push({ type: 'unchanged', content: line, oldLineNum: oldLine++, newLineNum: newLine++ });
        }
      }
    }

    return result;
  }, [changes]);

  return (
    <div className="font-mono text-xs">
      {/* Stats header */}
      <div className="px-4 py-2 border-b border-border/30 text-xs text-muted-foreground/60 flex gap-3">
        <span className="text-green-500">+{stats.additions}</span>
        <span className="text-red-500">-{stats.deletions}</span>
      </div>

      {/* Diff lines */}
      <div className="leading-relaxed overflow-x-auto">
        {diffLinesData.map((line, index) => {
          const bgClass =
            line.type === 'added'
              ? 'bg-green-500/10'
              : line.type === 'removed'
                ? 'bg-red-500/10'
                : '';

          const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';

          return (
            <div key={index} className={`px-4 whitespace-pre ${bgClass}`}>
              <span className="text-muted-foreground/40 select-none inline-block w-8 text-right mr-3 tabular-nums">
                {line.oldLineNum ?? ''}
              </span>
              <span className="text-muted-foreground/40 select-none inline-block w-8 text-right mr-3 tabular-nums">
                {line.newLineNum ?? ''}
              </span>
              <span className="text-muted-foreground/50 select-none mr-1">{prefix}</span>
              <span>{line.content}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
