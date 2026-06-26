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
      <div className="overflow-x-auto">
        <div className="table w-max min-w-full leading-relaxed">
          {diffLinesData.map((line, index) => {
            const bgClass =
              line.type === 'added'
                ? 'bg-[#dafbe1] text-[#116329] dark:bg-[#12361f] dark:text-[#d8f7df]'
                : line.type === 'removed'
                  ? 'bg-[#ffebe9] text-[#82071e] dark:bg-[#4a1515] dark:text-[#ffd7d5]'
                  : '';
            const gutterClass =
              line.type === 'added'
                ? 'text-[#1a7f37]/70 dark:text-[#7ee787]/70'
                : line.type === 'removed'
                  ? 'text-[#cf222e]/70 dark:text-[#ff7b72]/75'
                  : 'text-muted-foreground/40';

            const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';

            return (
              <div key={index} className={`table-row whitespace-pre ${bgClass}`}>
                <span className={`${gutterClass} table-cell w-8 select-none pl-4 pr-3 text-right tabular-nums`}>
                  {line.oldLineNum ?? ''}
                </span>
                <span className={`${gutterClass} table-cell w-8 select-none pr-3 text-right tabular-nums`}>
                  {line.newLineNum ?? ''}
                </span>
                <span className={`${gutterClass} table-cell select-none pr-1`}>{prefix}</span>
                <span className="table-cell pr-4">{line.content}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
