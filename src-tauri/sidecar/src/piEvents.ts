// pi RPC 事件 → CodeMUX 事件投影（纯函数，可单测）。
//
// pi `--mode rpc` 的事件词汇（见 pi RPC 文档）远小于 OpenCode SDK 事件面：
// 流式 delta 显式携带在 `message_update.assistantMessageEvent` 中，工具执行
// 按 `toolCallId` 关联。turn 边界（`turn_finished`）不在此投影：由
// PiRuntime 依据 agent_end / 进程退出 / 中断决定最终 outcome。
//
// COMPAT(piCumulativeMessageUpdate): pi <= 0.83 的 `message_update` 在
// assistantMessageEvent 之外重复携带累积 assistant message。这里只消费
// delta；当 delta 缺失而累积 message 存在时，按差集补发增量。

import { randomUUID } from 'node:crypto';
import type { CodeMuxRuntimeEvent } from './codeMuxProtocol.js';

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type PiRuntimeEvent = Record<string, unknown> & { type: string };

export interface PiAssistantMessage {
  role?: string;
  content?: Array<Record<string, unknown>>;
  provider?: string;
  model?: string;
  errorMessage?: string | null;
  stopReason?: string;
}

export interface PiEventContext {
  agentId: string;
  sessionId: string;
  agentSessionId?: string;
  eventIdFactory: () => string;
  /** 下一个流内容块下标（content_started/text_delta/…共用）。 */
  nextContentIndex: number;
  /** 当前打开的流内容块；pi 以 start/end 划分块边界。 */
  openBlock: { index: number; kind: 'text' | 'reasoning' } | null;
  textBuffer: string;
  thinkingBuffer: string;
}

export function createPiEventContext(input: {
  sessionId: string;
  agentSessionId?: string;
  eventIdFactory?: () => string;
}): PiEventContext {
  return {
    agentId: 'pi',
    sessionId: input.sessionId,
    ...(input.agentSessionId !== undefined ? { agentSessionId: input.agentSessionId } : {}),
    eventIdFactory: input.eventIdFactory ?? (() => randomUUID()),
    nextContentIndex: 0,
    openBlock: null,
    textBuffer: '',
    thinkingBuffer: '',
  };
}

type CodeMuxEvent = { [key: string]: unknown };

function envelope(ctx: PiEventContext, event: CodeMuxEvent, sequence: number): CodeMuxRuntimeEvent {
  const eventId = ctx.eventIdFactory();
  return {
    ...event,
    agent_id: ctx.agentId,
    session_id: ctx.sessionId,
    ...(ctx.agentSessionId !== undefined ? { agent_session_id: ctx.agentSessionId } : {}),
    event_id: eventId,
    uuid: eventId,
    sequence,
  } as unknown as CodeMuxRuntimeEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function openBlock(ctx: PiEventContext, kind: 'text' | 'reasoning', outputs: CodeMuxEvent[]): number {
  if (ctx.openBlock?.kind === kind) {
    return ctx.openBlock.index;
  }
  if (ctx.openBlock) {
    closeOpenBlock(ctx, outputs);
  }
  const index = ctx.nextContentIndex++;
  ctx.openBlock = { index, kind };
  outputs.push({
    type: 'content_started',
    index,
    content_kind: kind,
  });
  return index;
}

function closeOpenBlock(ctx: PiEventContext, outputs: CodeMuxEvent[]): void {
  if (!ctx.openBlock) return;
  outputs.push({ type: 'content_finished', index: ctx.openBlock.index });
  ctx.openBlock = null;
}

/** 从累积 assistant message 提取文本/思考累计值（COMPAT 路径用）。 */
function cumulativeMessageText(message: PiAssistantMessage): { text: string; thinking: string } {
  let text = '';
  let thinking = '';
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
    }
    if (part.type === 'thinking' && typeof part.thinking === 'string') {
      thinking += part.thinking;
    }
  }
  return { text, thinking };
}

function projectMessageUpdate(event: PiRuntimeEvent, ctx: PiEventContext, outputs: CodeMuxEvent[]): void {
  const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
  const kind = readString(assistantEvent?.type);
  const delta = readString(assistantEvent?.delta) ?? '';

  if (kind === 'text_delta' && delta) {
    const index = openBlock(ctx, 'text', outputs);
    ctx.textBuffer += delta;
    outputs.push({ type: 'text_delta', index, text: delta });
    return;
  }
  if (kind === 'thinking_delta' && delta) {
    const index = openBlock(ctx, 'reasoning', outputs);
    ctx.thinkingBuffer += delta;
    outputs.push({ type: 'reasoning_delta', index, text: delta });
    return;
  }
  if (kind === 'text_start') {
    openBlock(ctx, 'text', outputs);
    return;
  }
  if (kind === 'thinking_start') {
    openBlock(ctx, 'reasoning', outputs);
    return;
  }
  if (kind === 'text_end' || kind === 'thinking_end' || kind === 'done') {
    closeOpenBlock(ctx, outputs);
    return;
  }

  // COMPAT(piCumulativeMessageUpdate): pi <= 0.83 无显式 delta，只在
  // `message` 字段重复累积全文；按差集补发缺失后缀。
  if (!kind && isRecord(event.message)) {
    const cumulative = cumulativeMessageText(event.message as PiAssistantMessage);
    if (cumulative.text.length > ctx.textBuffer.length) {
      const suffix = cumulative.text.slice(ctx.textBuffer.length);
      const index = openBlock(ctx, 'text', outputs);
      ctx.textBuffer = cumulative.text;
      outputs.push({ type: 'text_delta', index, text: suffix });
    }
    if (cumulative.thinking.length > ctx.thinkingBuffer.length) {
      const suffix = cumulative.thinking.slice(ctx.thinkingBuffer.length);
      const index = openBlock(ctx, 'reasoning', outputs);
      ctx.thinkingBuffer = cumulative.thinking;
      outputs.push({ type: 'reasoning_delta', index, text: suffix });
    }
  }
}

function projectMessageEnd(event: PiRuntimeEvent, ctx: PiEventContext, outputs: CodeMuxEvent[]): void {
  closeOpenBlock(ctx, outputs);
  const message = isRecord(event.message) ? (event.message as PiAssistantMessage) : null;
  if (!message || message.role !== 'assistant') return;

  const content: Array<Record<string, unknown>> = [];
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
      content.push({ type: 'thinking', thinking: part.thinking });
    } else if (part.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string') {
      content.push({
        type: 'tool_use',
        id: part.id,
        name: part.name,
        input: isRecord(part.arguments) ? part.arguments : {},
      });
    }
  }
  outputs.push({
    type: 'assistant_message',
    content,
    ...(typeof message.stopReason === 'string' ? { provider_stop_reason: message.stopReason } : {}),
  });
}

function projectToolStart(event: PiRuntimeEvent, outputs: CodeMuxEvent[]): void {
  const toolCallId = readString(event.toolCallId);
  const toolName = readString(event.toolName);
  if (!toolCallId || !toolName) return;
  outputs.push({
    type: 'tool_started',
    tool_use_id: toolCallId,
    name: toolName,
    input: isRecord(event.args) ? event.args : {},
  });
}

function projectToolEnd(event: PiRuntimeEvent, outputs: CodeMuxEvent[]): void {
  const toolCallId = readString(event.toolCallId);
  if (!toolCallId) return;
  const isError = event.isError === true;
  let content = '';
  if (typeof event.result === 'string') {
    content = event.result;
  } else if (event.result !== undefined && event.result !== null) {
    try {
      content = JSON.stringify(event.result);
    } catch {
      content = String(event.result);
    }
  }
  outputs.push({
    type: 'tool_finished',
    tool_use_id: toolCallId,
    content,
    is_error: isError,
  });
}

/**
 * 将单个 pi RPC 事件投影为 0..n 个 CodeMUX 事件。`turn_finished` 与错误
 * 事件不在此产生（由 PiRuntime 决定 outcome）。
 */
export function toCodeMuxEvents(event: PiRuntimeEvent, ctx: PiEventContext): CodeMuxRuntimeEvent[] {
  const outputs: CodeMuxEvent[] = [];
  let sequence = 0;

  switch (event.type) {
    case 'message_update':
      projectMessageUpdate(event, ctx, outputs);
      break;
    case 'message_end':
      projectMessageEnd(event, ctx, outputs);
      break;
    case 'tool_execution_start':
      projectToolStart(event, outputs);
      break;
    case 'tool_execution_end':
      projectToolEnd(event, outputs);
      break;
    case 'message_start':
    case 'tool_execution_update':
    case 'agent_start':
    case 'agent_settled':
    case 'turn_start':
    case 'turn_end':
    case 'compaction_start':
    case 'compaction_end':
    case 'queue_update':
    case 'extension_ui_request':
    case 'command_output':
      break;
    default:
      break;
  }

  return outputs.map((output) => envelope(ctx, output, sequence++));
}
