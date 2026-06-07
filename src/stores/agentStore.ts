import { create } from 'zustand';
import { diffLines } from 'diff';
import { agentApi, fileApi } from '../lib/tauri';
import { useSessionStore } from './sessionStore';
import { useMcpStore } from './mcpStore';
import { normalizeFilePath, usePreviewStore } from './previewStore';
import type {
  AgentAssistantMessage,
  AgentToolResult,
  AgentSystemMessage,
  AgentResultMessage,
  SidecarReadyEvent,
  SidecarErrorEvent,
  TodoItem,
  ChangedFile,
} from '../types/agent';

export type AgentMessage =
  | { kind: 'user'; data: { content: string } }
  | { kind: 'assistant'; data: AgentAssistantMessage }
  | { kind: 'tool_result'; data: AgentToolResult }
  | { kind: 'system'; data: AgentSystemMessage }
  | { kind: 'result'; data: AgentResultMessage }
  | { kind: 'ready'; data: SidecarReadyEvent }
  | { kind: 'error'; data: SidecarErrorEvent }
  | { kind: 'api_retry'; data: { attempt: number; max_retries: number; retry_delay_ms: number; error_status: number; error: string } }
  | { kind: 'ask_user_question'; data: { tool_use_id: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }> } }
  | { kind: 'compact'; data: { compact_metadata: { trigger: 'manual' | 'auto'; pre_tokens: number }; subtype: string; type: string } }
  | { kind: 'mcp_status'; data: Record<string, string> }
  | { kind: 'streaming'; data: { event: Record<string, unknown>; session_id?: string } }
  | { kind: 'file_snapshot'; data: { file_path: string; original_content: string; is_new: boolean; tool_use_id: string } }
  | { kind: 'done' }
  | { kind: 'raw'; data: Record<string, unknown> };

interface AgentState {
  /** Events for each session */
  events: Record<string, AgentMessage[]>;
  /** Timestamps (ms) for each event, recorded at arrival time */
  eventTimestamps: Record<string, number[]>;
  /** Whether a query is currently running */
  isRunning: Record<string, boolean>;
  /** Error message if any */
  error: Record<string, string | null>;
  /** Current todos per session (extracted from TodoWrite / Task tools) */
  todos: Record<string, TodoItem[]>;
  /** Accumulated streaming thinking text per session (from stream_event deltas) */
  streamingThinking: Record<string, string>;
  /** Accumulated streaming text per session (from stream_event text deltas) */
  streamingText: Record<string, string>;
  /** Sessions that were force-stopped (interrupt) — suppress streaming UI immediately */
  forceStopped: Record<string, boolean>;
  streamingToolInputs: Record<string, Record<string, string>>;
  streamingToolMeta: Record<string, Record<string, { name: string; index: number }>>;
  streamingToolIndexMap: Record<string, Record<number, string>>;
  streamedToolUseIds: Record<string, Set<string>>;
  changedFiles: Record<string, ChangedFile[]>;
  fileOriginals: Record<string, Record<string, { content: string; isNew: boolean; toolUseId?: string }>>;
  acknowledgedFiles: Record<string, Set<string>>;

  /** Start a new agent query */
  startQuery: (sessionId: string, prompt: string, cwd: string, apiKey?: string, baseUrl?: string, model?: string) => Promise<void>;
  /** Interrupt the current query for a specific session */
  interrupt: (sessionId: string) => Promise<void>;
  /** Clear events for a session */
  clearEvents: (sessionId: string) => void;
  /** Clear saved events from database */
  clearSavedEvents: (sessionId: string) => Promise<void>;
  /** Load historical messages for a session */
  loadSessionMessages: (sessionId: string) => Promise<void>;
  /** Clear changed files for a session */
  clearChangedFiles: (sessionId: string) => void;
}

function parseAgentEvent(raw: string): AgentMessage {
  try {
    const data = JSON.parse(raw);
    switch (data.type) {
      case 'sidecar_ready':
        return { kind: 'ready', data };
      case 'sidecar_error':
        return { kind: 'error', data };
      case 'sidecar_query_done':
        return { kind: 'done' };
      case 'mcp_status_update':
        return { kind: 'mcp_status', data: (data as any).servers || {} };
      case 'assistant':
        return { kind: 'assistant', data };
      case 'user':
        return { kind: 'tool_result', data };
      case 'system':
        if (data.subtype === 'init') {
          return { kind: 'system', data };
        }
        if (data.subtype === 'api_retry') {
          return { kind: 'api_retry', data };
        }
        if (data.subtype === 'compact_boundary') {
          return { kind: 'compact', data };
        }
        return { kind: 'raw', data };
      case 'result':
        return { kind: 'result', data };
      case 'ask_user_question':
        return { kind: 'ask_user_question', data };
      case 'file_snapshot':
        return { kind: 'file_snapshot', data };
      case 'stream_event':
        return { kind: 'streaming', data: { event: data.event, session_id: data.session_id } };
      case 'sidecar_debug':
        return { kind: 'raw', data };
      default:
        return { kind: 'raw', data };
    }
  } catch {
    return { kind: 'raw', data: { type: 'parse_error', raw } };
  }
}

function truncateTitle(text: string, maxLen = 30): string {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen) + '...';
}

/**
 * Extract the current todo list from a stream of agent events.
 * Handles TodoWrite (full list replacement), TaskCreate/TaskUpdate (incremental),
 * and infers status from tool execution flow when TodoWrite doesn't update statuses.
 */
function extractTodosFromEvents(events: AgentMessage[]): TodoItem[] {
  let todos: TodoItem[] = [];
  const taskMap = new Map<string, TodoItem>();
  let hasExplicitUpdates = false; // true if any TodoWrite with non-pending status was seen
  // Track which task index each tool call is associated with (tool_use_id → task index)
  const toolToTask = new Map<string, number>();
  // Auto-incrementing task ID counter (1, 2, 3...) matching SDK convention
  let nextTaskId = 1;

  for (const evt of events) {
    if (evt.kind === 'assistant') {
      const blocks = Array.isArray(evt.data?.message?.content) ? evt.data.message.content : [];

      for (const block of blocks) {
        if (block?.type !== 'tool_use' || !block.name) continue;

        // TodoWrite: replaces the entire todo list
        if (block.name === 'TodoWrite') {
          const inputTodos = (block.input as any)?.todos;
          if (Array.isArray(inputTodos)) {
            const newTodos = inputTodos.map((t: any) => ({
              content: String(t.content || ''),
              status: (['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending') as TodoItem['status'],
              activeForm: t.activeForm || undefined,
            }));
            // Check if this TodoWrite has any non-pending status
            if (newTodos.some((t) => t.status !== 'pending')) {
              hasExplicitUpdates = true;
            }
            todos = newTodos;
            // Rebuild taskMap with sequential IDs so subsequent TaskUpdate can find them
            taskMap.clear();
            newTodos.forEach((t, i) => {
              taskMap.set(String(i + 1), t);
            });
          }
          continue; // skip inference for TodoWrite
        }

        // TaskCreate: adds a single task
        if (block.name === 'TaskCreate') {
          const input = block.input as any;
          // Use SDK-provided id if available, otherwise auto-increment (1, 2, 3...)
          const taskId = String(input?.id || input?.task_id || nextTaskId++);
          const item: TodoItem = {
            content: String(input?.subject || input?.description || ''),
            status: 'pending',
            activeForm: input?.activeForm || undefined,
          };
          taskMap.set(taskId, item);
          todos.push(item);
          continue; // skip inference for TaskCreate
        }

        // TaskUpdate: updates an existing task by taskId
        if (block.name === 'TaskUpdate') {
          const input = block.input as any;
          const taskId = input?.taskId;
          if (taskId && taskMap.has(taskId)) {
            const item = taskMap.get(taskId)!;
            if (input.status) {
              hasExplicitUpdates = true;
              item.status = (['pending', 'in_progress', 'completed', 'deleted'].includes(input.status)
                ? input.status === 'deleted' ? 'completed' : input.status
                : 'pending') as TodoItem['status'];
            }
            if (input.subject) item.content = String(input.subject);
            if (input.activeForm) item.activeForm = String(input.activeForm);
          }
          continue; // skip inference for TaskUpdate
        }

        // Infer progress from tool calls: mark first pending task as in_progress
        // and record which task this tool call is associated with.
        // Skip task-management and read-only query tools — they don't represent work.
        const skipInferenceTools = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];
        if (!hasExplicitUpdates && todos.length > 0 && !skipInferenceTools.includes(block.name)) {
          const firstPending = todos.find((t) => t.status === 'pending');
          if (firstPending) {
            firstPending.status = 'in_progress';
            if (block.id) {
              toolToTask.set(block.id, todos.indexOf(firstPending));
            }
          }
        }
      }
    }

    // Infer progress from tool results: only complete the task this tool was associated with
    if (!hasExplicitUpdates && evt.kind === 'tool_result' && todos.length > 0) {
      const data: any = evt.data;
      const rawContent = data?.message?.content;
      if (Array.isArray(rawContent)) {
        for (const r of rawContent) {
          if (r?.type === 'tool_result' && r.tool_use_id && toolToTask.has(r.tool_use_id)) {
            const taskIdx = toolToTask.get(r.tool_use_id)!;
            if (todos[taskIdx] && todos[taskIdx].status !== 'completed') {
              todos[taskIdx].status = 'completed';
            }
            toolToTask.delete(r.tool_use_id);
          }
        }
      }
      // Fallback: also check tool_use_result and parent_tool_use_id
      if (data?.tool_use_result?.tool_use_id && toolToTask.has(data.tool_use_result.tool_use_id)) {
        const taskIdx = toolToTask.get(data.tool_use_result.tool_use_id)!;
        if (todos[taskIdx] && todos[taskIdx].status !== 'completed') {
          todos[taskIdx].status = 'completed';
        }
        toolToTask.delete(data.tool_use_result.tool_use_id);
      }
      if (data?.parent_tool_use_id && toolToTask.has(data.parent_tool_use_id)) {
        const taskIdx = toolToTask.get(data.parent_tool_use_id)!;
        if (todos[taskIdx] && todos[taskIdx].status !== 'completed') {
          todos[taskIdx].status = 'completed';
        }
        toolToTask.delete(data.parent_tool_use_id);
      }
    }
  }

  return todos;
}

function countDiff(oldStr: string, newStr: string): { additions: number; deletions: number } {
  const changes = diffLines(oldStr, newStr);
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    const lines = change.value.split('\n').filter((_l, i, arr) =>
      i < arr.length - 1 || arr[arr.length - 1] !== ''
    );
    if (change.added) additions += lines.length;
    if (change.removed) deletions += lines.length;
  }
  return { additions, deletions };
}

export function extractChangedFilesFromEvents(
  events: AgentMessage[],
  acknowledged?: Set<string>,
  originals?: Record<string, { content: string; isNew: boolean; toolUseId?: string }>,
): ChangedFile[] {
  const fileMap = new Map<string, ChangedFile>();

  // Build a normalized lookup for originals (snapshot paths may differ from tool input paths)
  const normalizedOriginals = new Map<string, { content: string; isNew: boolean; toolUseId?: string }>();
  // Also build a lookup by tool_use_id for matching when paths differ (relative vs absolute)
  const originalsByToolId = new Map<string, { content: string; isNew: boolean }>();
  // Also build a suffix lookup for relative-vs-absolute path matching
  const originalsBySuffix = new Map<string, { content: string; isNew: boolean; toolUseId?: string }>();
  if (originals) {
    for (const [k, v] of Object.entries(originals)) {
      const normalized = normalizeFilePath(k);
      normalizedOriginals.set(normalized, v);
      if (v.toolUseId) {
        originalsByToolId.set(v.toolUseId, v);
      }
      // Store lowercase suffix keys for relative path matching (strip drive letter)
      const lower = normalized.toLowerCase();
      originalsBySuffix.set(lower, v);
      const driveMatch = lower.match(/^[a-z]:\\(.+)$/);
      if (driveMatch) {
        originalsBySuffix.set(driveMatch[1], v);
      }
    }
  }

  // Helper: find snapshot by normalized path, tool ID, or suffix match
  const findSnapshot = (filePath: string, toolUseId?: string) => {
    const normalized = normalizeFilePath(filePath);
    const exact = normalizedOriginals.get(normalized);
    if (exact) return exact;
    if (toolUseId) {
      const byId = originalsByToolId.get(toolUseId);
      if (byId) return byId;
    }
    // Suffix match: tool input "src/foo.ts" matches snapshot "D:\project\src\foo.ts"
    const lower = normalized.toLowerCase();
    for (const [suffix, val] of originalsBySuffix) {
      if (suffix.endsWith(lower) || lower.endsWith(suffix)) return val;
    }
    return undefined;
  };

  for (const evt of events) {
    if (evt.kind !== 'assistant') continue;
    const blocks = Array.isArray(evt.data?.message?.content) ? evt.data.message.content : [];

    for (const block of blocks) {
      if (block?.type !== 'tool_use' || !block.name) continue;
      const input = block.input as Record<string, unknown>;

      if (block.name === 'Write') {
        const rawPath = input?.file_path as string;
        const fileContent = input?.content as string;
        if (!rawPath || typeof fileContent !== 'string') continue;
        const filePath = normalizeFilePath(rawPath);
        const toolUseId = block.id as string | undefined;

        const existing = fileMap.get(filePath);
        if (existing) {
          existing.currentContent = fileContent;
          existing._pendingEdits = undefined;
          const orig = existing.originalContent ?? '';
          const { additions, deletions } = countDiff(orig, fileContent);
          existing.additions = additions;
          existing.deletions = deletions;
        } else {
          const snapshot = findSnapshot(rawPath, toolUseId);
          const origContent = snapshot?.content ?? '';
          const isNew = snapshot?.isNew ?? true;
          const { additions, deletions } = countDiff(origContent, fileContent);
          fileMap.set(filePath, {
            path: filePath,
            isNew,
            originalContent: origContent,
            currentContent: fileContent,
            additions,
            deletions,
          });
        }
      }

      if (block.name === 'Edit') {
        const rawPath = input?.file_path as string;
        const oldString = input?.old_string as string;
        const newString = input?.new_string as string;
        if (!rawPath || typeof oldString !== 'string' || typeof newString !== 'string') continue;
        const filePath = normalizeFilePath(rawPath);
        const toolUseId = block.id as string | undefined;

        const existing = fileMap.get(filePath);
        if (existing) {
          if (existing.currentContent) {
            const idx = existing.currentContent.indexOf(oldString);
            if (idx !== -1) {
              existing.currentContent =
                existing.currentContent.slice(0, idx) +
                newString +
                existing.currentContent.slice(idx + oldString.length);
            }
            const orig = existing.originalContent ?? '';
            const { additions, deletions } = countDiff(orig, existing.currentContent);
            existing.additions = additions;
            existing.deletions = deletions;
          } else {
            (existing._pendingEdits ||= []).push({ oldString, newString });
          }
        } else {
          const snapshot = findSnapshot(rawPath, toolUseId);
          if (snapshot) {
            let current = snapshot.content;
            const idx = current.indexOf(oldString);
            if (idx !== -1) {
              current = current.slice(0, idx) + newString + current.slice(idx + oldString.length);
            }
            const { additions, deletions } = countDiff(snapshot.content, current);
            fileMap.set(filePath, {
              path: filePath,
              isNew: false,
              originalContent: snapshot.content,
              currentContent: current,
              additions,
              deletions,
            });
          } else {
            fileMap.set(filePath, {
              path: filePath,
              isNew: false,
              originalContent: undefined,
              currentContent: '',
              additions: 0,
              deletions: 0,
              _pendingEdits: [{ oldString, newString }],
            });
          }
        }
      }
    }
  }

  const allFiles = Array.from(fileMap.values());

  if (acknowledged && acknowledged.size > 0) {
    return allFiles.filter((f) => !acknowledged.has(f.path));
  }

  return allFiles;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  events: {},
  eventTimestamps: {},
  isRunning: {},
  error: {},
  todos: {},
  streamingThinking: {},
  streamingText: {},
  forceStopped: {},
  streamingToolInputs: {},
  streamingToolMeta: {},
  streamingToolIndexMap: {},
  streamedToolUseIds: {},
  changedFiles: {},
  fileOriginals: {},
  acknowledgedFiles: {},

  startQuery: async (sessionId: string, prompt: string, cwd: string, apiKey?: string, baseUrl?: string, model?: string) => {
    // Clear force-stopped flag when starting a new query
    set((s) => ({ forceStopped: { ...s.forceStopped, [sessionId]: false } }));
    // Auto-update session title from the first user message (skip slash commands)
    const state = get();
    const hasExistingUserMsg = (state.events[sessionId] || []).some(e => e.kind === 'user');
    if (!hasExistingUserMsg && !prompt.startsWith('/')) {
      const title = truncateTitle(prompt);
      if (title) {
        useSessionStore.getState().updateSessionTitle(sessionId, title);
      }
    }

    // 添加用户消息到事件列表
    const userMsg: AgentMessage = { kind: 'user', data: { content: prompt } };
    const userTs = Date.now();
    set((s) => ({
      events: {
        ...s.events,
        [sessionId]: [...(s.events[sessionId] || []), userMsg],
      },
      eventTimestamps: {
        ...s.eventTimestamps,
        [sessionId]: [...(s.eventTimestamps[sessionId] || []), userTs],
      },
      isRunning: { ...s.isRunning, [sessionId]: true },
      error: { ...s.error, [sessionId]: null },
    }));

    try {
      await agentApi.startSession(sessionId, prompt, cwd, (raw: string) => {
        let event = parseAgentEvent(raw);
        const now = Date.now();

        // Handle file_snapshot events: store original content captured before
        // Write/Edit tool execution, then re-extract changed files.
        if (event.kind === 'file_snapshot') {
          const { file_path, original_content, is_new, tool_use_id } = event.data;
          set((s) => {
            const sessionOriginals = { ...(s.fileOriginals[sessionId] || {}) };
            sessionOriginals[file_path] = { content: original_content, isNew: is_new, toolUseId: tool_use_id };
            const updatedOriginals = { ...s.fileOriginals, [sessionId]: sessionOriginals };
            const existingEvents = s.events[sessionId] || [];
            return {
              fileOriginals: updatedOriginals,
              changedFiles: {
                ...s.changedFiles,
                [sessionId]: extractChangedFilesFromEvents(existingEvents, s.acknowledgedFiles[sessionId], sessionOriginals),
              },
            };
          });
          return;
        }

        // Handle streaming events (thinking/text deltas + tool_use) separately
        if (event.kind === 'streaming') {
          if (!get().isRunning[sessionId]) return;
          const streamEvent = event.data.event as Record<string, unknown>;
          const eventType = streamEvent.type as string;
          const findToolId = (idx: number | undefined): string | undefined => {
            if (idx !== undefined) {
              const byIndex = get().streamingToolIndexMap[sessionId]?.[idx];
              if (byIndex) return byIndex;
            }
            const meta = get().streamingToolMeta[sessionId];
            if (!meta) return undefined;
            const entries = Object.entries(meta);
            return entries.length > 0 ? entries[entries.length - 1][0] : undefined;
          };

          if (eventType === 'content_block_start') {
            const contentBlock = streamEvent.content_block as Record<string, unknown> | undefined;
            if (contentBlock?.type === 'thinking') {
              set((s) => ({ streamingThinking: { ...s.streamingThinking, [sessionId]: '' } }));
            } else if (contentBlock?.type === 'text') {
              set((s) => ({ streamingText: { ...s.streamingText, [sessionId]: '' } }));
            } else if (contentBlock?.type === 'tool_use') {
              const toolId = contentBlock.id as string;
              const toolName = contentBlock.name as string;
              const blockIndex = streamEvent.index as number | undefined;
              set((s) => ({
                streamingToolMeta: {
                  ...s.streamingToolMeta,
                  [sessionId]: { ...(s.streamingToolMeta[sessionId] || {}), [toolId]: { name: toolName, index: blockIndex ?? -1 } },
                },
                streamingToolInputs: {
                  ...s.streamingToolInputs,
                  [sessionId]: { ...(s.streamingToolInputs[sessionId] || {}), [toolId]: '' },
                },
                streamingToolIndexMap: blockIndex !== undefined
                  ? { ...s.streamingToolIndexMap, [sessionId]: { ...(s.streamingToolIndexMap[sessionId] || {}), [blockIndex]: toolId } }
                  : s.streamingToolIndexMap,
              }));
            }
          } else if (eventType === 'content_block_delta') {
            const delta = streamEvent.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const toolId = findToolId(streamEvent.index as number | undefined);
              if (toolId) {
                set((s) => ({
                  streamingToolInputs: {
                    ...s.streamingToolInputs,
                    [sessionId]: {
                      ...(s.streamingToolInputs[sessionId] || {}),
                      [toolId]: ((s.streamingToolInputs[sessionId] || {})[toolId] || '') + delta.partial_json,
                    },
                  },
                }));
              }
            } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              set((s) => ({
                streamingThinking: {
                  ...s.streamingThinking,
                  [sessionId]: (s.streamingThinking[sessionId] || '') + delta.thinking,
                },
              }));
            } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              set((s) => ({
                streamingText: {
                  ...s.streamingText,
                  [sessionId]: (s.streamingText[sessionId] || '') + delta.text,
                },
              }));
            }
          } else if (eventType === 'content_block_stop') {
            const blockIndex = streamEvent.index as number | undefined;
            const toolId = findToolId(blockIndex);
            const toolMeta = toolId ? get().streamingToolMeta[sessionId]?.[toolId] : undefined;
            if (toolId && toolMeta) {
              // Skip if this tool_use block already exists in events (real event arrived first)
              const alreadyExists = (get().events[sessionId] || []).some((evt) =>
                evt.kind === 'assistant' && (evt.data?.message?.content || []).some((b: any) => b?.type === 'tool_use' && b.id === toolId)
              );
              if (alreadyExists) {
                set((s) => ({
                  streamingToolInputs: { ...s.streamingToolInputs, [sessionId]: {} },
                  streamingToolMeta: { ...s.streamingToolMeta, [sessionId]: {} },
                  streamingToolIndexMap: { ...s.streamingToolIndexMap, [sessionId]: {} },
                }));
                return;
              }
              const rawJson = get().streamingToolInputs[sessionId]?.[toolId] || '{}';
              let parsedInput: Record<string, unknown> = {};
              try { parsedInput = JSON.parse(rawJson); } catch {}

              // Capture original file content from disk BEFORE the tool executes.
              // At content_block_stop time the file is still unmodified on disk.
              // Fire-and-forget: snapshot is stored async, re-extraction happens on next event.
              if ((toolMeta.name === 'Write' || toolMeta.name === 'Edit') && parsedInput.file_path) {
                const filePath = parsedInput.file_path as string;
                const projectPath = usePreviewStore.getState().projectPath || undefined;
                fileApi.readFile(filePath, projectPath).then((original) => {
                  set((s) => {
                    const sessionOriginals = { ...(s.fileOriginals[sessionId] || {}) };
                    // Don't overwrite an existing snapshot -- the sidecar's PreToolUse
                    // snapshot is the authoritative pre-edit content; a later readFile
                    // may return post-edit content due to the race with tool execution.
                    if (!sessionOriginals[filePath]) {
                      sessionOriginals[filePath] = { content: original, isNew: false, toolUseId: toolId };
                    }
                    const events = s.events[sessionId] || [];
                    return {
                      fileOriginals: { ...s.fileOriginals, [sessionId]: sessionOriginals },
                      changedFiles: { ...s.changedFiles, [sessionId]: extractChangedFilesFromEvents(events, s.acknowledgedFiles[sessionId], sessionOriginals) },
                    };
                  });
                }).catch(() => {
                  set((s) => {
                    const sessionOriginals = { ...(s.fileOriginals[sessionId] || {}) };
                    if (!sessionOriginals[filePath]) {
                      sessionOriginals[filePath] = { content: '', isNew: true, toolUseId: toolId };
                    }
                    return { fileOriginals: { ...s.fileOriginals, [sessionId]: sessionOriginals } };
                  });
                });
              }

              const toolUseBlock: import('../types/agent').ContentBlock = {
                type: 'tool_use',
                id: toolId,
                name: toolMeta.name,
                input: parsedInput,
              };
              const syntheticAssistant: import('../types/agent').AgentAssistantMessage = {
                type: 'assistant',
                uuid: `stream-${toolId}`,
                session_id: sessionId,
                message: { role: 'assistant', content: [toolUseBlock] },
                parent_tool_use_id: null,
              };
              const syntheticEvent: AgentMessage = { kind: 'assistant', data: syntheticAssistant };
              set((s) => {
                const prev = s.events[sessionId] || [];
                const newEvents = [...prev, syntheticEvent];
                const prevIds = s.streamedToolUseIds[sessionId] || new Set<string>();
                const newIds = new Set(prevIds);
                newIds.add(toolId);
                // Un-acknowledge files that have new edits/writes since last save
                let acknowledged = s.acknowledgedFiles[sessionId];
                if (acknowledged && acknowledged.size > 0) {
                  const rawPath = parsedInput.file_path as string;
                  if (rawPath && acknowledged.has(normalizeFilePath(rawPath))) {
                    const newAcknowledged = new Set(acknowledged);
                    newAcknowledged.delete(normalizeFilePath(rawPath));
                    acknowledged = newAcknowledged;
                    try {
                      localStorage.setItem(`acknowledged-files-${sessionId}`, JSON.stringify(Array.from(newAcknowledged)));
                    } catch {}
                  }
                }
                return {
                  events: { ...s.events, [sessionId]: newEvents },
                  eventTimestamps: { ...s.eventTimestamps, [sessionId]: [...(s.eventTimestamps[sessionId] || []), now] },
                  todos: { ...s.todos, [sessionId]: extractTodosFromEvents(newEvents) },
                  changedFiles: { ...s.changedFiles, [sessionId]: extractChangedFilesFromEvents(newEvents, acknowledged, s.fileOriginals[sessionId]) },
                  streamingToolInputs: { ...s.streamingToolInputs, [sessionId]: {} },
                  streamingToolMeta: { ...s.streamingToolMeta, [sessionId]: {} },
                  streamingToolIndexMap: { ...s.streamingToolIndexMap, [sessionId]: {} },
                  streamedToolUseIds: { ...s.streamedToolUseIds, [sessionId]: newIds },
                  ...(acknowledged !== s.acknowledgedFiles[sessionId] ? { acknowledgedFiles: { ...s.acknowledgedFiles, [sessionId]: acknowledged } } : {}),
                };
              });
            } else {
              set((s) => ({
                streamingThinking: { ...s.streamingThinking, [sessionId]: '' },
                streamingText: { ...s.streamingText, [sessionId]: '' },
              }));
            }
          }
          return;
        }

        // When the complete assistant message arrives, filter out blocks
        // that were already displayed via streaming to avoid duplicate display.
        if (event.kind === 'assistant') {
          const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
          const streamedIds = get().streamedToolUseIds[sessionId];
          const hasStreamedTools = streamedIds && streamedIds.size > 0;
          // Collect all tool_use IDs already present in events (covers race condition)
          const existingToolIds = new Set<string>();
          // Collect thinking text already displayed in previous assistant events
          const seenThinkingTexts = new Set<string>();
          for (const prevEvt of (get().events[sessionId] || [])) {
            if (prevEvt.kind === 'assistant') {
              for (const b of (prevEvt.data?.message?.content || [])) {
                if (b?.type === 'tool_use' && b.id) existingToolIds.add(b.id);
                if (b?.type === 'thinking' && b.thinking) seenThinkingTexts.add(b.thinking);
              }
            }
          }
          const filtered = blocks.filter((b: any) => {
            if (b?.type === 'tool_use' && (existingToolIds.has(b.id) || streamedIds?.has(b.id))) return false;
            // Dedup thinking blocks: skip if already shown via streaming or in a previous assistant event
            if (b?.type === 'thinking') {
              if (hasStreamedTools || seenThinkingTexts.has(b.thinking)) return false;
            }
            // Dedup text blocks: skip if already shown via streaming
            if (b?.type === 'text' && hasStreamedTools) return false;
            return true;
          });
          if (filtered.length !== blocks.length) {
            event = {
              ...event,
              data: { ...event.data, message: { ...event.data.message, content: filtered } },
            };
          }
          set((s) => {
            const updates: Partial<AgentState> = {};
            if (s.streamingThinking[sessionId]) updates.streamingThinking = { ...s.streamingThinking, [sessionId]: '' };
            if (s.streamingText[sessionId]) updates.streamingText = { ...s.streamingText, [sessionId]: '' };
            return updates;
          });
        }

        set((s) => {
          const prev = s.events[sessionId] || [];
          const newEvents = [...prev, event];

          // Un-acknowledge files that have new edits/writes since last save
          let acknowledged = s.acknowledgedFiles[sessionId];
          if (acknowledged && acknowledged.size > 0 && event.kind === 'assistant') {
            const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
            const newAcknowledged = new Set(acknowledged);
            let changed = false;
            for (const block of blocks) {
              if (block?.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit')) {
                const rawPath = block.input?.file_path as string;
                if (rawPath && newAcknowledged.has(normalizeFilePath(rawPath))) {
                  newAcknowledged.delete(normalizeFilePath(rawPath));
                  changed = true;
                }
              }
            }
            if (changed) {
              acknowledged = newAcknowledged;
              try {
                localStorage.setItem(`acknowledged-files-${sessionId}`, JSON.stringify(Array.from(newAcknowledged)));
              } catch {}
            }
          }

          return {
            events: { ...s.events, [sessionId]: newEvents },
            eventTimestamps: { ...s.eventTimestamps, [sessionId]: [...(s.eventTimestamps[sessionId] || []), now] },
            todos: { ...s.todos, [sessionId]: extractTodosFromEvents(newEvents) },
            changedFiles: { ...s.changedFiles, [sessionId]: extractChangedFilesFromEvents(newEvents, acknowledged, s.fileOriginals[sessionId]) },
            ...(acknowledged !== s.acknowledgedFiles[sessionId] ? { acknowledgedFiles: { ...s.acknowledgedFiles, [sessionId]: acknowledged } } : {}),
          };
        });
        // Extract MCP server connection status from init messages
        if (event.kind === 'system' && event.data?.mcp_servers) {
          const statuses: Record<string, string> = {};
          for (const s of event.data.mcp_servers as Array<{ name: string; status: string }>) {
            statuses[s.name] = s.status;
          }
          useMcpStore.getState().updateConnectionStatus(statuses);
        }
        // Update MCP status from polling results
        if (event.kind === 'mcp_status') {
          useMcpStore.getState().updateConnectionStatus(event.data);
        }

        if (event.kind === 'done' || event.kind === 'error' || (event.kind === 'result' && event.data?.is_error)) {
          set((s) => ({
            isRunning: { ...s.isRunning, [sessionId]: false },
            error: event.kind === 'error'
              ? { ...s.error, [sessionId]: event.data.error }
              : s.error,
          }));

          // Persist agent events to database (with timestamps)
          // Delay slightly to catch late-arriving events (e.g. compact_boundary after sidecar_query_done)
          setTimeout(() => {
            const currentEvents = get().events[sessionId];
            const currentTimestamps = get().eventTimestamps[sessionId];
            if (currentEvents && currentEvents.length > 0) {
              const eventsToSave = currentEvents.filter((e) => e.kind !== 'done');
              const timestampsToSave = currentEvents
                .map((e, i) => (e.kind !== 'done' ? currentTimestamps?.[i] ?? 0 : null))
                .filter((t): t is number => t !== null);
              const payload = JSON.stringify({ events: eventsToSave, timestamps: timestampsToSave });
              agentApi.saveEvents(sessionId, payload).catch((err) => {
                console.error('Failed to save agent events:', err);
              });
            }
          }, 1000);
        }
      }, apiKey, baseUrl, model);
    } catch (err) {
      set((s) => ({
        isRunning: { ...s.isRunning, [sessionId]: false },
        error: { ...s.error, [sessionId]: String(err) },
      }));
    }
  },

  interrupt: async (sessionId: string) => {
    // 1. Immediately update UI — BEFORE sending command to sidecar
    set((s) => ({
      isRunning: { ...s.isRunning, [sessionId]: false },
      forceStopped: { ...s.forceStopped, [sessionId]: true },
      streamingThinking: { ...s.streamingThinking, [sessionId]: '' },
      streamingText: { ...s.streamingText, [sessionId]: '' },
    }));

    // 2. Then tell sidecar to stop (async, non-blocking for UI)
    await agentApi.interrupt(sessionId);

    // 3. Add interrupt marker and persist events
    set((s) => {
      const events = { ...s.events };
      const eventTimestamps = { ...s.eventTimestamps };
      // Add interrupt marker message
      const interruptMsg: AgentMessage = {
        kind: 'user',
        data: { content: '[Request interrupted by user for tool use]' },
      };
      events[sessionId] = [...(events[sessionId] || []), interruptMsg];
      eventTimestamps[sessionId] = [...(eventTimestamps[sessionId] || []), Date.now()];
      // Save events for interrupted session
      if (events[sessionId].length > 0) {
        const eventsToSave = events[sessionId].filter((e) => e.kind !== 'done');
        const tsArr = eventTimestamps[sessionId] || [];
        const timestampsToSave = events[sessionId]
          .map((e, i) => (e.kind !== 'done' ? tsArr[i] ?? 0 : null))
          .filter((t): t is number => t !== null);
        const payload = JSON.stringify({ events: eventsToSave, timestamps: timestampsToSave });
        agentApi.saveEvents(sessionId, payload).catch((err) => {
          console.error('Failed to save agent events on interrupt:', err);
        });
      }
      return { events, eventTimestamps };
    });
  },

  clearEvents: (sessionId: string) => {
    set((state) => {
      const newEvents = { ...state.events };
      delete newEvents[sessionId];
      const newTimestamps = { ...state.eventTimestamps };
      delete newTimestamps[sessionId];
      const newRunning = { ...state.isRunning };
      delete newRunning[sessionId];
      const newError = { ...state.error };
      delete newError[sessionId];
      const newTodos = { ...state.todos };
      delete newTodos[sessionId];
      const newStreaming = { ...state.streamingThinking };
      delete newStreaming[sessionId];
      const newStreamingText = { ...state.streamingText };
      delete newStreamingText[sessionId];
      const newForceStopped = { ...state.forceStopped };
      delete newForceStopped[sessionId];
      return { events: newEvents, eventTimestamps: newTimestamps, isRunning: newRunning, error: newError, todos: newTodos, streamingThinking: newStreaming, streamingText: newStreamingText, forceStopped: newForceStopped };
    });
  },

  clearSavedEvents: async (sessionId: string) => {
    // Overwrite with empty array to clear persisted events
    await agentApi.saveEvents(sessionId, JSON.stringify({ events: [], timestamps: [] }));
  },

  loadSessionMessages: async (sessionId: string) => {
    // Restore acknowledgedFiles from localStorage
    let restoredAcknowledged: Set<string> | undefined;
    try {
      const stored = localStorage.getItem(`acknowledged-files-${sessionId}`);
      if (stored) {
        const arr = JSON.parse(stored);
        if (Array.isArray(arr)) restoredAcknowledged = new Set(arr);
      }
    } catch {}

    // Don't reload if we already have events for this session
    const existing = get().events[sessionId];
    if (existing && existing.length > 0) {
      // But ensure changedFiles are extracted (may be missing after clearChangedFiles)
      const acknowledged = restoredAcknowledged ?? get().acknowledgedFiles[sessionId];
      if (!get().changedFiles[sessionId] || get().changedFiles[sessionId]!.length === 0) {
        const sessionOriginals = get().fileOriginals[sessionId];
        set((s) => ({
          acknowledgedFiles: restoredAcknowledged ? { ...s.acknowledgedFiles, [sessionId]: restoredAcknowledged } : s.acknowledgedFiles,
          changedFiles: { ...s.changedFiles, [sessionId]: extractChangedFilesFromEvents(existing, acknowledged, sessionOriginals) },
        }));
      } else if (restoredAcknowledged) {
        set((s) => ({
          acknowledgedFiles: { ...s.acknowledgedFiles, [sessionId]: restoredAcknowledged! },
        }));
      }
      return;
    }

    try {
      const eventsJson = await agentApi.getEvents(sessionId);
      if (eventsJson) {
        const parsed = JSON.parse(eventsJson);
        // Support both old format (plain array) and new format (object with timestamps)
        let events: AgentMessage[];
        let timestamps: number[];
        if (Array.isArray(parsed)) {
          // Old format: plain array of events
          events = parsed;
          timestamps = new Array(events.length).fill(0);
        } else {
          // New format: { events, timestamps }
          events = parsed.events || [];
          timestamps = parsed.timestamps || new Array(events.length).fill(0);
        }
        // Reconstruct fileOriginals from persisted file_snapshot events
        const sessionOriginals: Record<string, { content: string; isNew: boolean; toolUseId?: string }> = {};
        for (const evt of events) {
          if (evt.kind === 'file_snapshot') {
            const { file_path, original_content, is_new, tool_use_id } = evt.data;
            sessionOriginals[file_path] = { content: original_content, isNew: is_new, toolUseId: tool_use_id };
          }
        }
        set((state) => ({
          events: { ...state.events, [sessionId]: events },
          eventTimestamps: { ...state.eventTimestamps, [sessionId]: timestamps },
          todos: { ...state.todos, [sessionId]: extractTodosFromEvents(events) },
          fileOriginals: { ...state.fileOriginals, [sessionId]: sessionOriginals },
          acknowledgedFiles: restoredAcknowledged ? { ...state.acknowledgedFiles, [sessionId]: restoredAcknowledged } : state.acknowledgedFiles,
          changedFiles: { ...state.changedFiles, [sessionId]: extractChangedFilesFromEvents(events, restoredAcknowledged, sessionOriginals) },
        }));
      }
    } catch (err) {
      console.error('Failed to load agent events:', err);
    }
  },

  clearChangedFiles: (sessionId: string) => {
    set((state) => {
      const currentFiles = state.changedFiles[sessionId] || [];
      const prevAcknowledged = state.acknowledgedFiles[sessionId] || new Set<string>();
      const newAcknowledged = new Set(prevAcknowledged);
      for (const f of currentFiles) {
        newAcknowledged.add(f.path);
      }
      try {
        localStorage.setItem(`acknowledged-files-${sessionId}`, JSON.stringify(Array.from(newAcknowledged)));
      } catch {}
      const newChangedFiles = { ...state.changedFiles };
      delete newChangedFiles[sessionId];
      return {
        changedFiles: newChangedFiles,
        acknowledgedFiles: { ...state.acknowledgedFiles, [sessionId]: newAcknowledged },
      };
    });
  },
}));
