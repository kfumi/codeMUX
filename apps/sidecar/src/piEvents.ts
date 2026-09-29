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
  const toolEvents: CodeMuxEvent[] = [];
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
      content.push({ type: 'thinking', thinking: part.thinking });
    } else if (part.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string') {
      // 工具调用拆成独立 tool_started 事件（在思考/正文消息之后），与 CLI
      // 同步的 normalize 拆分保持一致——否则思考与工具组挤进同一条消息行。
      // 后续 tool_execution_start 以相同 id 到达时由前端原地刷新参数。
      toolEvents.push({
        type: 'tool_started',
        tool_use_id: part.id,
        name: part.name,
        input: isRecord(part.arguments) ? part.arguments : {},
      });
    }
  }
  if (content.length > 0) {
    outputs.push({
      type: 'assistant_message',
      content,
      ...(typeof message.stopReason === 'string' ? { provider_stop_reason: message.stopReason } : {}),
    });
  }
  outputs.push(...toolEvents);
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

/** pi 提问工具名（与前端 ASK_USER_QUESTION_TOOL_NAMES 对齐）。 */
const PI_ASK_TOOL_NAMES = new Set([
  'ask_user_question',
  'AskUserQuestion',
  'askUserQuestion',
  'request_user_input',
  'question',
]);

/**
 * pi 提问工具的 tool result → CodeMUX 提问卡能读的位置序形状
 * `{"answers":[["答案"], ...]}`；不是提问工具（或没有结构化答案）返回 null。
 *
 * pi 扩展把答案放在 `details.answers`（`[{question, answer}]`），`content`
 * 只是喂给模型的 `"问题: 答案"` 文本。直接透传整个 result 时提问卡读不到
 * `answers`（藏在 `details` 下），答案回显成"未作答"。全部 answer 为 null
 * 表示用户取消（`ctx.ui.select` 收到 cancelled），映射成提问卡已支持的
 * `__cancelled__` 哨兵；空字符串是合法的自由文本答复，不算取消。
 *
 * 本函数是 pi 提问卡投影的**孪生实现**之一：另一侧是历史/重放投影
 * `crates/daemon/src/agent/pi_history.rs` 的 `pi_tool_result_content`。同一份 pi
 * 会话既会实时投影、也会被重放投影（导入 / 重开会话 / rewind），两侧对同一输入
 * 必须输出**逐字相同**的字符串，否则"重开会话"会渲染出与当时不同的内容：
 * - 全部 answer 为 null → 两侧都 `__cancelled__`；
 * - 部分作答（有的 answer 为 null、有的为字符串，用户在对话框中途取消）→
 *   两侧都把未作答项落成空串 `[""]`，不落 `null`；
 * - 空字符串是合法答复，不算取消。
 * 改任一侧时必须同步改另一侧，并同时更新两侧测试。
 *
 * 已知且刻意的差异：`details.answers` 为**空数组**时本侧返回 `{"answers":[]}`，
 * Rust 侧返回拍平文本；真实 pi 不会写出空数组，且前端对两者都渲染成"未作答"
 *（`AskUserQuestionCard.tsx` 的 `normalizeAnswerValues` 把 null 与 `''` 一并归一
 * 成空），故不强行统一。
 */
export function piAskToolResultContent(toolName: string | null | undefined, result: unknown): string | null {
  if (!toolName || !PI_ASK_TOOL_NAMES.has(toolName)) return null;
  if (!isRecord(result)) return null;
  const details = result.details;
  if (!isRecord(details) || !Array.isArray(details.answers)) return null;

  const answers = details.answers.map((entry) =>
    isRecord(entry) && typeof entry.answer === 'string' ? entry.answer : null,
  );
  if (answers.length > 0 && answers.every((answer) => answer === null)) return '__cancelled__';
  return JSON.stringify({ answers: answers.map((answer) => [answer ?? '']) });
}

/**
 * pi 的工具结果 → 拍平文本。pi 把工具输出放在 `content` 里（文本块数组
 * `[{type:"text",text}]`，也可能是裸字符串），直接 `JSON.stringify` 整个
 * result 会让终端面板渲染成 `{"content":[{"type":"text",...}]}` 的 JSON 转储。
 * 只有非字符串、非对象的 result（如数字）拍不出文本，返回 undefined 交回调用方
 * 走原来的 JSON 兜底。
 *
 * 本函数是历史/重放投影 `crates/daemon/src/agent/pi_history.rs` 的
 * `flatten_pi_content_text` 的**孪生实现**：同一份 pi 会话既会实时投影、也会被
 * 重放投影（导入 / 重开会话 / rewind），两侧对同一输入必须输出**逐字相同**的
 * 字符串，否则「重开会话」会渲染出与当时不同的内容。故文本块分隔符同为 `"\n\n"`、
 * 空块数组同落空串、非文本块的 `content` 同原样透传。
 *
 * 已知且刻意的差异：result 缺 `content`（或为 null）时本侧返回 undefined 走 JSON
 * 兜底，Rust 侧拍成空串——见下面 null 分支的注释。
 *
 * 改任一侧时必须同步改另一侧，并同时更新两侧测试。
 */
function flattenPiResultText(result: unknown): string | undefined {
  if (typeof result === 'string') {
    return result;
  }

  if (!isRecord(result)) {
    return undefined;
  }

  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
      .map((block) => block.text as string)
      .join('\n\n');
  }

  if (typeof content === 'string') {
    return content;
  }

  if (content == null) {
    // 刻意与 Rust 侧不同：Rust 的 `unwrap_or(&Value::Null)` 会把缺失/null 的
    // `content` 拍成空串，这里改回整个 result 的 JSON——空串会把
    // `{"message":"boom"}` 这类没有 `content` 的工具结果整条吞掉。真实 pi 的
    // toolResult 一定带 `content`，这条分支只兜住非标准返回值；两侧只在
    // 「没有 content」这一种畸形输入上不同，真实会话不受影响。
    return undefined;
  }

  // 非文本块的 content 原样透传（对齐 Rust 侧 `other => other.clone()`）。
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function projectToolEnd(event: PiRuntimeEvent, outputs: CodeMuxEvent[]): void {
  const toolCallId = readString(event.toolCallId);
  if (!toolCallId) return;
  const isError = event.isError === true;
  const askContent = piAskToolResultContent(readString(event.toolName), event.result);
  let content = '';
  if (askContent !== null) {
    content = askContent;
  } else {
    // 提问工具之外一律先拍平 pi 的 content 块，让命令输出与其他运行时一样是纯文本。
    const flattened = flattenPiResultText(event.result);
    if (flattened !== undefined) {
      content = flattened;
    } else if (event.result !== undefined && event.result !== null) {
      try {
        content = JSON.stringify(event.result);
      } catch {
        content = String(event.result);
      }
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
    case 'queue_update':
    case 'extension_ui_request':
    case 'command_output':
      break;
    case 'compaction_start':
    case 'compaction_end':
      projectCompaction(event, ctx, outputs);
      break;
    default:
      break;
  }

  return outputs.map((output) => envelope(ctx, output, sequence++));
}

/**
 * 压缩边界投影为 `compact_boundary` 系统事件（与 Claude/Codex 的压缩时间线
 * 同构）；`trigger` 按 manual/auto 归类，token 数 pi 事件未携带则缺省。
 */
function projectCompaction(event: PiRuntimeEvent, ctx: PiEventContext, outputs: CodeMuxEvent[]): void {
  if (event.type !== 'compaction_end') return;
  if (event.aborted === true) return;
  const reason = readString(event.reason);
  outputs.push({
    type: 'system_event',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    compact_metadata: {
      trigger: reason === 'manual' ? 'manual' : 'auto',
    },
  });
}
