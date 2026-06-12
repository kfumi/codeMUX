import { describe, expect, it } from 'vitest';
import { CodexHistoryStore } from './codexHistory.js';

describe('CodexHistoryStore', () => {
  it('stores and retrieves messages by responseId', () => {
    const store = new CodexHistoryStore();
    store.recordResponse('resp_1', [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"/tmp"}' },
    ]);
    const cached = store.lookupCall('resp_1', 'call_1');
    expect(cached).toEqual({
      callId: 'call_1',
      name: 'read_file',
      arguments: '{"path":"/tmp"}',
    });
  });

  it('falls back to callIndex when responseId lookup fails', () => {
    const store = new CodexHistoryStore();
    store.recordResponse('resp_1', [
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
    ]);
    const cached = store.lookupCall('resp_wrong', 'call_1');
    expect(cached?.name).toBe('shell');
  });

  it('returns null for unknown callId', () => {
    const store = new CodexHistoryStore();
    expect(store.lookupCall('resp_1', 'call_unknown')).toBeNull();
  });

  it('enrichRequest inserts missing function_call before function_call_output', () => {
    const store = new CodexHistoryStore();
    store.recordResponse('resp_1', [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"/tmp"}' },
    ]);
    const input = [
      { type: 'function_call_output', call_id: 'call_1', output: 'file content' },
    ];
    const restored = store.enrichRequest(input, 'resp_1');
    expect(restored).toBe(1);
    expect(input).toHaveLength(2);
    expect(input[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"/tmp"}',
    });
    expect(input[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_1',
    });
  });

  it('enrichRequest does not duplicate existing function_call', () => {
    const store = new CodexHistoryStore();
    store.recordResponse('resp_1', [
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
    ]);
    const input = [
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ];
    const restored = store.enrichRequest(input, 'resp_1');
    expect(restored).toBe(0);
    expect(input).toHaveLength(2);
  });

  it('recordStreamingToolCall stores individual tool calls', () => {
    const store = new CodexHistoryStore();
    store.recordStreamingToolCall('resp_1', {
      callId: 'call_1',
      name: 'read_file',
      arguments: '{"path":"/tmp"}',
    });
    const cached = store.lookupCall('resp_1', 'call_1');
    expect(cached?.name).toBe('read_file');
  });

  it('evicts oldest entries when maxEntries exceeded', () => {
    const store = new CodexHistoryStore(2);
    store.recordResponse('resp_1', [{ type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' }]);
    store.recordResponse('resp_2', [{ type: 'function_call', call_id: 'c2', name: 'b', arguments: '{}' }]);
    store.recordResponse('resp_3', [{ type: 'function_call', call_id: 'c3', name: 'c', arguments: '{}' }]);
    expect(store.lookupCall('resp_1', 'c1')).toBeNull();
    expect(store.lookupCall('resp_2', 'c2')).toBeTruthy();
    expect(store.lookupCall('resp_3', 'c3')).toBeTruthy();
  });
});
