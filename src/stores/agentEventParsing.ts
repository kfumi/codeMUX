import type {
  AgentAssistantMessage,
  AgentResultMessage,
  AgentToolResult,
} from '../types/agent';

export const INTERRUPT_MARKER = '[Request interrupted by user]';

export type ParsedStoreEvent =
  | { kind: 'user'; data: { content: string } }
  | { kind: 'assistant'; data: AgentAssistantMessage }
  | { kind: 'tool_result'; data: AgentToolResult }
  | { kind: 'result'; data: AgentResultMessage };

export function isInterruptMarker(text: string): boolean {
  return text.trim() === INTERRUPT_MARKER;
}

export function shouldSuppressLiveEventWhileStopped(kind: string): boolean {
  return kind !== 'done' && kind !== 'error';
}

export function isTerminalAgentEvent(kind: string, isResultError = false): boolean {
  return kind === 'done' || kind === 'error' || (kind === 'result' && isResultError);
}

export function shouldProcessTerminalEvent(
  isRunning: boolean,
  kind: string,
  isResultError = false,
): boolean {
  if (!isTerminalAgentEvent(kind, isResultError)) {
    return true;
  }

  return isRunning;
}

export function parseSdkUserMessage(data: Record<string, unknown>): ParsedStoreEvent {
  const message = asRecord(data.message);
  const content = Array.isArray(message?.content) ? message.content : undefined;

  if (content?.some((block) => isRecord(block) && block.type === 'tool_result')) {
    return { kind: 'tool_result', data: data as unknown as AgentToolResult };
  }

  if (typeof message?.content === 'string') {
    return {
      kind: 'user',
      data: { content: message.content },
    };
  }

  const textParts = content
    ?.filter((block) => isRecord(block) && block.type === 'text')
    .map((block) => String(block.text || ''))
    .filter((text) => text.length > 0) ?? [];

  return {
    kind: 'user',
    data: { content: textParts.join('\n') },
  };
}

export function mapPersistedClaudeMessage(raw: Record<string, unknown>): ParsedStoreEvent | null {
  const msgType = raw.type;

  if (msgType === 'assistant') {
    return { kind: 'assistant', data: raw as unknown as AgentAssistantMessage };
  }

  if (msgType === 'result') {
    return { kind: 'result', data: raw as unknown as AgentResultMessage };
  }

  if (msgType === 'user') {
    return parseSdkUserMessage(raw);
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
