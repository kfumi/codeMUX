import { describe, expect, it, vi } from 'vitest';
import { OpenCodePermissionRegistry, type OpenCodePermissionRequest } from './opencodePermissions.js';

function request(overrides: Partial<OpenCodePermissionRequest> = {}): OpenCodePermissionRequest {
  return {
    requestId: 'permission-1',
    openCodeSessionId: 'opencode-session-1',
    codeMuxSessionId: 'codemux-session-1',
    permissionType: 'read',
    description: 'Read a file',
    metadata: { path: 'README.md' },
    raw: { id: 'permission-1', type: 'read', sessionID: 'opencode-session-1' },
    respond: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('OpenCodePermissionRegistry', () => {
  it('registers requests with their native metadata and responds once', async () => {
    const registry = new OpenCodePermissionRegistry();
    const pending = request();
    const stored = registry.add(pending);
    expect(stored).toMatchObject({ requestId: 'permission-1', openCodeSessionId: 'opencode-session-1', codeMuxSessionId: 'codemux-session-1', permissionType: 'read', description: 'Read a file', metadata: { path: 'README.md' }, raw: pending.raw });
    expect(stored.createdAt).toBeTypeOf('number');
    await registry.respond('permission-1', 'codemux-session-1', { approved: true });
    expect(pending.respond).toHaveBeenCalledWith('once');
    await expect(registry.respond('permission-1', 'codemux-session-1', { approved: false })).rejects.toThrow('no longer pending');
  });

  it('rejects an incorrect session without calling the SDK', async () => {
    const registry = new OpenCodePermissionRegistry();
    const pending = request();
    registry.add(pending);
    await expect(registry.respond('permission-1', 'other-session', { approved: true })).rejects.toThrow('does not belong to session');
    expect(pending.respond).not.toHaveBeenCalled();
    expect(registry.get('permission-1')).toBeDefined();
  });

  it('serializes concurrent responses so the SDK is called once', async () => {
    const registry = new OpenCodePermissionRegistry();
    const respond = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 10)));
    registry.add(request({ respond }));
    const results = await Promise.allSettled([
      registry.respond('permission-1', 'codemux-session-1', { approved: true }),
      registry.respond('permission-1', 'codemux-session-1', { approved: false }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('expires pending requests and does not respond again after timeout', async () => {
    vi.useFakeTimers();
    try {
      const registry = new OpenCodePermissionRegistry({ timeoutMs: 25 });
      const respond = vi.fn().mockResolvedValue(true);
      registry.add(request({ respond }));
      await vi.advanceTimersByTimeAsync(25);
      expect(respond).toHaveBeenCalledWith('reject');
      expect(registry.get('permission-1')).toBeUndefined();
      await expect(registry.respond('permission-1', 'codemux-session-1', { approved: true })).rejects.toMatchObject({ code: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears all pending requests even when native cancellation fails', async () => {
    const registry = new OpenCodePermissionRegistry();
    const failing = vi.fn().mockRejectedValue(new Error('native response failed'));
    const successful = vi.fn().mockResolvedValue(true);
    registry.add(request({ requestId: 'permission-failing', respond: failing }));
    registry.add(request({ requestId: 'permission-successful', respond: successful }));
    const results = await registry.cancelAll('codemux-session-1');
    expect(results).toHaveLength(2);
    expect(results.some((result) => result.error)).toBe(true);
    expect(registry.size).toBe(0);
    expect(failing).toHaveBeenCalledWith('reject');
    expect(successful).toHaveBeenCalledWith('reject');
  });

  it('restores a request after native response failure so the user can retry', async () => {
    const registry = new OpenCodePermissionRegistry();
    const respond = vi.fn()
      .mockRejectedValueOnce(new Error('temporary native failure'))
      .mockResolvedValueOnce(true);
    registry.add(request({ respond }));

    await expect(registry.respond('permission-1', 'codemux-session-1', { approved: true })).rejects.toThrow('response failed');
    expect(registry.get('permission-1')).toBeDefined();
    await registry.respond('permission-1', 'codemux-session-1', { approved: true });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(registry.get('permission-1')).toBeUndefined();
  });

  it('updates an existing request by requestId without throwing', () => {
    const registry = new OpenCodePermissionRegistry();
    registry.add(request({ raw: { id: 'permission-1', type: 'read', title: 'old' } }));
    const updated = registry.upsert(request({ permissionType: 'write', description: 'new', metadata: { path: 'new.txt' }, raw: { id: 'permission-1', type: 'write', title: 'new' } }));

    expect(updated.updated).toBe(true);
    expect(registry.get('permission-1')).toMatchObject({ permissionType: 'write', description: 'new', metadata: { path: 'new.txt' }, raw: { id: 'permission-1', type: 'write', title: 'new' } });
  });

  it('does not restore an in-flight failed response after cancellation starts', async () => {
    const registry = new OpenCodePermissionRegistry();
    let rejectNative!: (error: Error) => void;
    const respond = vi.fn().mockImplementation(() => new Promise<boolean>((_, reject) => { rejectNative = reject; }));
    registry.add(request({ respond }));
    const response = registry.respond('permission-1', 'codemux-session-1', { approved: true });
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    const cancellation = registry.cancelAll('codemux-session-1');
    rejectNative(new Error('late native failure'));
    await cancellation;
    await expect(response).rejects.toThrow('response failed');
    expect(registry.size).toBe(0);
  });

  it('isolates cancellation generations between Session A and Session B', async () => {
    const registry = new OpenCodePermissionRegistry();
    let rejectA!: (error: Error) => void;
    let rejectB!: (error: Error) => void;
    const respondA = vi.fn().mockImplementation(() => new Promise<boolean>((_, reject) => { rejectA = reject; }));
    const respondB = vi.fn().mockImplementation(() => new Promise<boolean>((_, reject) => { rejectB = reject; }));
    registry.add(request({ requestId: 'permission-a', codeMuxSessionId: 'session-a', respond: respondA }));
    registry.add(request({ requestId: 'permission-b', codeMuxSessionId: 'session-b', respond: respondB }));

    const responseA = registry.respond('permission-a', 'session-a', { approved: true });
    const responseB = registry.respond('permission-b', 'session-b', { approved: true });
    await vi.waitFor(() => {
      expect(respondA).toHaveBeenCalledTimes(1);
      expect(respondB).toHaveBeenCalledTimes(1);
    });

    const cancellation = registry.cancelAll('session-a');
    rejectA(new Error('Session A late failure'));
    rejectB(new Error('Session B transient failure'));
    await cancellation;
    await expect(responseA).rejects.toThrow('response failed');
    await expect(responseB).rejects.toThrow('response failed');
    expect(registry.get('permission-a')).toBeUndefined();
    expect(registry.get('permission-b')).toBeDefined();
  });

  it('does not extend the absolute deadline after response failure', async () => {
    vi.useFakeTimers();
    try {
      const registry = new OpenCodePermissionRegistry({ timeoutMs: 100 });
      let rejectNative!: (error: Error) => void;
      const respond = vi.fn().mockImplementationOnce(() => new Promise<boolean>((_, reject) => { rejectNative = reject; })).mockResolvedValue(true);
      registry.add(request({ respond }));

      const response = registry.respond('permission-1', 'codemux-session-1', { approved: true });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
      rejectNative(new Error('temporary native failure'));
      await expect(response).rejects.toThrow('response failed');
      await vi.advanceTimersByTimeAsync(39);
      expect(respond).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(respond).toHaveBeenCalledTimes(2);
      expect(respond).toHaveBeenLastCalledWith('reject');
      expect(registry.get('permission-1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates responding metadata without creating a second native response', async () => {
    let resolveNative!: (value: boolean) => void;
    const respond = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { resolveNative = resolve; }));
    const registry = new OpenCodePermissionRegistry();
    registry.add(request({ respond }));

    const response = registry.respond('permission-1', 'codemux-session-1', { approved: true });
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    const updated = registry.upsert(request({ permissionType: 'write', description: 'Updated', metadata: { path: 'new.txt' }, raw: { id: 'permission-1', type: 'write', title: 'Updated' }, respond: vi.fn() }));
    expect(updated.updated).toBe(true);
    expect(registry.get('permission-1')).toMatchObject({ permissionType: 'write', description: 'Updated', metadata: { path: 'new.txt' } });
    resolveNative(true);
    await response;
    expect(respond).toHaveBeenCalledTimes(1);
    expect(registry.get('permission-1')).toBeUndefined();
  });

  it('reclaims request state and session generations after cancellation completes', async () => {
    const registry = new OpenCodePermissionRegistry();
    registry.add(request({ requestId: 'permission-a', codeMuxSessionId: 'session-a' }));
    registry.add(request({ requestId: 'permission-b', codeMuxSessionId: 'session-b' }));
    expect(registry.trackedSessionCount).toBe(2);

    await registry.cancelAll('session-a');
    expect(registry.size).toBe(1);
    expect(registry.trackedSessionCount).toBe(1);
    await registry.cancelAll('session-b');
    expect(registry.size).toBe(0);
    expect(registry.trackedSessionCount).toBe(0);
  });

  it('reports expired when responding after the absolute deadline', async () => {
    vi.useFakeTimers();
    try {
      const registry = new OpenCodePermissionRegistry({ timeoutMs: 100 });
      const respond = vi.fn().mockResolvedValue(true);
      registry.add(request({ respond }));
      vi.setSystemTime(Date.now() + 100);

      const error = await registry.respond('permission-1', 'codemux-session-1', { approved: true }).catch((cause) => cause);
      expect(error).toMatchObject({ code: 'expired' });
      expect(respond).toHaveBeenCalledWith('reject');
      expect(registry.get('permission-1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves an expired tombstone when the timer wins before respond', async () => {
    vi.useFakeTimers();
    try {
      const registry = new OpenCodePermissionRegistry({ timeoutMs: 25, expiredTombstoneTtlMs: 50 });
      const respond = vi.fn().mockResolvedValue(true);
      registry.add(request({ respond }));

      await vi.advanceTimersByTimeAsync(25);
      const error = await registry.respond('permission-1', 'codemux-session-1', { approved: true }).catch((cause) => cause);
      expect(error).toMatchObject({ code: 'expired' });
      expect(respond).toHaveBeenCalledWith('reject');
      expect(registry.get('permission-1')).toBeUndefined();
      expect(registry.expiredTombstoneCount).toBe(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(registry.expiredTombstoneCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not create an expired tombstone for active cancellation', async () => {
    const registry = new OpenCodePermissionRegistry({ expiredTombstoneTtlMs: 50 });
    registry.add(request());
    await registry.cancelAll('codemux-session-1');
    await expect(registry.respond('permission-1', 'codemux-session-1', { approved: true })).rejects.toMatchObject({ code: 'not_found' });
    expect(registry.expiredTombstoneCount).toBe(0);
  });

  it('bounds cancelAll when native reject hangs and ignores the late native settle', async () => {
    vi.useFakeTimers();
    try {
      let resolveNative!: (value: boolean) => void;
      const respond = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { resolveNative = resolve; }));
      const registry = new OpenCodePermissionRegistry({ nativeResponseTimeoutMs: 25 });
      registry.add(request({ respond }));

      const cancellation = registry.cancelAll('codemux-session-1');
      await vi.advanceTimersByTimeAsync(25);
      const results = await cancellation;
      expect(results[0]?.error).toMatchObject({ code: 'native_response_timeout' });
      expect(registry.size).toBe(0);
      expect(registry.trackedSessionCount).toBe(0);
      resolveNative(true);
      await Promise.resolve();
      expect(registry.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reactivate an expired request from same or changed replay payloads', async () => {
    vi.useFakeTimers();
    try {
      const registry = new OpenCodePermissionRegistry({ timeoutMs: 10, expiredTombstoneTtlMs: 100 });
      const respond = vi.fn().mockResolvedValue(true);
      registry.add(request({ respond, nativeRequestIdentity: 'native-event-1', nativePayloadFingerprint: 'payload-1' }));
      await vi.advanceTimersByTimeAsync(10);
      expect(registry.expiredTombstoneCount).toBe(1);

      const sameReplay = registry.upsert(request({ nativeRequestIdentity: 'native-event-1', nativePayloadFingerprint: 'payload-1', raw: { id: 'permission-1', type: 'read', replay: true } }));
      const changedReplay = registry.upsert(request({ nativeRequestIdentity: 'native-event-1', nativePayloadFingerprint: 'payload-2', raw: { id: 'permission-1', type: 'write', replay: true } }));
      expect(sameReplay.accepted).toBe(false);
      expect(changedReplay.accepted).toBe(false);
      expect(registry.size).toBe(0);

      const newRequest = registry.upsert(request({ nativeRequestIdentity: 'native-event-2', nativePayloadFingerprint: 'payload-3', raw: { id: 'permission-1', type: 'write', fresh: true } }));
      expect(newRequest.accepted).toBe(true);
      expect(registry.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a confirmed new native identity to replace an expired in-flight entry', async () => {
    vi.useFakeTimers();
    try {
      let resolveOldNative!: (value: boolean) => void;
      const respond = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { resolveOldNative = resolve; }));
      const registry = new OpenCodePermissionRegistry({ timeoutMs: 10, nativeResponseTimeoutMs: 1_000, expiredTombstoneTtlMs: 100 });
      registry.add(request({ respond, nativeRequestIdentity: 'native-event-1' }));
      await vi.advanceTimersByTimeAsync(10);

      const replacement = registry.upsert(request({ nativeRequestIdentity: 'native-event-2', raw: { id: 'permission-1', fresh: true } }));
      expect(replacement.accepted).toBe(true);
      expect(registry.get('permission-1')).toMatchObject({ raw: { id: 'permission-1', fresh: true }, state: 'pending' });
      resolveOldNative(true);
      await Promise.resolve();
      expect(registry.get('permission-1')).toMatchObject({ raw: { id: 'permission-1', fresh: true }, state: 'pending' });
    } finally {
      vi.useRealTimers();
    }
  });
});
