import { diffLines, Change } from 'diff';

interface DiffViewProps {
  oldContent: string;
  newContent: string;
}

export function DiffView({ oldContent, newContent }: DiffViewProps) {
  const changes: Change[] = diffLines(oldContent, newContent);

  return (
    <div className="font-mono text-sm leading-relaxed">
      {changes.map((change, index) => {
        const lines = change.value.split('\n').filter((_, i, arr) =>
          i < arr.length - 1 || arr[arr.length - 1] !== ''
        );
        return lines.map((line, lineIndex) => {
          let bgClass = '';
          let prefix = ' ';
          if (change.added) {
            bgClass = 'bg-[#1e6f50]';
            prefix = '+';
          } else if (change.removed) {
            bgClass = 'bg-[#7f1d1d]';
            prefix = '-';
          }
          return (
            <div key={`${index}-${lineIndex}`} className={`px-4 ${bgClass}`}>
              <span className="text-zinc-500 select-none mr-2 inline-block w-4 text-right">{prefix}</span>
              <span className="text-zinc-300">{line}</span>
            </div>
          );
        });
      })}
    </div>
  );
}
