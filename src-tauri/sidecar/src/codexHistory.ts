export interface CachedCall {
  callId: string;
  name: string;
  arguments: string;
  namespace?: string;
  reasoningContent?: string;
}

interface CachedResponse {
  callsById: Map<string, CachedCall>;
  callOrder: string[];
}

export interface HistoryMessage {
  role: string;
  content?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  [key: string]: unknown;
}

export class CodexHistoryStore {
  private readonly maxEntries: number;
  private readonly responses = new Map<string, CachedResponse>();
  private readonly callIndex = new Map<string, string[]>();
  private readonly responseOrder: string[] = [];
  private readonly messageHistory = new Map<string, HistoryMessage[]>();

  constructor(maxEntries = 512) {
    this.maxEntries = maxEntries;
  }

  recordResponse(
    responseId: string,
    items: Array<{ type: string; call_id?: string; name?: string; namespace?: string; arguments?: string }>,
  ): void {
    const calls = items
      .filter((item) => item.type === 'function_call' && item.call_id)
      .map((item) => ({
        callId: item.call_id!,
        name: item.name ?? '',
        namespace: item.namespace,
        arguments: item.arguments ?? '',
      }));
    if (calls.length === 0) return;
    const cached: CachedResponse = { callsById: new Map(), callOrder: [] };
    for (const call of calls) {
      cached.callsById.set(call.callId, call);
      cached.callOrder.push(call.callId);
      if (!this.callIndex.has(call.callId)) this.callIndex.set(call.callId, []);
      this.callIndex.get(call.callId)!.push(responseId);
    }
    this.responses.set(responseId, cached);
    this.responseOrder.push(responseId);
    this.evict();
  }

  recordStreamingToolCall(responseId: string, call: CachedCall): void {
    let cached = this.responses.get(responseId);
    if (!cached) {
      cached = { callsById: new Map(), callOrder: [] };
      this.responses.set(responseId, cached);
      this.responseOrder.push(responseId);
    }
    cached.callsById.set(call.callId, call);
    if (!cached.callOrder.includes(call.callId)) cached.callOrder.push(call.callId);
    if (!this.callIndex.has(call.callId)) this.callIndex.set(call.callId, []);
    const index = this.callIndex.get(call.callId)!;
    if (!index.includes(responseId)) index.push(responseId);
    this.evict();
  }

  lookupCall(responseId: string | undefined, callId: string): CachedCall | null {
    if (responseId) {
      const cached = this.responses.get(responseId);
      const call = cached?.callsById.get(callId);
      if (call) return call;
    }
    const responseIds = this.callIndex.get(callId);
    if (responseIds) {
      for (const rid of responseIds) {
        const cached = this.responses.get(rid);
        const call = cached?.callsById.get(callId);
        if (call) return call;
      }
    }
    return null;
  }

  enrichRequest(
    input: Array<Record<string, unknown>>,
    previousResponseId: string | undefined,
  ): number {
    let restored = 0;
    let i = 0;
    while (i < input.length) {
      const item = input[i];
      if (item?.type === 'function_call_output' && typeof item.call_id === 'string') {
        const prev = i > 0 ? input[i - 1] : null;
        const alreadyHasCall = prev?.type === 'function_call' && prev.call_id === item.call_id;
        if (!alreadyHasCall) {
          const call = this.lookupCall(previousResponseId, item.call_id);
          if (call) {
            input.splice(i, 0, {
              type: 'function_call',
              call_id: call.callId,
              name: call.name,
              ...(call.namespace ? { namespace: call.namespace } : {}),
              arguments: call.arguments,
            });
            restored++;
            i++;
          }
        }
      }
      i++;
    }
    return restored;
  }

  storeMessages(responseId: string, messages: HistoryMessage[]): void {
    this.messageHistory.set(responseId, messages.map((m) => ({ ...m })));
    // Evict oldest message history entries when the map grows too large
    while (this.messageHistory.size > this.maxEntries) {
      const oldest = this.messageHistory.keys().next().value;
      if (oldest) this.messageHistory.delete(oldest);
      else break;
    }
  }

  getMessages(responseId: string): HistoryMessage[] | undefined {
    const messages = this.messageHistory.get(responseId);
    return messages ? messages.map((m) => ({ ...m })) : undefined;
  }

  private evict(): void {
    while (this.responseOrder.length > this.maxEntries) {
      const oldest = this.responseOrder.shift()!;
      const cached = this.responses.get(oldest);
      if (cached) {
        for (const callId of cached.callOrder) {
          const index = this.callIndex.get(callId);
          if (index) {
            const idx = index.indexOf(oldest);
            if (idx !== -1) index.splice(idx, 1);
            if (index.length === 0) this.callIndex.delete(callId);
          }
        }
      }
      this.responses.delete(oldest);
    }
  }
}
