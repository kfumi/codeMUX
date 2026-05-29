import { useMemo } from 'react';

interface FileViewProps {
  content: string;
}

export function FileView({ content }: FileViewProps) {
  const lines = useMemo(() => content.split('\n'), [content]);

  return (
    <div className="font-mono text-sm leading-relaxed">
      {lines.map((line, index) => (
        <div key={index} className="px-4 hover:bg-zinc-800/50">
          <span className="text-zinc-600 select-none mr-4 inline-block w-8 text-right">
            {index + 1}
          </span>
          <span className="text-zinc-300">{line}</span>
        </div>
      ))}
    </div>
  );
}
