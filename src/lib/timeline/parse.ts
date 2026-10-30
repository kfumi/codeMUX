import type { AgentMessage } from '../../stores/agentStore';
import {
  isAgentInjectedUserMessage,
  isClaudeCompactSummaryText,
  isClaudeSubagentEvent,
  isClaudeTaskNotificationEvent,
  isCodexCompactSummaryText,
  mapCodexCompactedEvent,
  normalizeClaudeUserEvent,
  parseSdkUserMessage,
} from '../../stores/agentEventParsing';
import {
  isCodeMuxAssistantMessageEvent,
  isCodeMuxDiagnosticEvent,
  isCodeMuxPermissionModeChangedEvent,
  isCodeMuxPermissionRequestedEvent,
  isCodeMuxPermissionResolvedEvent,
  isCodeMuxStreamEvent,
  isCodeMuxSystemEvent,
  isCodeMuxToolEvent,
  isCodeMuxTurnEvent,
  isCodeMuxUserInputRequestedEvent,
  isCodeMuxUserMessageEvent,
  toLegacyAssistantMessage,
  toLegacyPermissionModeChangedMessage,
  toLegacyPermissionRequestedMessage,
  toLegacyPermissionResolvedMessage,
  toLegacyStreamingMessage,
  toLegacySystemMessage,
  toLegacyToolMessage,
  toLegacyTurnMessage,
  toLegacyUserInputRequestedMessage,
  toLegacyUserMessage,
} from '../codeMuxProtocol';
import type { ModeBlockedDiagnostic, TodoItem } from '../../types/agent';

const parsedAgentEventCache = new WeakMap<Record<string, unknown>, AgentMessage>();

export function parseAgentEvent(raw: string | Record<string, unknown>): AgentMessage {
  if (typeof raw !== 'string') {
    const cached = parsedAgentEventCache.get(raw);
    if (cached) return cached;
    const parsed = parseAgentEventUncached(raw);
    // 解析结果必须是不可变快照才能安全共享：下游 reducer 会持有它，而调用方传进来的是
    // store 里的原始事件对象。`parseAgentEventUncached` 每次都新建对象，天然满足。
    parsedAgentEventCache.set(raw, parsed);
    return parsed;
  }
  return parseAgentEventUncached(raw);
}

function parseAgentEventUncached(raw: string | Record<string, unknown>): AgentMessage {
  try {
    // 字符串生产者（遗留 sidecar 流、持久化时间线行、测试）才付解析代价；对象生产者
    // 已经在调用方解析过了。
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // Filter out sub-agent (sidechain) messages from the main event stream.
    if (isClaudeSubagentEvent(data)) {
      return { kind: 'raw', data };
    }

    if (isClaudeTaskNotificationEvent(data)) {
      return { kind: 'raw', data };
    }

    const codexCompactedEvent = mapCodexCompactedEvent(data);
    if (codexCompactedEvent) {
      return codexCompactedEvent;
    }

    switch (data.type) {
      case 'sidecar_ready':
        return { kind: 'ready', data };
      case 'sidecar_error':
        return { kind: 'error', data };
      case 'session_resume_failed':
        return { kind: 'resume_failed', data };
      case 'sidecar_query_done':
        return { kind: 'done' };
      case 'mcp_status_update':
        return { kind: 'mcp_status', data: { servers: (data as any).servers || {}, status: (data as any).status } };
      case 'proxy_status':
        return { kind: 'proxy_status', data: { running: (data as any).running, port: (data as any).port, upstreamBaseUrl: (data as any).upstreamBaseUrl } };
      case 'codex_todo_list':
        return {
          kind: 'todo_list',
          data: {
            todos: Array.isArray((data as any).todos)
              ? (data as any).todos
                .map((todo: any) => ({
                  content: String(todo?.content || ''),
                  status: (['pending', 'in_progress', 'completed'].includes(todo?.status) ? todo.status : 'pending') as TodoItem['status'],
                  activeForm: todo?.activeForm || undefined,
                }))
                .filter((todo: TodoItem) => todo.content.length > 0)
              : [],
          },
        };
      case 'assistant':
        if (isAssistantCompactSummaryEvent(data)) {
          return { kind: 'raw', data };
        }
        return { kind: 'assistant', data };
      case 'user':
        {
          const event = parseSdkUserMessage(data);
          if (event.kind === 'user' && isAgentInjectedUserMessage(event.data.content)) {
            return { kind: 'raw', data };
          }
          if (event.kind === 'user') {
            if (
              data.isMeta === true ||
              data.isCompactSummary === true ||
              data.isVisibleInTranscriptOnly === true ||
              isClaudeCompactSummaryText(event.data.content)
            ) {
              return { kind: 'raw', data };
            }
            const normalized = normalizeClaudeUserEvent(event);
            return normalized ?? { kind: 'raw', data };
          }
          return event;
        }
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
      case 'permission':
        if (typeof data.request_id !== 'string' || typeof data.permission_type !== 'string') return { kind: 'raw', data };
        return { kind: 'permission', data: { request_id: data.request_id, permission_id: typeof data.permission_id === 'string' ? data.permission_id : undefined, permission_type: data.permission_type, description: typeof data.description === 'string' ? data.description : data.permission_type, metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata as Record<string, unknown> : undefined } };
      case 'ask_user_question_timeout':
        return { kind: 'ask_user_question_timeout', data };
      case 'file_snapshot':
        return { kind: 'file_snapshot', data };
      case 'stream_event':
        return { kind: 'streaming', data: { event: data.event, session_id: data.session_id } };
      case 'stream_event_batch':
        return { kind: 'streaming_batch', data: { events: Array.isArray(data.events) ? data.events : [], session_id: data.session_id } };
      case 'codemux_event_batch': {
        const codeMuxEvents = Array.isArray(data.events)
          ? (data.events as unknown[]).filter(isCodeMuxStreamEvent)
          : [];
        const events = codeMuxEvents.flatMap((event) => {
          const legacy = toLegacyStreamingMessage(event);
          return legacy.kind === 'streaming' ? [legacy.data.event] : [];
        });
        return { kind: 'streaming_batch', data: { events, session_id: data.session_id } };
      }
      case 'content_started':
      case 'text_delta':
      case 'reasoning_delta':
      case 'content_finished':
        if (isCodeMuxStreamEvent(data)) return toLegacyStreamingMessage(data);
        return { kind: 'raw', data };
      case 'tool_started':
      case 'tool_finished':
        if (isCodeMuxToolEvent(data)) return toLegacyToolMessage(data);
        return { kind: 'raw', data };
      case 'assistant_message':
        if (isCodeMuxAssistantMessageEvent(data)) {
          const event = toLegacyAssistantMessage(data);
          return event.kind === 'assistant' && isAssistantCompactSummaryEvent(event.data as unknown as Record<string, unknown>)
            ? { kind: 'raw', data }
            : event;
        }
        return { kind: 'raw', data };
      case 'user_message':
        if (isCodeMuxUserMessageEvent(data)) {
          const event = toLegacyUserMessage(data);
          return event.kind === 'user' && isAgentInjectedUserMessage(event.data.content)
            ? { kind: 'raw', data }
            : event;
        }
        return { kind: 'raw', data };
      case 'system_event':
        if (isCodeMuxSystemEvent(data)) return toLegacySystemMessage(data);
        return { kind: 'raw', data };
      case 'diagnostic':
        if (isCodeMuxDiagnosticEvent(data)) return { kind: 'raw', data };
        return { kind: 'raw', data };
      case 'user_input_requested':
        if (isCodeMuxUserInputRequestedEvent(data)) return toLegacyUserInputRequestedMessage(data);
        return { kind: 'raw', data };
      case 'permission_requested':
        if (isCodeMuxPermissionRequestedEvent(data)) return toLegacyPermissionRequestedMessage(data);
        return { kind: 'raw', data };
      case 'permission_resolved':
        if (isCodeMuxPermissionResolvedEvent(data)) return toLegacyPermissionResolvedMessage(data);
        return { kind: 'raw', data };
      case 'permission_mode_changed':
        if (isCodeMuxPermissionModeChangedEvent(data)) return toLegacyPermissionModeChangedMessage(data);
        return { kind: 'raw', data };
      case 'error':
      case 'turn_finished':
        if (isCodeMuxTurnEvent(data)) return toLegacyTurnMessage(data);
        return { kind: 'raw', data };
      case 'sidecar_debug':
        return { kind: 'raw', data };
      case 'sidecar_stream_status':
        return {
          kind: 'stream_status',
          data: {
            message: data.message,
            is_reconnecting: data.is_reconnecting,
            mode_blocked: isModeBlockedDiagnostic(data.mode_blocked) ? data.mode_blocked : null,
          },
        };
      case 'vision_unsupported':
        return { kind: 'raw', data };
      default:
        return { kind: 'raw', data };
    }
  } catch {
    return { kind: 'raw', data: { type: 'parse_error', raw } };
  }
}

function isModeBlockedDiagnostic(value: unknown): value is ModeBlockedDiagnostic {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAssistantCompactSummaryEvent(data: Record<string, unknown>): boolean {
  const message = data.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }

  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') {
    return isCodexCompactSummaryText(content);
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return false;
    }
    const text = (block as Record<string, unknown>).text;
    return typeof text === 'string' && isCodexCompactSummaryText(text);
  });
}
