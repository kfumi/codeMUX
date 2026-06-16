// src-tauri/sidecar/src/codexStreamTransform.ts
// Converts upstream Chat Completions SSE streams into Responses API SSE events.
// Includes a state machine for detecting inline <think> tags embedded in delta.content
// by models like Qwen that don't use the separate reasoning_content field.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatCompletionChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
};

export type ChatStreamToolCall = {
  id: string;
  name: string;
  arguments: string;
};

function parseMcpFunctionName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) {
    return null;
  }
  const parts = name.split('__');
  if (parts.length < 3 || parts[1].length === 0) {
    return null;
  }
  return {
    server: parts[1],
    tool: parts.slice(2).join('__'),
  };
}

function buildFunctionCallItem(
  toolCall: ChatStreamToolCall,
  status: 'in_progress' | 'completed',
  argumentsValue: string,
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    type: 'function_call',
    id: toolCall.id,
    status,
    call_id: toolCall.id,
    name: toolCall.name,
    arguments: argumentsValue,
  };
  const mcp = parseMcpFunctionName(toolCall.name);
  if (mcp) {
    item.server = mcp.server;
    item.tool = mcp.tool;
  }
  return item;
}

// ---------------------------------------------------------------------------
// SSE Parser
// ---------------------------------------------------------------------------

/**
 * Parse an SSE byte stream from an upstream Chat Completions endpoint into
 * individual chunk objects. Handles the standard `data: {...}\n\n` format and
 * the terminal `data: [DONE]` sentinel.
 */
export async function* parseChatCompletionSseStream(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  let buffer = '';

  let chunkCount = 0;
  let sseLineCount = 0;
  for await (const chunk of body) {
    chunkCount++;
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    buffer += text;

    if (chunkCount <= 2) {
      process.stderr.write(`[sse-parser] raw chunk#${chunkCount} len=${text.length} preview=${JSON.stringify(text.slice(0, 200))}\n`);
    }

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;

      sseLineCount++;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        process.stderr.write(`[sse-parser] stream done: ${chunkCount} raw chunks, ${sseLineCount} SSE data lines\n`);
        return;
      }

      try {
        const parsed = JSON.parse(payload) as ChatCompletionChunk;
        if (sseLineCount <= 3) {
          process.stderr.write(`[sse-parser] data#${sseLineCount} choices=${parsed.choices?.length ?? 0} delta_keys=${Object.keys(parsed.choices?.[0]?.delta ?? {}).join(',')}\n`);
        }
        yield parsed;
      } catch {
        // Skip malformed lines.
      }
    }
  }
  process.stderr.write(`[sse-parser] stream ended: ${chunkCount} raw chunks, ${sseLineCount} SSE data lines\n`);
}

// ---------------------------------------------------------------------------
// Think tag state machine
// ---------------------------------------------------------------------------

/**
 * State machine for detecting inline <think> tags in content deltas.
 *
 * - `detecting`: Looking for an opening <think> tag. Flushes safe text
 *   whenever the buffer contains no `<` character.
 * - `reasoning`: Inside a <think>...</think> block. Looking for the closing tag.
 *   Flushes safe reasoning text when no `<` character is present.
 * - `text`: After a <think>...</think> block (or no tag was ever present).
 *   Everything is emitted as plain text.
 */
export interface ThinkState {
  mode: 'detecting' | 'reasoning' | 'text';
  buffer: string;
}

type ChunkEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'startReasoning' }
  | { type: 'endReasoning' };

/**
 * Synchronous function that processes a content delta string through the think-tag
 * state machine and returns an array of events. Does NOT yield — the caller iterates
 * the returned array and yields each event into the async generator.
 */
export function processContentChunk(chunk: string, state: ThinkState): ChunkEvent[] {
  const events: ChunkEvent[] = [];

  if (state.mode === 'text') {
    // Post-tag or no-tag mode: everything is plain text.
    if (chunk) {
      events.push({ type: 'text', text: chunk });
    }
    return events;
  }

  // detecting or reasoning mode: accumulate and scan for tag boundaries.

  // --- Helper: flush safe portion when buffer has no tag start ---
  const flushSafe = (emitType: 'text' | 'reasoning'): void => {
    const ltIdx = state.buffer.indexOf('<');
    if (ltIdx === -1) {
      // No '<' at all — entire buffer is safe to emit.
      if (state.buffer) {
        events.push({ type: emitType, text: state.buffer });
        state.buffer = '';
      }
    } else if (ltIdx > 0) {
      // Text before '<' is safe; keep from '<' onward.
      const safe = state.buffer.slice(0, ltIdx);
      state.buffer = state.buffer.slice(ltIdx);
      events.push({ type: emitType, text: safe });
    }
    // If ltIdx === 0, buffer starts with '<' — keep it, might be tag start.
  };

  state.buffer += chunk;

  if (state.mode === 'detecting') {
    // Look for opening <think> tag.
    const thinkOpenIdx = state.buffer.indexOf('<think>');
    if (thinkOpenIdx !== -1) {
      // Emit any text before the tag.
      const before = state.buffer.slice(0, thinkOpenIdx);
      if (before) {
        events.push({ type: 'text', text: before });
      }
      // Switch to reasoning mode.
      events.push({ type: 'startReasoning' });
      state.mode = 'reasoning';
      // Process remainder after <think> (after the opening tag itself).
      state.buffer = state.buffer.slice(thinkOpenIdx + '<think>'.length);
      // Continue processing in reasoning mode (fall through).
    } else {
      flushSafe('text');
      return events;
    }
  }

  if (state.mode === 'reasoning') {
    // Look for closing </think> tag.
    const thinkCloseIdx = state.buffer.indexOf('</think>');
    if (thinkCloseIdx !== -1) {
      // Emit reasoning before the closing tag.
      const reasoning = state.buffer.slice(0, thinkCloseIdx);
      if (reasoning) {
        events.push({ type: 'reasoning', text: reasoning });
      }
      // Close reasoning and switch to text mode.
      events.push({ type: 'endReasoning' });
      state.mode = 'text';
      // Process remainder after </think>.
      state.buffer = state.buffer.slice(thinkCloseIdx + '</think>'.length);
      // Emit remaining as text.
      if (state.buffer) {
        events.push({ type: 'text', text: state.buffer });
        state.buffer = '';
      }
    } else {
      flushSafe('reasoning');
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Stream converter: Chat Completions chunks -> Responses API events
// ---------------------------------------------------------------------------

// Internal helpers that yield events (must be generator functions since they use yield).

type EventGenerator = Generator<Record<string, unknown>, void, unknown>;

/**
 * Convert an upstream Chat Completions SSE stream into Responses API SSE
 * events. Yields plain objects that the caller should serialize as
 * `data: <json>\n\n`.
 *
 * @param chunks   Async iterable of parsed Chat Completions chunks.
 * @param opts     Response / item IDs to reuse (generated once before the
 *                 stream starts so the opening events can reference them).
 * @returns        Async generator of Responses API event objects.
 */
export type ToolContextEntry = { kind: 'function' | 'custom' | 'tool_search'; name: string };

export async function* convertChatStreamToResponsesEvents(
  chunks: AsyncIterable<ChatCompletionChunk>,
  opts: {
    responseId: string;
    model: string;
    reasoningId: string;
    messageId: string;
    reasoningEnabled?: boolean;
    toolContext?: Map<string, ToolContextEntry>;
  },
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const { responseId, model, reasoningId, messageId } = opts;
  const reasoningEnabled = opts.reasoningEnabled ?? true;

  // Emit the opening events immediately so the SDK knows the response is in progress.
  const baseResponse = {
    id: responseId,
    object: 'response' as const,
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'in_progress' as const,
    output: [] as unknown[],
  };

  yield { type: 'response.created', response: baseResponse };
  yield { type: 'response.in_progress', response: baseResponse };

  // Track state across chunks.
  let startedReasoning = false;
  let startedText = false;
  let outputTextClosed = false;
  let itemsClosed = false;
  let textContentIndex = 0;
  let accumulatedText = '';
  let accumulatedReasoning = '';
  const thinkState: ThinkState = { mode: 'detecting', buffer: '' };

  const toolCalls = new Map<number, ChatStreamToolCall>();
  let finishReason: string | null = null;
  let lastUsage: ChatCompletionChunk['usage'] = null;

  // --- Inline helper generators (yield events into the parent generator) ---

  /** Ensure the text message item has been started. Yields added events. */
  function* ensureTextStarted(): EventGenerator {
    if (startedText) return;
    startedText = true;
    textContentIndex = startedReasoning ? 1 : 0;
    // If reasoning was started and we're now starting text, we know the
    // reasoning think block has ended (via endReasoning event or explicit
    // reasoning_content ending before content begins). Close the reasoning
    // item at its fixed output_index of 0.
    if (startedReasoning) {
      yield {
        type: 'response.output_text.done',
        item_id: reasoningId,
        output_index: 0,
        content_index: 0,
        text: accumulatedReasoning,
      };
      yield {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: reasoningId, status: 'completed', summary: [] },
      };
      startedReasoning = false;
    }
    yield {
      type: 'response.output_item.added',
      output_index: textContentIndex,
      item: { type: 'message', id: messageId, status: 'in_progress', role: 'assistant', content: [] },
    };
    yield {
      type: 'response.content_part.added',
      item_id: messageId,
      output_index: textContentIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    };
  }

  /** Close the reasoning item if it was started and hasn't been closed yet. */
  function* closeReasoning(): EventGenerator {
    if (!startedReasoning) return;
    startedReasoning = false;
    yield {
      type: 'response.output_text.done',
      item_id: reasoningId,
      output_index: 0,
      content_index: 0,
      text: accumulatedReasoning,
    };
    yield {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: reasoningId, status: 'completed', summary: [] },
    };
  }

  /** Close the text message item if it was started and hasn't been closed yet. */
  function* closeText(): EventGenerator {
    if (!startedText || outputTextClosed) return;
    outputTextClosed = true;
    process.stderr.write(`[stream-transform] closeText: accumulatedText length=${accumulatedText.length} preview=${JSON.stringify(accumulatedText.slice(0, 100))}\n`);
    yield {
      type: 'response.output_text.done',
      item_id: messageId,
      output_index: textContentIndex,
      content_index: 0,
      text: accumulatedText,
    };
    yield {
      type: 'response.content_part.done',
      item_id: messageId,
      output_index: textContentIndex,
      content_index: 0,
      part: { type: 'output_text', text: accumulatedText, annotations: [] },
    };
    yield {
      type: 'response.output_item.done',
      output_index: textContentIndex,
      item: {
        type: 'message',
        id: messageId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: accumulatedText, annotations: [] }],
      },
    };
  }

  /** Flush the think state buffer and emit any remaining content. */
  function* flushThinkBuffer(): EventGenerator {
    if (thinkState.buffer) {
      if (thinkState.mode === 'reasoning') {
        yield {
          type: 'response.reasoning_summary_text.delta',
          item_id: reasoningId,
          output_index: 0,
          delta: thinkState.buffer,
        };
        accumulatedReasoning += thinkState.buffer;
      } else {
        // detecting or text mode: emit as text.
        yield* ensureTextStarted();
        yield {
          type: 'response.output_text.delta',
          item_id: messageId,
          output_index: textContentIndex,
          content_index: 0,
          delta: thinkState.buffer,
        };
        accumulatedText += thinkState.buffer;
      }
      thinkState.buffer = '';
    }
  }

  /** Close all open items. */
  function* closeAllItems(): EventGenerator {
    yield* flushThinkBuffer();
    yield* closeReasoning();
    yield* closeText();
    itemsClosed = true;
  }

  // --- Main chunk processing loop ---

  for await (const chunk of chunks) {
    const choice = chunk.choices?.[0];
    if (!choice) {
      if (chunk.usage) lastUsage = chunk.usage;
      continue;
    }

    const delta = choice.delta;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) lastUsage = chunk.usage;

    // --- Explicit reasoning_content / reasoning deltas ---
    const reasoningDelta = delta.reasoning_content ?? delta.reasoning ?? null;
    if (reasoningDelta) {
      if (reasoningEnabled) {
        if (!startedReasoning) {
          startedReasoning = true;
          yield {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'reasoning', id: reasoningId, status: 'in_progress', summary: [] },
          };
        }
        yield {
          type: 'response.reasoning_summary_text.delta',
          item_id: reasoningId,
          output_index: 0,
          delta: reasoningDelta,
        };
        accumulatedReasoning += reasoningDelta;
      } else {
        // Reasoning disabled: treat reasoning_content as regular text
        yield* ensureTextStarted();
        yield {
          type: 'response.output_text.delta',
          item_id: messageId,
          output_index: textContentIndex,
          content_index: 0,
          delta: reasoningDelta,
        };
        accumulatedText += reasoningDelta;
      }
    }

    // --- Text content via think-tag state machine ---
    if (delta.content) {
      const chunkEvents = processContentChunk(delta.content, thinkState);

      for (const evt of chunkEvents) {
        switch (evt.type) {
          case 'startReasoning': {
            if (!startedReasoning) {
              startedReasoning = true;
              yield {
                type: 'response.output_item.added',
                output_index: 0,
                item: { type: 'reasoning', id: reasoningId, status: 'in_progress', summary: [] },
              };
            }
            break;
          }
          case 'reasoning': {
            yield {
              type: 'response.reasoning_summary_text.delta',
              item_id: reasoningId,
              output_index: 0,
              delta: evt.text,
            };
            break;
          }
          case 'endReasoning': {
            // Reasoning ended via inline tag — if text is already started,
            // close reasoning now. Otherwise, ensureTextStarted will close it
            // when the first text event arrives.
            if (startedText || outputTextClosed) {
              yield* closeReasoning();
            }
            break;
          }
          case 'text': {
            yield* ensureTextStarted();
            yield {
              type: 'response.output_text.delta',
              item_id: messageId,
              output_index: textContentIndex,
              content_index: 0,
              delta: evt.text,
            };
            accumulatedText += evt.text;
            break;
          }
        }
      }
    }

    // --- Tool call deltas ---
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = toolCalls.get(idx);
        if (!entry) {
          entry = { id: tc.id ?? `call_${idx}`, name: '', arguments: '' };
          toolCalls.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;
      }
    }

    // --- Finish reason: close all open items immediately ---
    if (finishReason) {
      yield* closeAllItems();
    }
  }

  // Close any remaining items if finish_reason wasn't received.
  if (!itemsClosed && (startedReasoning || startedText || thinkState.buffer)) {
    yield* closeAllItems();
  }

  // Emit tool call items with proper type based on toolContext.
  const baseOutputIndex = startedText ? textContentIndex + 1 : startedReasoning ? 1 : 0;
  for (const [idx, tc] of toolCalls) {
    const outputIndex = baseOutputIndex + idx;
    const spec = opts.toolContext?.get(tc.name);
    const isCustom = spec?.kind === 'custom';
    const isToolSearch = spec?.kind === 'tool_search';

    // Build the item based on tool type
    const buildItem = (status: 'in_progress' | 'completed', argsValue: string): Record<string, unknown> => {
      if (isCustom) {
        return {
          type: 'custom_tool_call',
          id: `ctc_${tc.id}`,
          status,
          call_id: tc.id,
          name: spec?.name ?? tc.name,
          input: status === 'completed' ? argsValue : '',
        };
      }
      if (isToolSearch) {
        return {
          type: 'tool_search_call',
          id: `tsc_${tc.id}`,
          status,
          call_id: tc.id,
          name: 'tool_search',
          arguments: argsValue,
        };
      }
      return buildFunctionCallItem(tc, status, argsValue);
    };

    // Determine the delta event type
    const deltaEventType = isCustom
      ? 'response.custom_tool_call_input.delta'
      : 'response.function_call_arguments.delta';
    const doneEventType = isCustom
      ? 'response.custom_tool_call_input.done'
      : 'response.function_call_arguments.done';

    yield {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: buildItem('in_progress', ''),
    };
    yield {
      type: deltaEventType,
      item_id: isCustom ? `ctc_${tc.id}` : isToolSearch ? `tsc_${tc.id}` : tc.id,
      output_index: outputIndex,
      content_index: 0,
      delta: tc.arguments,
    };
    yield {
      type: doneEventType,
      item_id: isCustom ? `ctc_${tc.id}` : isToolSearch ? `tsc_${tc.id}` : tc.id,
      output_index: outputIndex,
      content_index: 0,
      ...(isCustom ? { input: tc.arguments } : { arguments: tc.arguments }),
    };
    yield {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: buildItem('completed', tc.arguments),
    };
  }

  // Final completed response.
  const output: unknown[] = [];
  if (startedReasoning) output.push({ type: 'reasoning', id: reasoningId, summary: [] });
  if (startedText) output.push({ type: 'message', id: messageId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: accumulatedText, annotations: [] }] });
  for (const tc of toolCalls.values()) {
    const spec = opts.toolContext?.get(tc.name);
    if (spec?.kind === 'custom') {
      output.push({ type: 'custom_tool_call', id: `ctc_${tc.id}`, status: 'completed', call_id: tc.id, name: spec.name, input: tc.arguments });
    } else if (spec?.kind === 'tool_search') {
      output.push({ type: 'tool_search_call', id: `tsc_${tc.id}`, status: 'completed', call_id: tc.id, name: 'tool_search', arguments: tc.arguments });
    } else {
      output.push(buildFunctionCallItem(tc, 'completed', tc.arguments));
    }
  }

  const finalStatus = toolCalls.size > 0 ? 'requires_action' : 'completed';
  process.stderr.write(`[stream-transform] response.completed: startedReasoning=${startedReasoning} startedText=${startedText} accumulatedText.length=${accumulatedText.length} toolCalls=${toolCalls.size} output_items=${output.length}\n`);
  const usage = lastUsage ? {
    input_tokens: lastUsage.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: lastUsage.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: lastUsage.total_tokens ?? 0,
  } : undefined;

  yield {
    type: 'response.completed',
    response: {
      ...baseResponse,
      status: finalStatus,
      output,
      ...(usage ? { usage } : {}),
    },
  };
}
