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
  hunks?: Array<{ oldString: string; newString: string }>;
};

type PendingApplyPatch = {
  toolUseId: string;
  patchText?: string;
  changes?: Array<{ kind: string; path: string; diff?: string }>;
};

/** Round-start baseline plus the content produced by the round's mutations so far. */
type FileRoundState = {
  /** Content at the start of the round; the card's `before`. */
  baseline: string;
  /** Content after the mutations applied so far; the card's `after`. */
  current: string;
};

import { countDiffLines } from './diffStats.js';

/**
 * Canonical write-operation kinds. Everything else about a tool call is
 * irrelevant to artifact summarization.
 */
export type MutationKind = 'write' | 'edit' | 'apply_patch';

/**
 * Tool-name aliases, keyed by the canonical form produced by
 * {@link canonicalizeToolName}.
 *
 * This table MUST stay identical to `toolNames.canonical` in the shared fixture
 * (`test-data/turn-artifact-summary/cases.json`), which the Daemon side reads as
 * well — `artifactFixture.test.ts` asserts the two agree. Keeping one table
 * instead of one per language is what stops "the same tool counts on one card
 * but not the other".
 */
const TOOL_NAME_ALIASES: Record<string, MutationKind> = {
  write: 'write',
  write_file: 'write',
  writefile: 'write',
  write_to_file: 'write',
  create_file: 'write',
  save_file: 'write',

  edit: 'edit',
  edit_file: 'edit',
  editfile: 'edit',
  update_file: 'edit',
  replace_in_file: 'edit',
  str_replace: 'edit',
  multiedit: 'edit',
  multi_edit: 'edit',
  batch_edit: 'edit',

  apply_patch: 'apply_patch',
  applypatch: 'apply_patch',
  patch: 'apply_patch',
  apply_diff: 'apply_patch',
};

/** Fallback for write-like names the alias table does not know yet. */
const MUTATION_TOOL_PATTERN = /^(write|edit|multi_?edit|apply[_\s-]?patch|applypatch|patch|create_?file)$/;

/**
 * Nested carriers seen in the wild: Codex puts a freeform patch under `input`,
 * some agents wrap arguments in `arguments`/`params`/`payload`. Path extraction
 * descends through these so one rule covers every Agent Kind.
 */
const NESTED_PAYLOAD_KEYS = ['input', 'arguments', 'params', 'payload'] as const;

const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'filename'] as const;

/** `notebook_path` is deliberately absent — notebook tooling is out of scope. */

const MAX_PATH_SEARCH_DEPTH = 6;

/**
 * Normalizes a raw tool name so spelling differences collapse: lowercased,
 * `-` and whitespace to `_`, parentheses dropped.
 *
 * Deliberately prefix-agnostic: `mcp__fs__write_file` and `fs/write_file` both
 * canonicalize to `write_file`. An earlier version returned `mcp__`-prefixed
 * names untouched, which meant MCP write tools never counted.
 */
export function canonicalizeToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/[\s-]+/g, '_');
}

/**
 * Resolves a raw tool name to a canonical write kind, or null when the tool is
 * not a file mutation.
 *
 * Case-insensitive by construction, which is a correctness requirement rather
 * than a nicety: the native-session sync path passes provider tool names through
 * verbatim (uppercase for one Agent Kind, lowercase for another), so a
 * case-sensitive check would silently disable artifact cards for every synced
 * session.
 */
export function resolveMutationKind(toolName: string): MutationKind | null {
  const canonical = canonicalizeToolName(toolName);
  const direct = TOOL_NAME_ALIASES[canonical] ?? (MUTATION_TOOL_PATTERN.test(canonical) ? 'edit' : null);
  if (direct) return direct;

  // Host-prefixed forms: `mcp__<server>__write_file`, `<server>/write_file`,
  // `<server>.write_file`. The prefix spelling varies by Agent Kind, so try
  // every suffix starting after a separator run (`__`, `/`, `.`, `:`) and keep
  // the longest match — otherwise a third-party MCP write tool can never be
  // recognized. Note the suffix uses `_` between segments, so `mcp__fs__write_file`
  // is retried as `fs_write_file`, `write_file`.
  const separatorRuns = [...canonical.matchAll(/[^a-z0-9]+/g)];
  for (const match of separatorRuns) {
    const suffix = canonical.slice((match.index ?? 0) + match[0].length);
    if (!suffix) continue;
    const alias = TOOL_NAME_ALIASES[suffix];
    if (alias) return alias;
    if (MUTATION_TOOL_PATTERN.test(suffix)) return 'edit';
  }
  return null;
}

export function isMutationTool(toolName: string): boolean {
  return resolveMutationKind(toolName) !== null;
}

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

/** Normalize line endings so Edit oldString/newString (LF) match CRLF file snapshots. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Reads a string field, preferring the top level and then descending through the
 * known envelope keys. Needed because the same logical argument is passed
 * directly by one source and wrapped (`input`/`arguments`/`params`/`payload`) by
 * another — reading only the top level silently dropped those mutations.
 */
function findStringFieldDeep(
  value: unknown,
  keys: readonly string[],
  depth = 0,
): string | undefined {
  if (depth > MAX_PATH_SEARCH_DEPTH) return undefined;
  const record = readRecord(value);
  if (!record) return undefined;

  for (const key of keys) {
    const direct = readString(record[key]);
    if (direct !== undefined) return direct;
  }
  for (const nestedKey of NESTED_PAYLOAD_KEYS) {
    const found = findStringFieldDeep(record[nestedKey], keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function collectPathCandidatesDeep(value: unknown, depth: number, found: string[]): void {
  if (depth > MAX_PATH_SEARCH_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPathCandidatesDeep(item, depth + 1, found);
    return;
  }
  const record = readRecord(value);
  if (!record) return;

  for (const key of PATH_KEYS) {
    const direct = readString(record[key]);
    if (direct && direct.trim()) found.push(direct.trim());
  }
  // `changes` is keyed by path with the per-file payload as value — the only
  // place some agents put the path when one call touches several files.
  const changes = readRecord(record.changes);
  if (changes) {
    for (const key of Object.keys(changes)) {
      if (key.trim()) found.push(key.trim());
    }
  }
  for (const nestedKey of NESTED_PAYLOAD_KEYS) {
    collectPathCandidatesDeep(record[nestedKey], depth + 1, found);
  }
}

/**
 * Extracts the file paths a tool call touched.
 *
 * Searches recursively rather than looking at the top level only: the same
 * logical operation carries its path in different places depending on the
 * source — Codex nests a freeform patch under `input`, and a multi-file
 * `changes` payload keeps paths as object keys. One recursive rule replaces a
 * per-Agent-Kind patch.
 */
function extractPathCandidates(input: Record<string, unknown>): string[] {
  const found: string[] = [];
  collectPathCandidatesDeep(input, 0, found);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of found) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    unique.push(candidate);
  }
  return unique;
}

/**
 * Normalizes an edit tool's hunks. Handles pi's `{ edits: [{ oldText, newText }] }`
 * shape alongside the flat `old_string`/`new_string` (Claude/OpenCode) shape, and
 * looks through the same envelope keys as path extraction so a wrapped payload is
 * recognized too.
 */
function extractEditHunks(
  input: Record<string, unknown>,
): Array<{ oldString: string; newString: string }> | undefined {
  const parsed = parseEditHunks(input);
  if (parsed) return parsed;
  for (const nestedKey of NESTED_PAYLOAD_KEYS) {
    const nested = readRecord(input[nestedKey]);
    if (!nested) continue;
    const found = extractEditHunks(nested);
    if (found) return found;
  }
  return undefined;
}

function parseEditHunks(
  input: Record<string, unknown>,
): Array<{ oldString: string; newString: string }> | undefined {
  const edits = input.edits;
  if (Array.isArray(edits)) {
    const hunks: Array<{ oldString: string; newString: string }> = [];
    for (const entry of edits) {
      const record = readRecord(entry);
      if (!record) continue;
      const oldString = readString(record.oldText) ?? readString(record.old_string) ?? readString(record.oldString);
      const newString = readString(record.newText) ?? readString(record.new_string) ?? readString(record.newString);
      if (oldString === undefined || newString === undefined) continue;
      hunks.push({ oldString, newString });
    }
    return hunks.length ? hunks : undefined;
  }

  const oldString = readString(input.old_string) ?? readString(input.oldString);
  const newString = readString(input.new_string) ?? readString(input.newString);
  if (oldString === undefined || newString === undefined) return undefined;
  return [{ oldString, newString }];
}

/**
 * Finds a freeform patch body anywhere in a tool's input.
 *
 * The patch text is carried under different keys depending on the source: Codex
 * nests it under `input`, OpenCode names the key `patchText`, and some paths
 * pass it as the whole (non-object) argument. Matched on the body marker rather
 * than on a key list, so a new key name does not silently drop the patch.
 */
function extractApplyPatchText(input: Record<string, unknown>): string | undefined {
  return findPatchTextDeep(input, 0);
}

function findPatchTextDeep(value: unknown, depth: number): string | undefined {
  if (depth > MAX_PATH_SEARCH_DEPTH) return undefined;
  const direct = readString(value);
  if (direct !== undefined) {
    return direct.includes('*** Begin Patch') ? direct : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPatchTextDeep(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = readRecord(value);
  if (!record) return undefined;
  for (const nested of Object.values(record)) {
    const found = findPatchTextDeep(nested, depth + 1);
    if (found) return found;
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

/**
 * Builds a patch-derived entry, omitting `before`/`after` when empty.
 *
 * An added file has no before-content and a deleted file has no after-content,
 * so emitting `""` for them would be noise the renderer has to special-case.
 * The Daemon side follows the same rule; a shared-fixture case pins it.
 */
function diffEntryFromPatchParts(
  file: string,
  before: string,
  after: string,
  patch?: string,
): SessionSummaryDiff {
  const stats = countDiffLines(before, after);
  return {
    file,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(patch ? { patch } : {}),
    additions: stats.additions,
    deletions: stats.deletions,
  };
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
      entries.push(diffEntryFromPatchParts(file, '', after));
      continue;
    }
    if (filePatch.operation === 'delete') {
      const before = filePatch.lines
        .filter((line) => line.startsWith('-') && !line.startsWith('---'))
        .map((line) => line.slice(1))
        .join('\n');
      entries.push(diffEntryFromPatchParts(file, before, ''));
      continue;
    }

    const patch = filePatch.lines.join('\n');
    const parsed = parseUnifiedDiffPatch(patch);
    if (parsed) {
      entries.push(diffEntryFromPatchParts(file, parsed.oldContent, parsed.newContent, patch));
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
    entries.push(diffEntryFromPatchParts(file, beforeLines.join('\n'), afterLines.join('\n')));
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
    return diffEntryFromPatchParts(file, '', diff);
  }
  if (kind === 'delete') {
    // 删除后没有 after 内容：空侧省略而非发 ""（与自由文本补丁路径、
    // Daemon 侧同一约定，共享 fixture 有用例钉住）。
    return diffEntryFromPatchParts(file, diff, '');
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

/**
 * Binds a file snapshot to a tool call.
 *
 * Exact-match only. The previous version fell back to suffix matching, so a
 * snapshot for `src/app.ts` could be bound to a mutation of
 * `src/other/app.ts` and report the wrong before-content. When no snapshot
 * matches, the caller falls back to the tool-call id and finally to the degraded
 * baseline (before-text reconstructed from the edit hunks) — which is the normal
 * path for ingested native sessions, not an error case.
 */
function findSnapshot(
  snapshots: Map<string, FileSnapshot>,
  snapshotsByToolId: Map<string, FileSnapshot>,
  cwd: string,
  filePath: string,
  toolUseId?: string,
): FileSnapshot | undefined {
  const candidates = [
    resolveArtifactPath(cwd, filePath).toLowerCase(),
    resolveArtifactPath('', filePath).toLowerCase(),
  ];
  for (const candidate of candidates) {
    const direct = snapshots.get(candidate);
    if (direct) return direct;
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
  /**
   * Round-start baseline and current content per file.
   *
   * Needed because one round can mutate the same file several times, and an
   * `edit` only carries a hunk (`old_string`/`new_string`), not the content it
   * applies to. Without this state each hunk would be applied to the round-start
   * snapshot, so the *second* edit of a file would not match and would silently
   * leave the card reporting the first edit's intermediate result.
   */
  private readonly fileStates = new Map<string, FileRoundState>();
  /** True once a mutation landed since the last flushSummary; avoids duplicate emissions. */
  private dirty = false;
  /**
   * Latest known input per tool call id. Some runtimes send arguments after the
   * first frame, and payload fields (`content`, edit hunks) are read at commit
   * time so that the newest frame wins.
   */
  private readonly toolInputs = new Map<string, Record<string, unknown>>();

  constructor(private readonly cwd: string) {}

  observe(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'file_snapshot':
        this.observeFileSnapshot(event);
        break;
      case 'tool_started':
        this.observeToolFrame(event);
        break;
      case 'tool_finished':
        this.observeToolFinished(event);
        break;
      default:
        break;
    }
  }

  /**
   * Ingests a tool-call frame and (re)prepares the pending mutation for it.
   * Called on every frame so that late-arriving arguments still produce an
   * artifact entry.
   */
  private observeToolFrame(event: Record<string, unknown>): void {
    const toolUseId = readString(event.tool_use_id);
    const name = readString(event.name);
    if (!toolUseId || !name) return;
    const input = readRecord(event.input) ?? {};
    this.toolInputs.set(toolUseId, input);
    this.preparePendingMutation(toolUseId, name, input);
  }

  /** The newest input seen for a tool call, used when committing its mutation. */
  private latchedInput(toolUseId: string): Record<string, unknown> {
    return this.toolInputs.get(toolUseId) ?? {};
  }

  recordApplyPatchCompletion(
    toolUseId: string,
    changes: Array<{ kind: string; path: string; diff?: string }>,
  ): void {
    for (const change of changes) {
      const entry = diffEntryFromChange(this.cwd, change);
      const finalized = entry ? finalizeDiffEntry(entry) : null;
      if (finalized) {
        this.files.set(finalized.file, finalized);
        this.dirty = true;
        // A patch carries its own before/after text, so the entry keeps the
        // patch-derived shape (the card renders `patch`). The round state is
        // recorded as well so that a later edit or write of the same file in
        // this round still measures against the round-start content.
        this.fileStates.set(finalized.file, {
          baseline: finalized.before ?? '',
          current: finalized.after ?? '',
        });
      }
    }
    this.pendingApplyPatch.delete(toolUseId);
  }

  buildDiffs(): SessionSummaryDiff[] {
    return [...this.files.values()];
  }

  /**
   * Emits the round's cumulative summary, or null when nothing has changed
   * since the last emission.
   *
   * Deliberately does NOT reset state: one round (a single User Message) can
   * contain several internal turn completions, and each emission must cover the
   * round-start baseline so the coalesced card reflects the round's net change.
   * The baseline is reset by the next round's send.
   */
  flushSummary(sessionId: string): Record<string, unknown> | null {
    if (!this.dirty) return null;
    const diffs = this.buildDiffs();
    if (diffs.length === 0) return null;
    this.dirty = false;
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
    this.toolInputs.clear();
    this.fileStates.clear();
    this.dirty = false;
  }

  private observeFileSnapshot(event: Record<string, unknown>): void {
    const filePath = readString(event.file_path);
    if (!filePath) return;
    const snapshot: FileSnapshot = {
      content: readString(event.original_content) ?? '',
      isNew: event.is_new === true,
      toolUseId: readString(event.tool_use_id),
    };
    // First snapshot wins: it is the turn's baseline, and later frames for the
    // same file would otherwise move the baseline to a mid-turn state.
    const normalized = resolveArtifactPath(this.cwd, filePath).toLowerCase();
    if (!this.snapshots.has(normalized)) {
      this.snapshots.set(normalized, snapshot);
    }
    if (snapshot.toolUseId) {
      this.snapshotsByToolId.set(snapshot.toolUseId, snapshot);
    }
  }

  /**
   * Parses a tool call into pending mutation state. Runs on every frame for the
   * call, so arguments that arrive after the first frame are still honoured.
   */
  private preparePendingMutation(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    const kind = resolveMutationKind(toolName);
    if (!kind) return;

    if (kind === 'apply_patch') {
      const patchText = extractApplyPatchText(input);
      const changes = Array.isArray(input.changes)
        ? input.changes.filter((item): item is { kind: string; path: string; diff?: string } => (
          Boolean(item)
          && typeof item === 'object'
          && typeof (item as { path?: unknown }).path === 'string'
        ))
        : undefined;
      if (patchText || changes?.length) {
        this.pendingApplyPatch.set(toolUseId, { toolUseId, patchText, changes });
      }
      return;
    }

    const paths = extractPathCandidates(input);
    if (paths.length === 0) return;

    // Only the operation kind, the paths, and (for edits) the hunks are latched
    // here. Content is read at commit time so that arguments arriving in a later
    // frame are honoured, and so a `content` nested under an envelope is found by
    // the same recursive search that finds the path.
    if (kind === 'write') {
      this.pendingWriteEdit.set(toolUseId, { kind: 'write', toolUseId, filePath: paths[0] });
      return;
    }

    if (kind === 'edit') {
      const hunks = extractEditHunks(input);
      if (!hunks) return;
      // One edit call can touch several files (a multi-file payload keeps paths as
      // `changes` keys); each gets the same hunks, filtered downstream by whether
      // the hunk text is actually found in that file's baseline.
      for (const filePath of paths) {
        this.pendingWriteEdit.set(`${toolUseId}::${filePath}`, { kind: 'edit', toolUseId, filePath, hunks });
      }
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
          if (finalized) {
            this.files.set(finalized.file, finalized);
            this.dirty = true;
          }
        }
        this.pendingApplyPatch.delete(toolUseId);
      }
      return;
    }

    const pendingKey = this.findPendingWriteEditKey(toolUseId);
    if (!pendingKey) return;
    const pending = this.pendingWriteEdit.get(pendingKey);
    if (!pending) return;

    for (const key of [...this.pendingWriteEdit.keys()]) {
      if (key === toolUseId || key.startsWith(`${toolUseId}::`)) {
        this.pendingWriteEdit.delete(key);
      }
    }
    this.commitWriteEdit(toolUseId, pending);
  }

  /** Pending write/edit state is keyed per tool call, and per file for multi-file edits. */
  private findPendingWriteEditKey(toolUseId: string): string | undefined {
    if (this.pendingWriteEdit.has(toolUseId)) return toolUseId;
    for (const key of this.pendingWriteEdit.keys()) {
      if (key.startsWith(`${toolUseId}::`)) return key;
    }
    return undefined;
  }

  /** Applies every hunk that matches, reporting whether any of them did. */
  private static applyHunks(
    content: string,
    hunks: Array<{ oldString: string; newString: string }>,
  ): { applied: boolean; result: string } {
    let result = content;
    let applied = false;
    for (const hunk of hunks) {
      const normalizedOld = normalizeLineEndings(hunk.oldString);
      const normalizedNew = normalizeLineEndings(hunk.newString);
      const index = result.indexOf(normalizedOld);
      if (index !== -1) {
        result = `${result.slice(0, index)}${normalizedNew}${result.slice(index + normalizedOld.length)}`;
        applied = true;
      }
    }
    return { applied, result };
  }

  /**
   * Records a mutation of one file as `baseline → current`, so the card always
   * shows the round's net change and never a mid-round state.
   *
   * A file that ends the round back at its baseline is dropped from the card
   * (net-zero filtering), including when an earlier mutation had already put it
   * there — that is the "a round with no successful change produces no card"
   * rule, and it has to be enforced here rather than only when the entry is
   * first created.
   */
  private recordMutation(file: string, baseline: string, current: string): void {
    this.fileStates.set(file, { baseline, current });
    const entry = finalizeDiffEntry({ file, before: baseline, after: current });
    if (!entry) {
      this.files.delete(file);
      return;
    }
    this.files.set(file, entry);
    this.dirty = true;
  }

  private commitWriteEdit(toolUseId: string, pending: PendingWriteEdit): void {
    const resolvedPath = resolveArtifactPath(this.cwd, pending.filePath);
    const snapshot = findSnapshot(
      this.snapshots,
      this.snapshotsByToolId,
      this.cwd,
      pending.filePath,
      toolUseId,
    );
    const state = this.fileStates.get(resolvedPath);

    if (pending.kind === 'write') {
      const content = findStringFieldDeep(this.latchedInput(toolUseId), ['content', 'file_text', 'text']);
      if (content === undefined) return;
      // A write replaces the file outright, so the baseline is the round-start
      // content and the result is this call's payload.
      const baseline = state?.baseline ?? snapshot?.content ?? '';
      this.recordMutation(resolvedPath, baseline, content);
      return;
    }

    const snapshotContent = snapshot?.content ?? '';
    const hunks = pending.hunks ?? [];
    let baseline = snapshotContent;
    let current = snapshotContent;
    let applied = false;

    if (state) {
      // Second or later edit of this file in this round: the hunks describe a
      // change against the content the round has produced so far, not against
      // the round-start snapshot.
      const result = TurnArtifactAggregator.applyHunks(normalizeLineEndings(state.current), hunks);
      if (result.applied) {
        baseline = state.baseline;
        current = result.result;
        applied = true;
      }
    } else if (snapshotContent) {
      const result = TurnArtifactAggregator.applyHunks(normalizeLineEndings(snapshotContent), hunks);
      if (result.applied) {
        baseline = normalizeLineEndings(snapshotContent);
        current = result.result;
        applied = true;
      }
    } else if (hunks.length) {
      // Degraded baseline: no snapshot (native-session sync never has one, and
      // pi never emits one), so reconstruct before/after from the hunks alone.
      baseline = hunks.map((hunk) => normalizeLineEndings(hunk.oldString)).join('\n');
      current = hunks.map((hunk) => normalizeLineEndings(hunk.newString)).join('\n');
      applied = true;
    }
    if (!applied) return;

    this.recordMutation(resolvedPath, baseline, current);
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
