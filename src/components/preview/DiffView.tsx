import { Suspense, lazy, useMemo, useState } from 'react';
import { Columns2, Rows2 } from 'lucide-react';
import { diffLines, Change } from 'diff';
import { countDiffChanges, splitDiffLines } from '../../lib/diffStats';
import { useSupportsRichCodeEditor } from '../../lib/monacoHost';
import { cn } from '../../lib/utils';
import { MonacoLoading } from '../code/MonacoLoading';
import type { DiffViewMode } from '../code/MonacoDiffView';

interface DiffViewProps {
  oldContent: string;
  newContent: string;
  /** 用于让 Monaco 选语言;缺省时退回纯文本高亮。 */
  filePath?: string;
  /**
   * `full`(默认):填满容器、带滚动,用于文件差异标签页 —— Monaco diff editor。
   * `inline`:内容驱动高度,用于列表/手风琴里的内联差异。这里刻意不挂 Monaco:
   * 手风琴的高度由内容决定,Monaco 需要确定高度;而且展开多行就是多个重量级实例。
   */
  variant?: 'full' | 'inline';
}

export type DiffViewVariant = NonNullable<DiffViewProps['variant']>;

type DiffLine = {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  oldLineNum: number | null;
  newLineNum: number | null;
};

type DisplayDiffLine = DiffLine | {
  type: 'omitted';
  content: string;
  oldLineNum: null;
  newLineNum: null;
};

const DIFF_CONTEXT_LINES = 3;

const MonacoDiffView = lazy(() => import('../code/MonacoDiffView'));

// 视图方式是全局偏好:所有 diff 标签页共用,跨会话记住。
const DIFF_VIEW_MODE_STORAGE_KEY = 'codemux:diff-view-mode';

export function readDiffViewMode(): DiffViewMode {
  try {
    return localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY) === 'unified' ? 'unified' : 'split';
  } catch {
    return 'split';
  }
}

function storeDiffViewMode(mode: DiffViewMode): void {
  try {
    localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // 隐私模式等场景写不进 localStorage,只影响下次不记住,不值得报错。
  }
}

function DiffStatsHeader({
  additions,
  deletions,
  actions,
}: {
  additions: number;
  deletions: number;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border/30 px-4 py-2 text-xs text-muted-foreground/60">
      <span className="text-[hsl(var(--success))]">+{additions}</span>
      <span className="text-[hsl(var(--destructive))]">-{deletions}</span>
      {actions ? <div className="ml-auto flex items-center">{actions}</div> : null}
    </div>
  );
}

function DiffViewModeToggle({
  value,
  onChange,
}: {
  value: DiffViewMode;
  onChange: (mode: DiffViewMode) => void;
}) {
  const option = (mode: DiffViewMode, label: string, Icon: typeof Columns2) => (
    <button
      type="button"
      role="tab"
      aria-selected={value === mode}
      onClick={() => onChange(mode)}
      className={cn(
        'flex items-center gap-1 rounded px-1.5 py-0.5 text-ui-micro transition-colors',
        value === mode
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground/65 hover:text-foreground',
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </button>
  );

  return (
    <div
      className="flex items-center rounded-md border border-border/40 bg-muted/20 p-0.5"
      role="tablist"
      aria-label="Diff 视图方式"
    >
      {option('split', '并排', Columns2)}
      {option('unified', '内联', Rows2)}
    </div>
  );
}

/** 轻量内联差异:未变更段落折叠成 `...`,高度跟随内容。 */
export function InlineDiffLines({ oldContent, newContent }: DiffViewProps) {
  const changes: Change[] = useMemo(() => diffLines(oldContent, newContent), [oldContent, newContent]);

  const diffLinesData = useMemo(() => {
    return compactDiffLines(buildDiffLines(changes), DIFF_CONTEXT_LINES);
  }, [changes]);

  return (
    <div className="overflow-x-auto font-mono text-code">
      <div className="table w-max min-w-full leading-relaxed">
        {diffLinesData.map((line, index) => {
          const bgClass =
            line.type === 'added'
              ? 'bg-[#dafbe1] text-[#116329] dark:bg-[#12361f] dark:text-[#d8f7df]'
              : line.type === 'removed'
                ? 'bg-[#ffebe9] text-[#82071e] dark:bg-[#4a1515] dark:text-[#ffd7d5]'
                : line.type === 'omitted'
                  ? 'bg-muted/35 text-muted-foreground/55'
                  : '';
          const gutterClass =
            line.type === 'added'
              ? 'text-[#1a7f37]/70 dark:text-[#7ee787]/70'
              : line.type === 'removed'
                ? 'text-[#cf222e]/70 dark:text-[#ff7b72]/75'
                : 'text-muted-foreground/40';

          const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : line.type === 'omitted' ? '' : ' ';

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
  );
}

export function DiffView({ oldContent, newContent, filePath, variant = 'full' }: DiffViewProps) {
  const richEditor = useSupportsRichCodeEditor();
  const changes: Change[] = useMemo(() => diffLines(oldContent, newContent), [oldContent, newContent]);
  const stats = useMemo(() => countDiffChanges(changes), [changes]);
  const [viewMode, setViewMode] = useState<DiffViewMode>(readDiffViewMode);

  const handleViewModeChange = (mode: DiffViewMode) => {
    setViewMode(mode);
    storeDiffViewMode(mode);
  };

  const inlineBody = <InlineDiffLines oldContent={oldContent} newContent={newContent} />;

  // 内联变体(手风琴)保持内容驱动高度:加外壳反而会把高度压成 0。
  if (variant === 'inline') {
    return (
      <div data-testid="inline-diff-view" className="font-mono text-code">
        <DiffStatsHeader additions={stats.additions} deletions={stats.deletions} />
        {inlineBody}
      </div>
    );
  }

  const body = richEditor ? (
    <div data-testid="monaco-diff-surface" className="min-h-0 flex-1">
      <Suspense fallback={<MonacoLoading label="Diff 加载中" />}>
        <MonacoDiffView
          oldContent={oldContent}
          newContent={newContent}
          filePath={filePath}
          viewMode={viewMode}
        />
      </Suspense>
    </div>
  ) : (
    // 移动形态:Monaco 不支持移动浏览器,退回轻量渲染。
    <div className="min-h-0 flex-1 overflow-auto" data-testid="highlight-diff-surface">
      {inlineBody}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col font-mono text-code">
      <DiffStatsHeader
        additions={stats.additions}
        deletions={stats.deletions}
        actions={richEditor ? (
          <DiffViewModeToggle value={viewMode} onChange={handleViewModeChange} />
        ) : undefined}
      />
      {body}
    </div>
  );
}

function buildDiffLines(changes: Change[]): DiffLine[] {
  const result: DiffLine[] = [];
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
}

function compactDiffLines(lines: DiffLine[], contextLines: number): DisplayDiffLine[] {
  const changedLineIndexes = lines
    .map((line, index) => (line.type === 'unchanged' ? -1 : index))
    .filter((index) => index >= 0);

  if (changedLineIndexes.length === 0) return lines;

  const visibleIndexes = new Set<number>();
  for (const index of changedLineIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    for (let visibleIndex = start; visibleIndex <= end; visibleIndex += 1) {
      visibleIndexes.add(visibleIndex);
    }
  }

  const result: DisplayDiffLine[] = [];
  let previousWasOmitted = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (visibleIndexes.has(index)) {
      result.push(lines[index]);
      previousWasOmitted = false;
    } else if (!previousWasOmitted) {
      result.push({ type: 'omitted', content: '...', oldLineNum: null, newLineNum: null });
      previousWasOmitted = true;
    }
  }

  return result;
}
