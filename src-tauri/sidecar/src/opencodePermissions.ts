export type OpenCodePermissionResponse =
  | 'once'
  | 'always'
  | 'reject'
  | { approved: boolean; always?: boolean };

export type OpenCodeNativePermissionResponse = 'once' | 'always' | 'reject';

export interface OpenCodePermissionRequest {
  requestId: string;
  openCodeSessionId?: string;
  codeMuxSessionId: string;
  permissionType: string;
  description?: string;
  metadata?: Record<string, unknown>;
  raw: unknown;
  respond: (response: OpenCodeNativePermissionResponse) => Promise<unknown>;
}

export interface OpenCodePermissionRecord {
  requestId: string;
  openCodeSessionId?: string;
  codeMuxSessionId: string;
  permissionType: string;
  description?: string;
  metadata?: Record<string, unknown>;
  raw: unknown;
  createdAt: number;
}

export interface OpenCodePermissionCancelResult {
  requestId: string;
  error?: unknown;
}

export interface OpenCodePermissionRegistryOptions {
  timeoutMs?: number;
}

export interface OpenCodePermissionUpsertResult {
  record: OpenCodePermissionRecord;
  updated: boolean;
}

interface PendingPermission extends OpenCodePermissionRecord {
  respond: (response: OpenCodeNativePermissionResponse) => Promise<unknown>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export class OpenCodePermissionError extends Error {
  readonly code: 'not_found' | 'session_mismatch' | 'invalid_response' | 'expired' | 'native_response_failed';

  constructor(code: OpenCodePermissionError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OpenCodePermissionError';
    this.code = code;
  }
}

export class OpenCodePermissionRegistry {
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly cancelled = new Set<string>();
  private readonly inFlight = new Map<string, { codeMuxSessionId: string; generation: number }>();
  private readonly cancellationGenerations = new Map<string, number>();

  constructor(options: OpenCodePermissionRegistryOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('OpenCode permission timeout must be a positive finite number');
    }
  }

  get size(): number {
    return this.pending.size;
  }

  add(request: OpenCodePermissionRequest): OpenCodePermissionRecord {
    return this.upsert(request).record;
  }

  upsert(request: OpenCodePermissionRequest): OpenCodePermissionUpsertResult {
    const existing = this.pending.get(request.requestId);
    this.cancelled.delete(request.requestId);
    if (existing) {
      this.remove(request.requestId);
      const pending: PendingPermission = {
        ...existing,
        openCodeSessionId: request.openCodeSessionId,
        codeMuxSessionId: request.codeMuxSessionId,
        permissionType: request.permissionType,
        description: request.description,
        metadata: request.metadata,
        raw: request.raw,
        respond: request.respond,
      };
      this.scheduleTimeout(pending);
      this.pending.set(request.requestId, pending);
      return { record: this.toRecord(pending), updated: true };
    }
    const pending: PendingPermission = {
      requestId: request.requestId,
      openCodeSessionId: request.openCodeSessionId,
      codeMuxSessionId: request.codeMuxSessionId,
      permissionType: request.permissionType,
      description: request.description,
      metadata: request.metadata,
      raw: request.raw,
      createdAt: Date.now(),
      respond: request.respond,
    };
    this.scheduleTimeout(pending);
    this.pending.set(request.requestId, pending);
    return { record: this.toRecord(pending), updated: false };
  }

  get(requestId: string): OpenCodePermissionRecord | undefined {
    const pending = this.pending.get(requestId);
    return pending ? this.toRecord(pending) : undefined;
  }

  async respond(requestId: string, codeMuxSessionId: string, response: OpenCodePermissionResponse): Promise<void> {
    const nativeResponse = toNativeResponse(response);
    const pending = this.takePending(requestId);
    const responseGeneration = this.getCancellationGeneration(pending.codeMuxSessionId);
    this.inFlight.set(requestId, { codeMuxSessionId: pending.codeMuxSessionId, generation: responseGeneration });
    if (pending.codeMuxSessionId !== codeMuxSessionId) {
      this.restorePending(pending);
      this.inFlight.delete(requestId);
      throw new OpenCodePermissionError('session_mismatch', `OpenCode permission request ${requestId} does not belong to session ${codeMuxSessionId}`);
    }
    try {
      await pending.respond(nativeResponse);
    } catch (error) {
      if (responseGeneration === this.getCancellationGeneration(pending.codeMuxSessionId) && !this.cancelled.has(requestId) && !this.pending.has(requestId)) {
        this.restorePending(pending);
      }
      this.inFlight.delete(requestId);
      throw new OpenCodePermissionError('native_response_failed', `OpenCode permission request ${requestId} response failed`, { cause: error });
    }
    this.inFlight.delete(requestId);
  }

  async cancelAll(codeMuxSessionId?: string): Promise<OpenCodePermissionCancelResult[]> {
    const affectedSessionIds = new Set<string>();
    if (codeMuxSessionId) {
      affectedSessionIds.add(codeMuxSessionId);
    } else {
      for (const pending of this.pending.values()) affectedSessionIds.add(pending.codeMuxSessionId);
      for (const request of this.inFlight.values()) affectedSessionIds.add(request.codeMuxSessionId);
    }
    for (const sessionId of affectedSessionIds) {
      this.cancellationGenerations.set(sessionId, this.getCancellationGeneration(sessionId) + 1);
    }
    const requests = [...this.pending.values()].filter((pending) => !codeMuxSessionId || pending.codeMuxSessionId === codeMuxSessionId);
    for (const pending of requests) {
      this.cancelled.add(pending.requestId);
      this.remove(pending.requestId);
    }
    for (const [requestId, request] of this.inFlight) {
      if (!codeMuxSessionId || request.codeMuxSessionId === codeMuxSessionId) {
        this.cancelled.add(requestId);
      }
    }
    return Promise.all(requests.map(async (pending) => {
      try {
        await pending.respond('reject');
        return { requestId: pending.requestId };
      } catch (error) {
        return { requestId: pending.requestId, error };
      }
    }));
  }

  private async expire(requestId: string): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.remove(requestId);
    try {
      await pending.respond('reject');
    } catch {
      // The registry is already cleared; a late native error cannot re-open it.
    }
  }

  private takePending(requestId: string): PendingPermission {
    const pending = this.pending.get(requestId);
    if (!pending) {
      throw new OpenCodePermissionError('not_found', `OpenCode permission request ${requestId} is no longer pending`);
    }
    this.remove(requestId);
    return pending;
  }

  private restorePending(pending: PendingPermission): void {
    if (!this.cancelled.has(pending.requestId) && !this.pending.has(pending.requestId)) {
      this.scheduleTimeout(pending);
      this.pending.set(pending.requestId, pending);
    }
  }

  private scheduleTimeout(pending: PendingPermission): void {
    pending.timeoutHandle = setTimeout(() => void this.expire(pending.requestId), this.timeoutMs);
    pending.timeoutHandle.unref?.();
  }

  private getCancellationGeneration(codeMuxSessionId: string): number {
    return this.cancellationGenerations.get(codeMuxSessionId) ?? 0;
  }

  private remove(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    this.pending.delete(requestId);
  }

  private toRecord(pending: PendingPermission): OpenCodePermissionRecord {
    const { respond: _respond, timeoutHandle: _timeoutHandle, ...record } = pending;
    return record;
  }
}

function toNativeResponse(response: OpenCodePermissionResponse): OpenCodeNativePermissionResponse {
  if (response === 'once' || response === 'always' || response === 'reject') return response;
  if (typeof response === 'object' && response !== null && typeof response.approved === 'boolean') {
    if (!response.approved) return 'reject';
    return response.always ? 'always' : 'once';
  }
  throw new OpenCodePermissionError('invalid_response', 'OpenCode permission response must be once, always, reject, or an approval object');
}
