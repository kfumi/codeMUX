import { DiffViewer } from '@/components/assistant-ui/diff-viewer';
import { FileTypeIcon } from '@/components/assistant-ui/file-type-icon';
import { countDiffLines, parseUnifiedDiffPatch } from '@/lib/diffStats';
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

type EditHunk = {
  oldText: string;
  newText: string;
};

type EditsDiff = {
  kind: 'edits';
  filePath: string;
  edits: EditHunk[];
};

/** Codex app-server 的 `file_change`：一次工具调用可包含多个文件的改动。 */
type ChangesDiff = {
  kind: 'changes';
  files: ChangeFile[];
};

type ChangeFile = {
  filePath: string;
  oldFile: string;
  newFile: string;
};

type PatchFile = {
  operation: 'add' | 'update' | 'delete';
  path: string;
  lines: string[];
};

export function getCodeChangeFilePath(input: Record<string, unknown>): string | undefined {
  const filePath = input.file_path ?? input.filePath ?? input.path;
  if (typeof filePath === 'string' && filePath.trim()) {
    return getFileName(normalizePath(filePath));
  }

  const changeFiles = getChangeFiles(input);
  if (changeFiles.length) {
    return changeFiles.map((file) => file.filePath).join(', ');
  }

  const patchFiles = getApplyPatchFiles(input);
  if (!patchFiles.length) return undefined;

  return patchFiles.map((file) => getFileName(normalizePath(file.path))).join(', ');
}

function getFileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function getCodeChangeDiff(input: Record<string, unknown>): ContentDiff | PatchDiff | EditsDiff | ChangesDiff | null {
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

  const changeFiles = getChangeFiles(input);
  if (changeFiles.length) {
    return { kind: 'changes', files: changeFiles };
  }

  const edits = getEditHunks(input);
  if (filePath && edits.length) {
    return { kind: 'edits', filePath, edits };
  }

  const patchFiles = getApplyPatchFiles(input);
  if (patchFiles.length) return { kind: 'patch', files: patchFiles };

  return null;
}

/**
 * Codex app-server 的 `file_change` 工具参数：`{ changes: [{ kind, path, diff }] }`。
 * `diff` 在 add/delete 时是整份文件内容；update（该版本的 `kind` 可能是空串）则是
 * 一段不带 `---`/`+++` 头的 unified diff，只有 `@@` 和 +/- 行。
 * sidecar 侧（`turnArtifactSummary.ts`）与 daemon 侧（`turn_artifact_summary.rs`）
 * 对同一形状的解读一致，这里保持同一条判定。
 */
function getChangeFiles(input: Record<string, unknown>): ChangeFile[] {
  const changes = input.changes;
  if (!Array.isArray(changes)) return [];

  const files: ChangeFile[] = [];
  for (const entry of changes) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const path = record.path;
    const diff = record.diff;
    if (typeof path !== 'string' || !path.trim() || typeof diff !== 'string' || !diff.trim()) {
      continue;
    }

    const filePath = getFileName(normalizePath(path));
    const kind = typeof record.kind === 'string' ? record.kind.toLowerCase() : '';
    if (kind === 'delete') {
      files.push({ filePath, oldFile: diff, newFile: '' });
      continue;
    }
    if (kind === 'add') {
      files.push({ filePath, oldFile: '', newFile: diff });
      continue;
    }

    const parsed = parseUnifiedDiffPatch(diff);
    files.push(parsed
      ? {
        filePath,
        // hunk 里的每一行按约定都以换行结尾。补上末尾换行后再交给行级 diff，
        // 否则末行没有换行符时会被当成"整行被替换"，把未改动的行也标成 +/-。
        oldFile: terminateLines(parsed.oldContent),
        newFile: terminateLines(parsed.newContent),
      }
      : { filePath, oldFile: '', newFile: diff });
  }

  return files;
}

function terminateLines(text: string): string {
  if (text === '') return '';
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Normalizes an edit tool's hunk list. Handles pi's `{ edits: [{ oldText, newText }] }`
 * shape alongside the flat `old_string`/`new_string` (Claude/OpenCode) shape.
 */
function getEditHunks(input: Record<string, unknown>): EditHunk[] {
  const edits = input.edits;
  if (Array.isArray(edits)) {
    const hunks: EditHunk[] = [];
    for (const entry of edits) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const oldText = record.oldText ?? record.old_string ?? record.oldString;
      const newText = record.newText ?? record.new_string ?? record.newString;
      if (typeof oldText !== 'string' || typeof newText !== 'string') continue;
      hunks.push({ oldText, newText });
    }
    return hunks;
  }

  return [];
}

export function getCodeChangeStats(input: Record<string, unknown>): { additions: number; deletions: number } | null {
  const diff = getCodeChangeDiff(input);
  if (!diff) return null;
  if (diff.kind === 'content') {
    return countDiffLines(diff.oldFile, diff.newFile);
  }
  if (diff.kind === 'edits') {
    let additions = 0;
    let deletions = 0;
    for (const edit of diff.edits) {
      const stats = countDiffLines(edit.oldText, edit.newText);
      additions += stats.additions;
      deletions += stats.deletions;
    }
    return { additions, deletions };
  }
  if (diff.kind === 'changes') {
    let additions = 0;
    let deletions = 0;
    for (const file of diff.files) {
      const stats = countDiffLines(file.oldFile, file.newFile);
      additions += stats.additions;
      deletions += stats.deletions;
    }
    return { additions, deletions };
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
      <PatchDiffViewer
        files={diff.files}
        className="max-h-90 overflow-auto rounded-md border border-border/45 bg-background/70 text-code"
      />
    );
  }

  if (diff.kind === 'changes') {
    return (
      <div className="space-y-2">
        {diff.files.map((file, index) => (
          <DiffViewer
            key={`${file.filePath}-${index}`}
            oldFile={file.oldFile}
            newFile={file.newFile}
            oldFileName={file.filePath}
            newFileName={file.filePath}
            viewMode="unified"
            showIcon={false}
            showHunkHeaders={false}
            showNoNewlineMarker={false}
            className="max-h-90 overflow-auto border-border/45 text-code [--diff-add-bg:rgba(46,160,67,0.16)] [--diff-del-bg:rgba(248,81,73,0.16)]"
          />
        ))}
      </div>
    );
  }

  const hunks = diff.kind === 'edits' ? diff.edits : [{ oldText: diff.oldFile, newText: diff.newFile }];

  return (
    <>
      {hunks.map((hunk, index) => (
        <DiffViewer
          key={index}
          oldFile={hunk.oldText}
          newFile={hunk.newText}
          oldFileName={diff.filePath}
          newFileName={diff.filePath}
          viewMode="unified"
          showIcon={false}
          showHunkHeaders={false}
          showNoNewlineMarker={false}
          className="max-h-90 overflow-auto border-border/45 text-code [--diff-add-bg:rgba(46,160,67,0.16)] [--diff-del-bg:rgba(248,81,73,0.16)]"
        />
      ))}
    </>
  );
}

const CODE_CHANGE_TOOL_NAMES = new Set(['write', 'edit', 'apply_patch', 'applypatch']);

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
        'aui-diff-viewer overflow-auto rounded-lg border bg-background font-mono text-code text-foreground [--diff-add-bg:rgba(46,160,67,0.16)] [--diff-del-bg:rgba(248,81,73,0.16)]',
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
        <FileTypeIcon filePath={file.path} />
        <span className="flex-1 truncate">{normalizePath(file.path)}</span>
        <span className="rounded border bg-background px-1.5 py-0.5 text-ui-micro uppercase tracking-normal">{file.operation}</span>
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
  // `input` 是 Codex freeform apply_patch 的补丁正文所在键。
  for (const key of ['command', 'cmd', 'script', 'input']) {
    const value = input[key];
    if (typeof value === 'string' && value.includes('*** Begin Patch')) {
      return value;
    }
  }

  return undefined;
}
