import { describe, expect, it } from 'vitest';

// 直接引各模块：`timeline/index.ts` 这个 barrel 没有任何消费者，已删除。
import { parseAgentEvent } from './parse';
import { isTerminalAgentEvent, shouldProcessTerminalEvent } from './terminality';
import { buildConversationTurns } from './turns';
import type { AgentMessage } from '../../stores/agentStore';

describe('timeline module', () => {
  it('parses a raw sidecar frame into the store event shape', () => {
    expect(parseAgentEvent({ type: 'sidecar_ready' })).toEqual({
      kind: 'ready',
      data: { type: 'sidecar_ready' },
    });
  });

  it('builds turns from parsed events', () => {
    const turns = buildConversationTurns(
      [
        { kind: 'user', data: { content: 'hello' } },
        { kind: 'done' },
      ] as AgentMessage[],
      { isRunning: false },
    );

    expect(turns).toHaveLength(1);
    expect(turns[0].messages.map((event) => event.kind)).toEqual(['user', 'done']);
  });

  it('treats done/error/result as terminal and keeps synthetic boundaries open', () => {
    expect(isTerminalAgentEvent('done')).toBe(true);
    expect(isTerminalAgentEvent('error')).toBe(true);
    expect(isTerminalAgentEvent('result')).toBe(true);
    expect(isTerminalAgentEvent('assistant')).toBe(false);

    expect(shouldProcessTerminalEvent(true, 'done')).toBe(true);
    expect(shouldProcessTerminalEvent(false, 'done')).toBe(false);
    expect(shouldProcessTerminalEvent(true, 'done', false, true)).toBe(false);
  });
});
