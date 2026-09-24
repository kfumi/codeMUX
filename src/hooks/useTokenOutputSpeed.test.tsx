// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentStore } from '../stores/agentStore';
import { useTokenOutputSpeed } from './useTokenOutputSpeed';

describe('useTokenOutputSpeed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    useAgentStore.setState({ streamingEstimatedOutputTokens: {}, isRunning: { s: true }, queryStartTime: { s: 0 } });
  });
  afterEach(() => vi.useRealTimers());

  it('waits for the first token and then updates every 500ms', () => {
    const { result } = renderHook(() => useTokenOutputSpeed('s', 0, true));
    expect(result.current).toBeNull();
    act(() => { useAgentStore.setState({ streamingEstimatedOutputTokens: { s: 10 } }); vi.advanceTimersByTime(500); });
    expect(result.current).toBe(20);
    act(() => { useAgentStore.setState({ streamingEstimatedOutputTokens: { s: 15 } }); vi.advanceTimersByTime(500); });
    expect(result.current).toBeGreaterThan(0);
  });

  it('holds and decays the last reading during silence', () => {
    const { result } = renderHook(() => useTokenOutputSpeed('s', 0, true));
    act(() => { useAgentStore.setState({ streamingEstimatedOutputTokens: { s: 10 } }); vi.advanceTimersByTime(500); });
    const active = result.current!;
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current).toBeLessThan(active);
    expect(result.current).not.toBeNull();
  });

  it('resets when turn identity changes', () => {
    const { result, rerender } = renderHook(({ start }) => useTokenOutputSpeed('s', start, true), { initialProps: { start: 0 } });
    act(() => { useAgentStore.setState({ streamingEstimatedOutputTokens: { s: 10 } }); vi.advanceTimersByTime(500); });
    expect(result.current).not.toBeNull();
    rerender({ start: 1 });
    expect(result.current).toBeNull();
  });

  it('waits for genuinely new output when mounted after a turn already has tokens', () => {
    useAgentStore.setState({ streamingEstimatedOutputTokens: { s: 100 } });
    const { result } = renderHook(() => useTokenOutputSpeed('s', 0, true));

    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current).toBeNull();

    act(() => {
      useAgentStore.setState({ streamingEstimatedOutputTokens: { s: 120 } });
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBeGreaterThan(0);
  });
});
