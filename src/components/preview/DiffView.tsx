import { useMemo } from 'react';
import { diffLines, Change } from 'diff';
import { countDiffChanges, splitDiffLines } from '../../lib/diffStats';

interface DiffViewProps {
  oldContent: string;
  newContent: string;
}

export function DiffView({ oldContent, newContent }: DiffViewProps) {
  const changes: Change[] = useMemo(() => diffLines(oldContent, newContent), [oldContent, newContent]);

  const stats = useMemo(() => {
    return countDiffChanges(changes);
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
      const lines = splitDiffLines(change.value);
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
        <span className="text-[hsl(var(--success))]">+{stats.additions}</span>
        <span className="text-[hsl(var(--destructive))]">-{stats.deletions}</span>
      </div>

      {/* Diff lines */}
      <div className="leading-relaxed overflow-x-auto">
        {diffLinesData.map((line, index) => {
          const bgClass =
            line.type === 'added'
              ? 'bg-[hsl(var(--success)/0.09)]'
              : line.type === 'removed'
                ? 'bg-[hsl(var(--destructive)/0.09)]'
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
