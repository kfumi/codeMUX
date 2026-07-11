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
      await expect(registry.respond('permission-1', 'codemux-session-1', { approved: true })).rejects.toThrow('no longer pending');
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
    await registry.cancelAll('codemux-session-1');
    rejectNative(new Error('late native failure'));
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

    await registry.cancelAll('session-a');
    rejectA(new Error('Session A late failure'));
    rejectB(new Error('Session B transient failure'));
    await expect(responseA).rejects.toThrow('response failed');
    await expect(responseB).rejects.toThrow('response failed');
    expect(registry.get('permission-a')).toBeUndefined();
    expect(registry.get('permission-b')).toBeDefined();
  });
});
