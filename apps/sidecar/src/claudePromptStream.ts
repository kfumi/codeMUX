import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildClaudeUserMessageContent, normalizeAgentInputPayload, type AgentInputPayload } from './agentInputPayload.js';

/**
 * Push-based prompt stream so a persistent Claude query can outlive a single
 * parent turn: the initial prompt is pushed before query(), and follow-up
 * turns are pushed into the same stream instead of closing the query.
 */
export class ClaudePromptStream {
  private pending: SDKUserMessage[] = [];
  private notify: (() => void) | null = null;
  private closed = false;

  constructor(private readonly includeImages: boolean) {}

  /** Enqueue the first user message; call before handing the stream to query(). */
  pushInitial(prompt: string, inputPayload?: AgentInputPayload): void {
    if (!this.push(prompt, inputPayload)) {
      throw new Error('Prompt stream closed before the initial prompt was pushed');
    }
  }

  /** Push a follow-up prompt. Returns false when the stream is closed. */
  push(prompt: string, inputPayload?: AgentInputPayload, options?: { priority?: 'next' }): boolean {
    if (this.closed) return false;
    const payload = normalizeAgentInputPayload(prompt, inputPayload);
    this.pending.push({
      type: 'user',
      message: {
        role: 'user',
        content: buildClaudeUserMessageContent(payload, this.includeImages) as SDKUserMessage['message']['content'],
      },
      parent_tool_use_id: null,
      ...(options?.priority ? { priority: options.priority } : {}),
    });
    this.wake();
    return true;
  }

  /** Close the stream: the query ends once it drains the pending messages. */
  close(): void {
    this.closed = true;
    this.wake();
  }

  isClosed(): boolean {
    return this.closed;
  }

  get stream(): AsyncGenerator<SDKUserMessage, void, void> {
    return this.iterate();
  }

  private wake(): void {
    const notify = this.notify;
    this.notify = null;
    notify?.();
  }

  private async *iterate(): AsyncGenerator<SDKUserMessage, void, void> {
    while (true) {
      const next = this.pending.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }
}
