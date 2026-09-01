export type SessionSummaryDiff = {
  file: string;
  patch?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
};

type FileSnapshot = {
  content: string;
  isNew: boolean;
  toolUseId?: string;
};

type PendingWriteEdit = {
  kind: 'write' | 'edit';
  toolUseId: string;
  filePath: string;
  content?: string;
  oldString?: string;
  newString?: string;
};

type PendingApplyPatch = {
  toolUseId: string;
  patchText?: string;
  changes?: Array<{ kind: string; path: string; diff?: string }>;
};

import { countDiffLines } from './diffStats.js';
import path from 'node:path';

const MUTATION_TOOLS = new Set(['write', 'edit', 'apply_patch']);

export function parseUnifiedDiffPatch(patch: string): { oldContent: string; newContent: string } | null {
  const lines = patch.split('\n');
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let inHunk = false;
  let hasContent = false;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (
      line.startsWith('---')
      || line.startsWith('diff ')
      || line.startsWith('index ')
      || line.startsWith('new file')
      || line.startsWith('deleted file')
      || line.startsWith('old mode')
      || line.startsWith('new mode')
      || line.startsWith('similarity ')
      || line.startsWith('rename ')
      || line.startsWith('copy ')
    ) {
      continue;
    }
    if (line.startsWith('+++')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue;

    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
      hasContent = true;
    } else if (line.startsWith('+')) {
      newLines.push(line.slice(1));
      hasContent = true;
    } else if (line.startsWith(' ')) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
      hasContent = true;
    } else if (line === '') {
      oldLines.push('');
      newLines.push('');
      hasContent = true;
    }
  }

  if (!hasContent) return null;
  return { oldContent: oldLines.join('\n'), newContent: newLines.join('\n') };
}

function finalizeDiffEntry(entry: SessionSummaryDiff): SessionSummaryDiff | null {
  let statsBefore = entry.before ?? '';
  let statsAfter = entry.after ?? '';
  if (entry.patch) {
    const parsed = parseUnifiedDiffPatch(entry.patch);
    if (parsed) {
      statsBefore = parsed.oldContent;
      statsAfter = parsed.newContent;
    }
  }
  const stats = countDiffLines(statsBefore, statsAfter);
  if (stats.additions === 0 && stats.deletions === 0) {
    return null;
  }
  return {
    ...entry,
    additions: stats.additions,
    deletions: stats.deletions,
  };
}

function normalizeToolName(toolName: string): string {
  if (toolName.startsWith('mcp__')) return toolName;
  return toolName.toLowerCase();
}

/** Normalize line endings so Edit oldString/newString (LF) match CRLF file snapshots. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function isMutationTool(toolName: string): boolean {
  return MUTATION_TOOLS.has(normalizeToolName(toolName));
}

export function resolveArtifactPath(cwd: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed.replace(/\\/g, '/');
  }
  const base = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  return `${base}/${trimmed.replace(/\\/g, '/')}`;
}

export function isArtifactPathInWorkspace(cwd: string, filePath: string): boolean {
  if (!cwd.trim() || !filePath.trim()) return false;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedCwd, filePath);
  const relative = path.relative(resolvedCwd, resolvedFile);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readFilePath(input: Record<string, unknown>): string | undefined {
  return readString(input.file_path) ?? readString(input.filePath);
}

function extractApplyPatchText(input: Record<string, unknown>): string | undefined {
  const direct = readString(input.input);
  if (direct?.includes('*** Begin Patch')) return direct;
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.includes('*** Begin Patch')) {
      return value;
    }
  }
  return undefined;
}

function parsePatchFileOperation(line: string): { operation: 'add' | 'update' | 'delete'; path: string } | null {
  const addMatch = line.match(/^\*\*\* Add File: (.+)$/);
  if (addMatch) return { operation: 'add', path: addMatch[1] };

  const updateMatch = line.match(/^\*\*\* Update File: (.+)$/);
  if (updateMatch) return { operation: 'update', path: updateMatch[1] };

  const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/);
  if (deleteMatch) return { operation: 'delete', path: deleteMatch[1] };

  return null;
}

function shouldHidePatchLine(line: string): boolean {
  return (
    line === '*** Begin Patch'
    || line === '*** End Patch'
    || line.startsWith('***')
    || line.startsWith('@@')
    || line.startsWith('\\ No newline at end of file')
  );
}

function diffEntryFromFreeformPatch(cwd: string, patchText: string): SessionSummaryDiff[] {
  const entries: SessionSummaryDiff[] = [];
  const files: Array<{ operation: 'add' | 'update' | 'delete'; path: string; lines: string[] }> = [];
  let active: { operation: 'add' | 'update' | 'delete'; path: string; lines: string[] } | undefined;

  for (const line of patchText.split(/\r?\n/)) {
    const operation = parsePatchFileOperation(line);
    if (operation) {
      active = { ...operation, lines: [] };
      files.push(active);
      continue;
    }
    if (!active || shouldHidePatchLine(line)) continue;
    active.lines.push(line);
  }

  for (const filePatch of files) {
    const file = resolveArtifactPath(cwd, filePatch.path);
    if (filePatch.operation === 'add') {
      const after = filePatch.lines
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .map((line) => line.slice(1))
        .join('\n');
      const stats = countDiffLines('', after);
      entries.push({ file, after, additions: stats.additions, deletions: stats.deletions });
      continue;
    }
    if (filePatch.operation === 'delete') {
      const before = filePatch.lines
        .filter((line) => line.startsWith('-') && !line.startsWith('---'))
        .map((line) => line.slice(1))
        .join('\n');
      const stats = countDiffLines(before, '');
      entries.push({ file, before, after: '', additions: stats.additions, deletions: stats.deletions });
      continue;
    }

    const patch = filePatch.lines.join('\n');
    const parsed = parseUnifiedDiffPatch(patch);
    if (parsed) {
      const stats = countDiffLines(parsed.oldContent, parsed.newContent);
      entries.push({
        file,
        patch,
        before: parsed.oldContent,
        after: parsed.newContent,
        additions: stats.additions,
        deletions: stats.deletions,
      });
      continue;
    }

    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    for (const line of filePatch.lines) {
      if (line.startsWith('-') && !line.startsWith('---')) {
        beforeLines.push(line.slice(1));
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        afterLines.push(line.slice(1));
      }
    }
    const before = beforeLines.join('\n');
    const after = afterLines.join('\n');
    const stats = countDiffLines(before, after);
    entries.push({ file, before, after, additions: stats.additions, deletions: stats.deletions });
  }

  return entries;
}

function diffEntryFromChange(
  cwd: string,
  change: { kind: string; path: string; diff?: string },
): SessionSummaryDiff | null {
  const file = resolveArtifactPath(cwd, change.path);
  const diff = change.diff ?? '';
  if (!diff.trim()) return null;

  const kind = change.kind.toLowerCase();
  if (kind === 'add') {
    const stats = countDiffLines('', diff);
    return { file, after: diff, additions: stats.additions, deletions: stats.deletions };
  }
  if (kind === 'delete') {
    const stats = countDiffLines(diff, '');
    return { file, before: diff, after: '', additions: stats.additions, deletions: stats.deletions };
  }

  const parsed = parseUnifiedDiffPatch(diff);
  if (parsed) {
    const stats = countDiffLines(parsed.oldContent, parsed.newContent);
    return {
      file,
      patch: diff,
      before: parsed.oldContent,
      after: parsed.newContent,
      additions: stats.additions,
      deletions: stats.deletions,
    };
  }

  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('-') && !line.startsWith('---')) {
      beforeLines.push(line.slice(1));
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      afterLines.push(line.slice(1));
    }
  }
  if (beforeLines.length > 0 || afterLines.length > 0) {
    const before = beforeLines.join('\n');
    const after = afterLines.join('\n');
    const stats = countDiffLines(before, after);
    return {
      file,
      patch: diff,
      before,
      after,
      additions: stats.additions,
      deletions: stats.deletions,
    };
  }

  const stats = countDiffLines('', diff);
  return { file, after: diff, additions: stats.additions, deletions: stats.deletions };
}

function findSnapshot(
  snapshots: Map<string, FileSnapshot>,
  snapshotsByToolId: Map<string, FileSnapshot>,
  filePath: string,
  toolUseId?: string,
): FileSnapshot | undefined {
  const normalized = resolveArtifactPath('', filePath).toLowerCase();
  for (const [key, snapshot] of snapshots.entries()) {
    if (key.toLowerCase() === normalized || key.toLowerCase().endsWith(normalized) || normalized.endsWith(key.toLowerCase())) {
      return snapshot;
    }
  }
  if (toolUseId) {
    return snapshotsByToolId.get(toolUseId);
  }
  return undefined;
}

export class TurnArtifactAggregator {
  private readonly files = new Map<string, SessionSummaryDiff>();
  private readonly snapshots = new Map<string, FileSnapshot>();
  private readonly snapshotsByToolId = new Map<string, FileSnapshot>();
  private readonly pendingWriteEdit = new Map<string, PendingWriteEdit>();
  private readonly pendingApplyPatch = new Map<string, PendingApplyPatch>();

  constructor(private readonly cwd: string) {}

  private trackDiffEntry(entry: SessionSummaryDiff | null): void {
    if (!entry || !isArtifactPathInWorkspace(this.cwd, entry.file)) return;
    this.files.set(entry.file, entry);
  }

  observe(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'file_snapshot':
        this.observeFileSnapshot(event);
        break;
      case 'tool_started':
        this.observeToolStarted(event);
        break;
      case 'tool_finished':
        this.observeToolFinished(event);
        break;
      default:
        break;
    }
  }

  recordApplyPatchCompletion(
    toolUseId: string,
    changes: Array<{ kind: string; path: string; diff?: string }>,
  ): void {
    for (const change of changes) {
      const entry = diffEntryFromChange(this.cwd, change);
      const finalized = entry ? finalizeDiffEntry(entry) : null;
      this.trackDiffEntry(finalized);
    }
    this.pendingApplyPatch.delete(toolUseId);
  }

  buildDiffs(): SessionSummaryDiff[] {
    return [...this.files.values()];
  }

  flushSummary(sessionId: string): Record<string, unknown> | null {
    const diffs = this.buildDiffs();
    if (diffs.length === 0) return null;
    return {
      type: 'system_event',
      subtype: 'session_summary',
      session_id: sessionId,
      diffs,
      event_id: crypto.randomUUID(),
    };
  }

  reset(): void {
    this.files.clear();
    this.snapshots.clear();
    this.snapshotsByToolId.clear();
    this.pendingWriteEdit.clear();
    this.pendingApplyPatch.clear();
  }

  private observeFileSnapshot(event: Record<string, unknown>): void {
    const filePath = readString(event.file_path);
    if (!filePath) return;
    const snapshot: FileSnapshot = {
      content: readString(event.original_content) ?? '',
      isNew: event.is_new === true,
      toolUseId: readString(event.tool_use_id),
    };
    const normalized = resolveArtifactPath(this.cwd, filePath);
    if (!isArtifactPathInWorkspace(this.cwd, normalized)) return;
    if (!this.snapshots.has(normalized)) {
      this.snapshots.set(normalized, snapshot);
    }
    if (snapshot.toolUseId) {
      this.snapshotsByToolId.set(snapshot.toolUseId, snapshot);
    }
  }

  private observeToolStarted(event: Record<string, unknown>): void {
    const toolUseId = readString(event.tool_use_id);
    const name = readString(event.name);
    const input = readRecord(event.input);
    if (!toolUseId || !name || !input || !isMutationTool(name)) return;

    const normalized = normalizeToolName(name);
    if (normalized === 'apply_patch') {
      const patchText = extractApplyPatchText(input);
      const changes = Array.isArray(input.changes)
        ? input.changes.filter((item): item is { kind: string; path: string; diff?: string } => (
          Boolean(item)
          && typeof item === 'object'
          && typeof (item as { path?: unknown }).path === 'string'
        ))
        : undefined;
      this.pendingApplyPatch.set(toolUseId, { toolUseId, patchText, changes });
      return;
    }

    const filePath = readFilePath(input);
    if (!filePath || !isArtifactPathInWorkspace(this.cwd, resolveArtifactPath(this.cwd, filePath))) return;

    if (normalized === 'write') {
      const content = readString(input.content);
      if (content === undefined) return;
      this.pendingWriteEdit.set(toolUseId, { kind: 'write', toolUseId, filePath, content });
      return;
    }

    if (normalized === 'edit') {
      const oldString = readString(input.old_string) ?? readString(input.oldString);
      const newString = readString(input.new_string) ?? readString(input.newString);
      if (oldString === undefined || newString === undefined) return;
      this.pendingWriteEdit.set(toolUseId, {
        kind: 'edit',
        toolUseId,
        filePath,
        oldString,
        newString,
      });
    }
  }

  private observeToolFinished(event: Record<string, unknown>): void {
    if (event.is_error === true) return;
    const toolUseId = readString(event.tool_use_id);
    if (!toolUseId) return;

    const pendingPatch = this.pendingApplyPatch.get(toolUseId);
    if (pendingPatch) {
      if (pendingPatch.changes?.length) {
        this.recordApplyPatchCompletion(toolUseId, pendingPatch.changes);
        return;
      }
      if (pendingPatch.patchText) {
        for (const entry of diffEntryFromFreeformPatch(this.cwd, pendingPatch.patchText)) {
          const finalized = finalizeDiffEntry(entry);
          this.trackDiffEntry(finalized);
        }
        this.pendingApplyPatch.delete(toolUseId);
      }
      return;
    }

    const pending = this.pendingWriteEdit.get(toolUseId);
    if (!pending) return;

    const resolvedPath = resolveArtifactPath(this.cwd, pending.filePath);
    const snapshot = findSnapshot(this.snapshots, this.snapshotsByToolId, pending.filePath, toolUseId);

    if (pending.kind === 'write') {
      const after = pending.content ?? '';
      const before = snapshot?.content ?? '';
      const entry = finalizeDiffEntry({ file: resolvedPath, before, after });
      this.trackDiffEntry(entry);
    } else {
      const snapshotContent = snapshot?.content ?? '';
      let before = snapshotContent;
      let after = snapshotContent;
      let applied = false;
      if (pending.oldString !== undefined && pending.newString !== undefined) {
        const normalizedSnapshot = normalizeLineEndings(snapshotContent);
        const normalizedOld = normalizeLineEndings(pending.oldString);
        const normalizedNew = normalizeLineEndings(pending.newString);
        const index = normalizedSnapshot.indexOf(normalizedOld);
        if (index !== -1) {
          after = `${normalizedSnapshot.slice(0, index)}${normalizedNew}${normalizedSnapshot.slice(index + normalizedOld.length)}`;
          before = normalizedSnapshot;
          applied = true;
        } else if (!snapshotContent) {
          before = normalizedOld;
          after = normalizedNew;
          applied = true;
        }
      }
      if (!applied) {
        this.pendingWriteEdit.delete(toolUseId);
        return;
      }
      const entry = finalizeDiffEntry({ file: resolvedPath, before, after });
      this.trackDiffEntry(entry);
    }

    this.pendingWriteEdit.delete(toolUseId);
  }
}

export function synthesizeTurnArtifactSummaries(
  events: Array<Record<string, unknown>>,
  cwd: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  let turnEvents: Array<Record<string, unknown>> = [];
  let turnHasSummary = false;

  const flushTurn = () => {
    if (turnEvents.length === 0) return;

    if (!turnHasSummary) {
      const aggregator = new TurnArtifactAggregator(cwd);
      for (const event of turnEvents) {
        aggregator.observe(event);
      }
      const sessionId = readString(
        turnEvents.find((event) => readString(event.session_id))?.session_id,
      ) ?? '';
      const summary = aggregator.flushSummary(sessionId);
      if (summary) {
        const turnFinishedIndex = turnEvents.findIndex((event) => event.type === 'turn_finished');
        if (turnFinishedIndex >= 0) {
          result.push(...turnEvents.slice(0, turnFinishedIndex), summary, ...turnEvents.slice(turnFinishedIndex));
        } else {
          result.push(...turnEvents, summary);
        }
        turnEvents = [];
        turnHasSummary = false;
        return;
      }
    }

    result.push(...turnEvents);
    turnEvents = [];
    turnHasSummary = false;
  };

  for (const event of events) {
    if (event.type === 'user_message' && turnEvents.length > 0) {
      flushTurn();
    }
    turnEvents.push(event);
    if (event.type === 'system_event' && event.subtype === 'session_summary') {
      turnHasSummary = true;
    }
    if (event.type === 'turn_finished') {
      flushTurn();
    }
  }
  flushTurn();
  return result;
}
