import { cva, type VariantProps } from 'class-variance-authority';
import { diffLines } from 'diff';
import parseDiff from 'parse-diff';
import { useMemo, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';

type DiffLineType = 'add' | 'del' | 'normal';

interface ParsedLine {
  type: DiffLineType;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

interface ParsedFile {
  oldName?: string;
  newName?: string;
  lines: ParsedLine[];
  additions: number;
  deletions: number;
}

interface SplitLinePair {
  left: ParsedLine | null;
  right: ParsedLine | null;
}

const diffViewerVariants = cva('aui-diff-viewer overflow-hidden rounded-lg font-mono text-sm', {
  variants: {
    variant: {
      default: 'border bg-background',
      ghost: 'bg-transparent',
      muted: 'border border-muted-foreground/20 bg-muted',
    },
    size: {
      sm: 'text-xs',
      default: 'text-sm',
      lg: 'text-base',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
});

const diffLineVariants = cva('flex', {
  variants: {
    type: {
      add: 'bg-[var(--diff-add-bg,_rgba(46,160,67,0.15))]',
      del: 'bg-[var(--diff-del-bg,_rgba(248,81,73,0.15))]',
      normal: '',
      empty: '',
    },
  },
  defaultVariants: {
    type: 'normal',
  },
});

const diffLineTextVariants = cva('', {
  variants: {
    type: {
      add: 'text-[var(--diff-add-text,_#1a7f37)] dark:text-[var(--diff-add-text-dark,_#3fb950)]',
      del: 'text-[var(--diff-del-text,_#cf222e)] dark:text-[var(--diff-del-text-dark,_#f85149)]',
      normal: '',
      empty: '',
    },
  },
  defaultVariants: {
    type: 'normal',
  },
});

export interface DiffViewerProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>,
    VariantProps<typeof diffViewerVariants> {
  oldFile?: string | { content: string; name?: string };
  newFile?: string | { content: string; name?: string };
  patch?: string;
  code?: string;
  oldFileName?: string;
  newFileName?: string;
  language?: string;
  viewMode?: 'split' | 'unified';
  showLineNumbers?: boolean;
  showIcon?: boolean;
  showStats?: boolean;
  showFileBadge?: boolean;
  showHunkHeaders?: boolean;
  showNoNewlineMarker?: boolean;
}

export function DiffViewer({
  oldFile,
  newFile,
  patch,
  code,
  oldFileName,
  newFileName,
  language: _language,
  viewMode = 'unified',
  showLineNumbers = true,
  showIcon,
  showStats = true,
  showFileBadge,
  showHunkHeaders: _showHunkHeaders,
  showNoNewlineMarker: _showNoNewlineMarker,
  variant,
  size,
  className,
  ...props
}: DiffViewerProps) {
  const diffPatch = patch ?? code;
  const iconVisible = showIcon ?? showFileBadge ?? true;

  const parsedFiles = useMemo(() => {
    if (diffPatch) return parsePatch(diffPatch);

    if (oldFile !== undefined && newFile !== undefined) {
      const oldResolved = resolveFile(oldFile, oldFileName);
      const newResolved = resolveFile(newFile, newFileName ?? oldResolved.name);
      const diff = computeDiff(oldResolved.content, newResolved.content);

      return [
        {
          oldName: oldResolved.name,
          newName: newResolved.name,
          ...diff,
        },
      ];
    }

    return [];
  }, [diffPatch, newFile, newFileName, oldFile, oldFileName]);

  if (parsedFiles.length === 0) {
    return (
      <pre data-slot="diff-viewer" className={cn('rounded-lg bg-muted p-4', className)}>
        No diff content provided
      </pre>
    );
  }

  return (
    <div
      data-slot="diff-viewer"
      data-view-mode={viewMode}
      data-variant={variant ?? 'default'}
      data-size={size ?? 'default'}
      className={cn(diffViewerVariants({ variant, size }), className)}
      {...props}
    >
      {parsedFiles.map((file, fileIndex) => (
        <DiffViewerFile key={fileIndex}>
          <DiffViewerHeader
            oldName={file.oldName}
            newName={file.newName}
            additions={file.additions}
            deletions={file.deletions}
            showIcon={iconVisible}
            showStats={showStats}
          />
          <DiffViewerContent>
            {viewMode === 'split'
              ? pairLinesForSplit(file.lines).map((pair, pairIndex) => (
                  <DiffViewerSplitLine key={pairIndex} pair={pair} showLineNumbers={showLineNumbers} />
                ))
              : file.lines.map((line, lineIndex) => (
                  <DiffViewerLine key={lineIndex} line={line} showLineNumbers={showLineNumbers} />
                ))}
          </DiffViewerContent>
        </DiffViewerFile>
      ))}
    </div>
  );
}

function parsePatch(patch: string): ParsedFile[] {
  return parseDiff(patch).map((file) => {
    const lines: ParsedLine[] = [];
    let additions = 0;
    let deletions = 0;

    for (const chunk of file.chunks) {
      let oldLine = chunk.oldStart;
      let newLine = chunk.newStart;

      for (const change of chunk.changes) {
        if (isNoNewlineMarker(change.content)) continue;

        if (change.type === 'add') {
          additions++;
          lines.push({ type: 'add', content: change.content.slice(1), newLineNumber: newLine++ });
        } else if (change.type === 'del') {
          deletions++;
          lines.push({ type: 'del', content: change.content.slice(1), oldLineNumber: oldLine++ });
        } else {
          lines.push({
            type: 'normal',
            content: change.content.slice(1),
            oldLineNumber: oldLine++,
            newLineNumber: newLine++,
          });
        }
      }
    }

    return {
      oldName: file.from,
      newName: file.to,
      lines,
      additions,
      deletions,
    };
  });
}

function computeDiff(oldContent: string, newContent: string) {
  const changes = diffLines(oldContent, newContent);
  const lines: ParsedLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let additions = 0;
  let deletions = 0;

  for (const change of changes) {
    const contentLines = change.value.replace(/\n$/, '').split('\n');

    for (const content of contentLines) {
      if (content === '' && contentLines.length === 1 && change.value === '') continue;

      if (change.added) {
        additions++;
        lines.push({ type: 'add', content, newLineNumber: newLine++ });
      } else if (change.removed) {
        deletions++;
        lines.push({ type: 'del', content, oldLineNumber: oldLine++ });
      } else {
        lines.push({
          type: 'normal',
          content,
          oldLineNumber: oldLine++,
          newLineNumber: newLine++,
        });
      }
    }
  }

  return { lines, additions, deletions };
}

function pairLinesForSplit(lines: ParsedLine[]): SplitLinePair[] {
  const pairs: SplitLinePair[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.type === 'normal') {
      pairs.push({ left: line, right: line });
      index++;
    } else if (line.type === 'del') {
      const deletions: ParsedLine[] = [];
      while (index < lines.length && lines[index]!.type === 'del') deletions.push(lines[index++]!);

      const additions: ParsedLine[] = [];
      while (index < lines.length && lines[index]!.type === 'add') additions.push(lines[index++]!);

      const maxLength = Math.max(deletions.length, additions.length);
      for (let pairIndex = 0; pairIndex < maxLength; pairIndex++) {
        pairs.push({ left: deletions[pairIndex] ?? null, right: additions[pairIndex] ?? null });
      }
    } else {
      pairs.push({ left: null, right: line });
      index++;
    }
  }

  return pairs;
}

function DiffViewerFile({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="diff-viewer-file" className={cn(className)} {...props} />;
}

function DiffViewerContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="diff-viewer-content" className={cn('overflow-x-auto', className)} {...props} />;
}

function DiffViewerHeader({
  oldName,
  newName,
  additions = 0,
  deletions = 0,
  showIcon = true,
  showStats = true,
  className,
  ...props
}: ComponentProps<'div'> & {
  oldName?: string;
  newName?: string;
  additions?: number;
  deletions?: number;
  showIcon?: boolean;
  showStats?: boolean;
}) {
  if (!oldName && !newName) return null;

  const displayName = newName || oldName;

  return (
    <div
      data-slot="diff-viewer-header"
      className={cn('flex items-center gap-2 border-b bg-muted px-4 py-2 text-muted-foreground', className)}
      {...props}
    >
      {showIcon && <DiffViewerFileBadge filename={displayName} />}
      <span className="flex-1 truncate">
        {oldName && newName && oldName !== newName ? (
          <>
            <span className="text-red-600 dark:text-red-400">{oldName}</span>
            {' -> '}
            <span className="text-green-600 dark:text-green-400">{newName}</span>
          </>
        ) : (
          displayName
        )}
      </span>
      {showStats && (additions > 0 || deletions > 0) && <DiffViewerStats additions={additions} deletions={deletions} />}
    </div>
  );
}

function DiffViewerFileBadge({ filename }: { filename?: string }) {
  const ext = filename?.split('.').pop()?.toUpperCase();
  if (!ext) return null;

  return (
    <span
      data-slot="diff-viewer-file-badge"
      className="inline-flex size-5 shrink-0 items-end justify-end rounded-sm border bg-background text-[8px] font-bold leading-none"
    >
      <span className="p-0.5">{ext}</span>
    </span>
  );
}

function DiffViewerStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span data-slot="diff-viewer-stats" className="flex gap-2 text-xs">
      <span className="text-green-600 dark:text-green-400">+{additions}</span>
      <span className="text-red-600 dark:text-red-400">-{deletions}</span>
    </span>
  );
}

function DiffViewerLine({
  line,
  showLineNumbers = true,
  className,
  ...props
}: ComponentProps<'div'> & { line: ParsedLine; showLineNumbers?: boolean }) {
  const indicator = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';

  return (
    <div
      data-slot="diff-viewer-line"
      data-type={line.type}
      className={cn(diffLineVariants({ type: line.type }), className)}
      {...props}
    >
      {showLineNumbers && (
        <span data-slot="diff-viewer-line-number" className="w-8 shrink-0 px-2 text-end text-muted-foreground select-none">
          {line.type === 'add' ? line.newLineNumber : line.oldLineNumber}
        </span>
      )}
      <span
        data-slot="diff-viewer-indicator"
        className={cn('w-4 shrink-0 text-center select-none', diffLineTextVariants({ type: line.type }))}
      >
        {indicator}
      </span>
      <span data-slot="diff-viewer-content" className={cn('flex-1 break-all whitespace-pre-wrap', diffLineTextVariants({ type: line.type }))}>
        {line.content}
      </span>
    </div>
  );
}

function DiffViewerSplitLine({
  pair,
  showLineNumbers = true,
  className,
  ...props
}: ComponentProps<'div'> & { pair: SplitLinePair; showLineNumbers?: boolean }) {
  return (
    <div data-slot="diff-viewer-split-line" className={cn('flex', className)} {...props}>
      <SplitLineSide line={pair.left} side="left" showLineNumbers={showLineNumbers} />
      <SplitLineSide line={pair.right} side="right" showLineNumbers={showLineNumbers} />
    </div>
  );
}

function SplitLineSide({ line, side, showLineNumbers }: { line: ParsedLine | null; side: 'left' | 'right'; showLineNumbers: boolean }) {
  const type = line?.type ?? 'empty';
  const number = side === 'left' ? line?.oldLineNumber : line?.newLineNumber;
  const indicator = !line ? '' : line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';

  return (
    <div
      data-slot={side === 'left' ? 'diff-viewer-split-left' : 'diff-viewer-split-right'}
      data-type={type}
      className={cn('flex w-1/2 border-e last:border-e-0', diffLineVariants({ type }))}
    >
      {showLineNumbers && <span className="w-12 shrink-0 px-2 text-end text-muted-foreground select-none">{number ?? ''}</span>}
      <span className={cn('w-4 shrink-0 text-center select-none', diffLineTextVariants({ type }))}>{indicator}</span>
      <span className={cn('flex-1 break-all whitespace-pre-wrap', diffLineTextVariants({ type }))}>{line?.content ?? ''}</span>
    </div>
  );
}

function resolveFile(file: string | { content: string; name?: string }, fallbackName?: string) {
  if (typeof file === 'string') return { content: file, name: fallbackName };
  return { content: file.content, name: file.name ?? fallbackName };
}

function isNoNewlineMarker(content: string) {
  return content.startsWith('\\ No newline at end of file');
}

DiffViewer.displayName = 'DiffViewer';

export type { ParsedFile, ParsedLine, SplitLinePair };
