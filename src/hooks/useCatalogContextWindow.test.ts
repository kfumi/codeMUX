// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { daemonFacade } from '@/lib/facades/daemon-facade';
import {
  __resetCatalogContextWindowCacheForTests,
  useCatalogContextWindow,
} from './useCatalogContextWindow';

vi.mock('@/lib/facades/daemon-facade', () => ({
  daemonFacade: { lookupModelCatalog: vi.fn() },
}));

const lookup = vi.mocked(daemonFacade.lookupModelCatalog);

beforeEach(() => {
  __resetCatalogContextWindowCacheForTests();
  lookup.mockReset();
});

afterEach(() => {
  __resetCatalogContextWindowCacheForTests();
});

describe('useCatalogContextWindow', () => {
  it('resolves the published context window', async () => {
    lookup.mockResolvedValue({
      found: true,
      source: 'remote',
      entry: {
        provider: 'opencode',
        model_id: 'space-bunny-free',
        reasoning: true,
        reasoning_published: true,
        thinking_levels: [],
        input_modalities: ['text', 'image'],
        context_window: 1_048_576,
      },
    });

    const { result } = renderHook(() => useCatalogContextWindow('space-bunny-free', 'opencode'));

    await waitFor(() => expect(result.current).toBe(1_048_576));
    expect(lookup).toHaveBeenCalledWith('space-bunny-free', 'opencode');
  });

  it('strips the [1m] marker before looking up', async () => {
    lookup.mockResolvedValue({ found: false, source: 'remote' });

    const { result } = renderHook(() => useCatalogContextWindow('claude-opus-5[1m]', 'anthropic'));

    await waitFor(() => expect(result.current).toBeNull());
    expect(lookup).toHaveBeenCalledWith('claude-opus-5', 'anthropic');
  });

  it('answers null when the catalog has no entry — a miss is not an error', async () => {
    lookup.mockResolvedValue({ found: false, source: 'bundled' });

    const { result } = renderHook(() => useCatalogContextWindow('jev-1.13-free', 'opencode'));

    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
  });

  it('answers null when the entry omits a usable context window', async () => {
    lookup.mockResolvedValue({
      found: true,
      source: 'remote',
      entry: {
        provider: 'opencode',
        model_id: 'mystery-free',
        reasoning: false,
        reasoning_published: false,
        thinking_levels: [],
        input_modalities: ['text'],
        context_window: 0,
      },
    });

    const { result } = renderHook(() => useCatalogContextWindow('mystery-free', 'opencode'));

    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
  });

  it('does not query at all without a model id', async () => {
    const { result } = renderHook(() => useCatalogContextWindow('', 'opencode'));

    await waitFor(() => expect(result.current).toBeNull());
    expect(lookup).not.toHaveBeenCalled();
  });

  it('caches hits and misses per model', async () => {
    lookup.mockResolvedValue({ found: false, source: 'bundled' });

    const first = renderHook(() => useCatalogContextWindow('big-pickle', 'opencode'));
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    first.unmount();

    const second = renderHook(() => useCatalogContextWindow('big-pickle', 'opencode'));
    await waitFor(() => expect(second.result.current).toBeNull());
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('does not cache a transport failure, so a later mount retries', async () => {
    lookup.mockRejectedValueOnce(new Error('daemon unreachable'));

    const failed = renderHook(() => useCatalogContextWindow('longcat-2.5-preview-free', 'opencode'));
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(failed.result.current).toBeNull());
    failed.unmount();

    lookup.mockResolvedValue({ found: false, source: 'remote' });
    const retry = renderHook(() => useCatalogContextWindow('longcat-2.5-preview-free', 'opencode'));
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    expect(retry.result.current).toBeNull();
  });
});