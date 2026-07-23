import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePerfStore, SLOW_IPC_CAP, RENDER_AGGREGATE_CAP } from './perfStore';

beforeEach(() => {
  usePerfStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('perfStore IPC samples', () => {
  it('只记录超过阈值的慢调用到 slowIpcSamples', () => {
    const store = usePerfStore.getState();
    store.setSlowThresholdMs(50);
    store.recordIpc('fast_cmd', 10, false);
    store.recordIpc('slow_cmd', 80, false);
    const slow = usePerfStore.getState().slowIpcSamples;
    expect(slow).toHaveLength(1);
    expect(slow[0].command).toBe('slow_cmd');
    expect(slow[0].durationMs).toBe(80);
  });

  it('慢调用环形缓冲超过容量时淘汰最旧', () => {
    const store = usePerfStore.getState();
    store.setSlowThresholdMs(0);
    for (let i = 0; i < SLOW_IPC_CAP + 5; i++) {
      store.recordIpc(`cmd_${i}`, 1, false);
    }
    const slow = usePerfStore.getState().slowIpcSamples;
    expect(slow).toHaveLength(SLOW_IPC_CAP);
    expect(slow[0].command).toBe(`cmd_5`);
    expect(slow[slow.length - 1].command).toBe(`cmd_${SLOW_IPC_CAP + 4}`);
  });

  it('每次 IPC 调用都计入时间戳窗口用于 rate', () => {
    const now = 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const store = usePerfStore.getState();
    store.recordIpc('a', 1, false);
    store.recordIpc('a', 1, false);
    store.recordIpc('a', 1, false);
    expect(usePerfStore.getState().getIpcRateNow()).toBe(3);
  });

  it('getIpcRateNow 只统计最近 1000ms 的调用', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const store = usePerfStore.getState();
    store.recordIpc('a', 1, false);
    store.recordIpc('a', 1, false);
    vi.spyOn(Date, 'now').mockReturnValue(2_500);
    store.recordIpc('a', 1, false);
    expect(usePerfStore.getState().getIpcRateNow()).toBe(1);
  });
});

describe('perfStore render aggregates', () => {
  it('相同 id 的 commit 正确累加', () => {
    const store = usePerfStore.getState();
    store.recordRender('MessageList', 5, 6);
    store.recordRender('MessageList', 3, 4);
    store.recordRender('MessageList', 2, 2);
    const top = usePerfStore.getState().getTopRenders(5);
    expect(top).toHaveLength(1);
    expect(top[0].id).toBe('MessageList');
    expect(top[0].commitCount).toBe(3);
    expect(top[0].totalMs).toBe(10);
    expect(top[0].baseTotalMs).toBe(12);
  });

  it('getTopRenders 按 commit 次数降序', () => {
    const store = usePerfStore.getState();
    store.recordRender('A', 1, 1);
    store.recordRender('B', 1, 1);
    store.recordRender('B', 1, 1);
    store.recordRender('B', 1, 1);
    const top = usePerfStore.getState().getTopRenders(5);
    expect(top[0].id).toBe('B');
    expect(top[0].commitCount).toBe(3);
    expect(top[1].id).toBe('A');
  });

  it('render 聚合超过容量时淘汰最旧', () => {
    const store = usePerfStore.getState();
    for (let i = 0; i < RENDER_AGGREGATE_CAP + 2; i++) {
      store.recordRender(`cmp_${i}`, 1, 1);
    }
    const top = usePerfStore.getState().getTopRenders(RENDER_AGGREGATE_CAP + 5);
    expect(top).toHaveLength(RENDER_AGGREGATE_CAP);
  });
});
