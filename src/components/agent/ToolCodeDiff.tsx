import { DiffViewer } from '@/components/assistant-ui/diff-viewer';
import { countDiffLines } from '@/lib/diffStats';
import { cn } from '@/lib/utils';

interface ToolCodeDiffProps {
  toolName: string;
  input: Record<string, unknown>;
}

type ContentDiff = {
  kind: 'content';
  filePath: string;
  oldFile: string;
  newFile: string;
};

type PatchDiff = {
  kind: 'patch';
  files: PatchFile[];
};

type PatchFile = {
  operation: 'add' | 'update' | 'delete';
  path: string;
  lines: string[];
};

export function getCodeChangeFilePath(input: Record<string, unknown>): string | undefined {
  const filePath = input.file_path ?? input.filePath;
  if (typeof filePath === 'string' && filePath.trim()) {
    return getFileName(normalizePath(filePath));
  }

  const patchFiles = getApplyPatchFiles(input);
  if (!patchFiles.length) return undefined;

  return patchFiles.map((file) => getFileName(normalizePath(file.path))).join(', ');
}

function getFileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function getCodeChangeDiff(input: Record<string, unknown>): ContentDiff | PatchDiff | null {
  const filePath = getCodeChangeFilePath(input);
  const oldString = input.old_string ?? input.oldString;
  const newString = input.new_string ?? input.newString;
  if (filePath && typeof oldString === 'string' && typeof newString === 'string') {
    return { kind: 'content', filePath, oldFile: oldString, newFile: newString };
  }

  const content = input.content;
  if (filePath && typeof content === 'string') {
    return { kind: 'content', filePath, oldFile: '', newFile: content };
  }

  const patchFiles = getApplyPatchFiles(input);
  if (patchFiles.length) return { kind: 'patch', files: patchFiles };

  return null;
}

export function getCodeChangeStats(input: Record<string, unknown>): { additions: number; deletions: number } | null {
  const diff = getCodeChangeDiff(input);
  if (!diff) return null;
  if (diff.kind === 'content') {
    return countDiffLines(diff.oldFile, diff.newFile);
  }
  let additions = 0;
  let deletions = 0;
  for (const file of diff.files) {
    for (const line of file.lines) {
      if (isAddedPatchLine(line)) additions++;
      if (isDeletedPatchLine(line)) deletions++;
    }
  }
  return { additions, deletions };
}

export function ToolCodeDiff({ toolName, input }: ToolCodeDiffProps) {
  const diff = getCodeChangeDiff(input);
  if (!diff || !isCodeChangeTool(toolName, input)) return null;

  if (diff.kind === 'patch') {
    return (
      <div className="px-3.5">
        <PatchDiffViewer
          files={diff.files}
          className="max-h-90 overflow-auto rounded-md border border-border/45 bg-background/70 text-[11px]"
        />
      </div>
    );
  }

  return (
    <div className="px-3.5">
      <DiffViewer
        oldFile={diff.oldFile}
        newFile={diff.newFile}
        oldFileName={diff.filePath}
        newFileName={diff.filePath}
        viewMode="unified"
        showIcon={false}
        showHunkHeaders={false}
        showNoNewlineMarker={false}
        className="max-h-90 overflow-auto border-border/45 text-[11px] [--diff-add-bg:rgba(46,160,67,0.16)] [--diff-del-bg:rgba(248,81,73,0.16)]"
      />
    </div>
  );
}

const CODE_CHANGE_TOOL_NAMES = new Set(['write', 'edit']);

export function isCodeChangeTool(toolName: string, input?: Record<string, unknown>) {
  if (CODE_CHANGE_TOOL_NAMES.has(toolName.toLowerCase())) return true;
  if ((toolName === 'Bash' || toolName === 'shell_command') && input) {
    return getApplyPatchFiles(input).length > 0;
  }

  return false;
}

function normalizePath(path: string): string {
  return path.replace(/\\\\/g, '\\');
}

function PatchDiffViewer({ files, className }: { files: PatchFile[]; className?: string }) {
  return (
    <div
      data-slot="diff-viewer"
      data-view-mode="unified"
      className={cn(
        'aui-diff-viewer overflow-auto rounded-lg border bg-background font-mono text-sm text-foreground [--diff-add-bg:rgba(46,160,67,0.16)] [--diff-del-bg:rgba(248,81,73,0.16)]',
        className,
      )}
    >
      {files.map((file, index) => (
        <PatchDiffFile key={`${file.path}-${index}`} file={file} />
      ))}
    </div>
  );
}

function PatchDiffFile({ file }: { file: PatchFile }) {
  const additions = file.lines.filter(isAddedPatchLine).length;
  const deletions = file.lines.filter(isDeletedPatchLine).length;

  return (
    <div data-slot="diff-viewer-file" className="min-w-max">
      <div data-slot="diff-viewer-header" className="sticky top-0 z-1 flex items-center gap-2 border-b bg-muted px-4 py-2 text-muted-foreground">
        <span className="flex-1 truncate">{normalizePath(file.path)}</span>
        <span className="rounded border bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-normal">{file.operation}</span>
        <span className="text-green-600 dark:text-green-400">+{additions}</span>
        <span className="text-red-600 dark:text-red-400">-{deletions}</span>
      </div>
      <div data-slot="diff-viewer-file-content">
        {file.lines.map((line, index) => (
          <PatchDiffLine key={`${index}-${line}`} line={line} />
        ))}
      </div>
    </div>
  );
}

function PatchDiffLine({ line }: { line: string }) {
  const type = getPatchLineType(line);
  const prefix = type === 'add' || type === 'del' ? line.slice(0, 1) : '';
  const content = type === 'add' || type === 'del' ? line.slice(1) : line;

  return (
    <div
      data-slot="diff-viewer-line"
      data-type={type}
      className={cn('flex min-w-full leading-5', type === 'add' && 'bg-(--diff-add-bg)', type === 'del' && 'bg-(--diff-del-bg)')}
    >
      <span className="w-12 shrink-0 px-2 text-end text-muted-foreground select-none" />
      <span
        className={cn(
          'w-4 shrink-0 text-center select-none',
          type === 'add' && 'text-(--diff-add-text-dark,#3fb950)',
          type === 'del' && 'text-(--diff-del-text-dark,#f85149)',
        )}
      >
        {prefix}
      </span>
      <span
        className={cn(
          'flex-1 whitespace-pre',
          type === 'add' && 'text-(--diff-add-text-dark,#3fb950)',
          type === 'del' && 'text-(--diff-del-text-dark,#f85149)',
        )}
      >
        {content}
      </span>
    </div>
  );
}

function getPatchLineType(line: string) {
  if (isAddedPatchLine(line)) return 'add';
  if (isDeletedPatchLine(line)) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('***')) return 'meta';
  return 'normal';
}

function isAddedPatchLine(line: string) {
  return line.startsWith('+') && !line.startsWith('+++');
}

function isDeletedPatchLine(line: string) {
  return line.startsWith('-') && !line.startsWith('---');
}

function getApplyPatchFiles(input: Record<string, unknown>): PatchFile[] {
  const patch = extractApplyPatchText(input);
  if (!patch) return [];

  const files: PatchFile[] = [];
  let currentFile: PatchFile | undefined;

  for (const line of patch.split(/\r?\n/)) {
    const operation = parsePatchFileOperation(line);
    if (operation) {
      currentFile = { ...operation, lines: [] };
      files.push(currentFile);
      continue;
    }

    if (!currentFile || shouldHidePatchLine(line)) {
      continue;
    }

    currentFile.lines.push(line);
  }

  return files;
}

function shouldHidePatchLine(line: string) {
  return (
    line === '*** Begin Patch' ||
    line === '*** End Patch' ||
    line.startsWith('***') ||
    line.startsWith('@@') ||
    line.startsWith('\\ No newline at end of file')
  );
}

function parsePatchFileOperation(line: string): Omit<PatchFile, 'lines'> | null {
  const addMatch = line.match(/^\*\*\* Add File: (.+)$/);
  if (addMatch) return { operation: 'add', path: addMatch[1] };

  const updateMatch = line.match(/^\*\*\* Update File: (.+)$/);
  if (updateMatch) return { operation: 'update', path: updateMatch[1] };

  const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/);
  if (deleteMatch) return { operation: 'delete', path: deleteMatch[1] };

  return null;
}

function extractApplyPatchText(input: Record<string, unknown>): string | undefined {
  const command = getCommandText(input);
  if (!command) return undefined;

  const beginMarker = '*** Begin Patch';
  const endMarker = '*** End Patch';
  const beginIndex = command.indexOf(beginMarker);
  if (beginIndex < 0) return undefined;

  const endIndex = command.indexOf(endMarker, beginIndex);
  if (endIndex < 0) return undefined;

  return command.slice(beginIndex, endIndex + endMarker.length);
}

function getCommandText(input: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'cmd', 'script']) {
    const value = input[key];
    if (typeof value === 'string' && value.includes('*** Begin Patch')) {
      return value;
    }
  }

  return undefined;
}
