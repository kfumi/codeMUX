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
  deadline: number;
  state: 'pending' | 'responding' | 'cancelled';
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

interface PermissionEntry extends OpenCodePermissionRecord {
  respond: (response: OpenCodeNativePermissionResponse) => Promise<unknown>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  responsePromise?: Promise<unknown>;
  responseToken?: number;
  responseGeneration?: number;
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
  private readonly entries = new Map<string, PermissionEntry>();
  private readonly sessionGenerations = new Map<string, number>();
  private nextResponseToken = 0;

  constructor(options: OpenCodePermissionRegistryOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('OpenCode permission timeout must be a positive finite number');
    }
  }

  get size(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.state !== 'cancelled') count += 1;
    }
    return count;
  }

  get trackedSessionCount(): number {
    return this.sessionGenerations.size;
  }

  add(request: OpenCodePermissionRequest): OpenCodePermissionRecord {
    return this.upsert(request).record;
  }

  upsert(request: OpenCodePermissionRequest): OpenCodePermissionUpsertResult {
    const existing = this.entries.get(request.requestId);
    if (existing) {
      this.clearTimeout(existing);
      existing.permissionType = request.permissionType;
      existing.description = request.description;
      existing.metadata = request.metadata;
      existing.raw = request.raw;
      if (existing.state === 'pending') {
        const previousSessionId = existing.codeMuxSessionId;
        existing.openCodeSessionId = request.openCodeSessionId;
        existing.codeMuxSessionId = request.codeMuxSessionId;
        existing.respond = request.respond;
        this.ensureSessionGeneration(request.codeMuxSessionId);
        if (previousSessionId !== request.codeMuxSessionId) {
          this.reclaimSessionGeneration(previousSessionId);
        }
        this.scheduleTimeout(existing);
      } else {
        existing.respond = request.respond;
      }
      return { record: this.toRecord(existing), updated: true };
    }

    const now = Date.now();
    const entry: PermissionEntry = {
      requestId: request.requestId,
      openCodeSessionId: request.openCodeSessionId,
      codeMuxSessionId: request.codeMuxSessionId,
      permissionType: request.permissionType,
      description: request.description,
      metadata: request.metadata,
      raw: request.raw,
      createdAt: now,
      deadline: now + this.timeoutMs,
      state: 'pending',
      respond: request.respond,
    };
    this.entries.set(request.requestId, entry);
    this.ensureSessionGeneration(entry.codeMuxSessionId);
    this.scheduleTimeout(entry);
    return { record: this.toRecord(entry), updated: false };
  }

  get(requestId: string): OpenCodePermissionRecord | undefined {
    const entry = this.entries.get(requestId);
    return entry ? this.toRecord(entry) : undefined;
  }

  async respond(requestId: string, codeMuxSessionId: string, response: OpenCodePermissionResponse): Promise<void> {
    const nativeResponse = toNativeResponse(response);
    const entry = this.entries.get(requestId);
    if (!entry || entry.state !== 'pending') {
      throw new OpenCodePermissionError('not_found', `OpenCode permission request ${requestId} is no longer pending`);
    }
    if (entry.codeMuxSessionId !== codeMuxSessionId) {
      throw new OpenCodePermissionError('session_mismatch', `OpenCode permission request ${requestId} does not belong to session ${codeMuxSessionId}`);
    }
    if (Date.now() >= entry.deadline) {
      await this.expireEntry(entry);
      throw new OpenCodePermissionError('expired', `OpenCode permission request ${requestId} has expired`);
    }

    this.clearTimeout(entry);
    entry.state = 'responding';
    const responseToken = ++this.nextResponseToken;
    entry.responseToken = responseToken;
    entry.responseGeneration = this.getSessionGeneration(entry.codeMuxSessionId);
    const responder = entry.respond;
    const responsePromise = Promise.resolve().then(() => responder(nativeResponse));
    entry.responsePromise = responsePromise;
    try {
      await responsePromise;
      if (this.isCurrentResponse(entry, responseToken)) {
        this.removeEntry(entry);
      }
    } catch (error) {
      if (this.isCurrentResponse(entry, responseToken)) {
        if ((entry.state as PermissionEntry['state']) === 'cancelled' || this.getSessionGeneration(entry.codeMuxSessionId) !== (entry.responseGeneration ?? 0)) {
          this.removeEntry(entry);
        } else if (Date.now() >= entry.deadline) {
          this.removeEntry(entry);
          throw new OpenCodePermissionError('expired', `OpenCode permission request ${requestId} has expired`, { cause: error });
        } else {
          entry.state = 'pending';
          this.scheduleTimeout(entry);
        }
      }
      throw new OpenCodePermissionError('native_response_failed', `OpenCode permission request ${requestId} response failed`, { cause: error });
    } finally {
      if (entry.responsePromise === responsePromise) {
        entry.responsePromise = undefined;
      }
    }
  }

  async cancelAll(codeMuxSessionId?: string): Promise<OpenCodePermissionCancelResult[]> {
    const targets = [...this.entries.values()].filter((entry) => !codeMuxSessionId || entry.codeMuxSessionId === codeMuxSessionId);
    if (targets.length === 0) return [];

    const affectedSessions = new Set(targets.map((entry) => entry.codeMuxSessionId));
    for (const sessionId of affectedSessions) {
      this.sessionGenerations.set(sessionId, this.getSessionGeneration(sessionId) + 1);
    }
    return Promise.all(targets.map(async (entry) => {
      const error = await this.cancelEntry(entry);
      return error === undefined ? { requestId: entry.requestId } : { requestId: entry.requestId, error };
    }));
  }

  private async cancelEntry(entry: PermissionEntry): Promise<unknown> {
    if (this.entries.get(entry.requestId) !== entry) return undefined;
    if (entry.state === 'responding') {
      entry.state = 'cancelled';
      return this.awaitResponse(entry);
    }
    if (entry.state === 'cancelled') {
      return this.awaitResponse(entry);
    }
    return this.expireEntry(entry);
  }

  private async expireEntry(entry: PermissionEntry): Promise<unknown> {
    if (this.entries.get(entry.requestId) !== entry) return undefined;
    if (entry.state === 'responding') {
      entry.state = 'cancelled';
      return this.awaitResponse(entry);
    }
    if (entry.state === 'cancelled') {
      return this.awaitResponse(entry);
    }

    this.clearTimeout(entry);
    entry.state = 'cancelled';
    const rejectPromise = Promise.resolve().then(() => entry.respond('reject'));
    entry.responsePromise = rejectPromise;
    try {
      return await rejectPromise;
    } catch (error) {
      return error;
    } finally {
      if (this.entries.get(entry.requestId) === entry) {
        this.removeEntry(entry);
      }
    }
  }

  private async awaitResponse(entry: PermissionEntry): Promise<unknown> {
    if (!entry.responsePromise) {
      this.removeEntry(entry);
      return undefined;
    }
    try {
      await entry.responsePromise;
      return undefined;
    } catch (error) {
      return error;
    }
  }

  private scheduleTimeout(entry: PermissionEntry): void {
    const remainingMs = entry.deadline - Date.now();
    if (remainingMs <= 0) {
      void this.expireEntry(entry);
      return;
    }
    entry.timeoutHandle = setTimeout(() => {
      void this.expireEntry(entry);
    }, remainingMs);
    entry.timeoutHandle.unref?.();
  }

  private clearTimeout(entry: PermissionEntry): void {
    if (entry.timeoutHandle) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }
  }

  private removeEntry(entry: PermissionEntry): void {
    this.clearTimeout(entry);
    entry.state = 'cancelled';
    entry.responsePromise = undefined;
    if (this.entries.get(entry.requestId) === entry) {
      this.entries.delete(entry.requestId);
    }
    this.reclaimSessionGeneration(entry.codeMuxSessionId);
  }

  private ensureSessionGeneration(codeMuxSessionId: string): void {
    if (!this.sessionGenerations.has(codeMuxSessionId)) {
      this.sessionGenerations.set(codeMuxSessionId, 0);
    }
  }

  private reclaimSessionGeneration(codeMuxSessionId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.codeMuxSessionId === codeMuxSessionId) return;
    }
    this.sessionGenerations.delete(codeMuxSessionId);
  }

  private getSessionGeneration(codeMuxSessionId: string): number {
    return this.sessionGenerations.get(codeMuxSessionId) ?? 0;
  }

  private isCurrentResponse(entry: PermissionEntry, responseToken: number): boolean {
    return this.entries.get(entry.requestId) === entry && entry.responseToken === responseToken;
  }

  private toRecord(entry: PermissionEntry): OpenCodePermissionRecord {
    const { respond: _respond, timeoutHandle: _timeoutHandle, responsePromise: _responsePromise, responseToken: _responseToken, responseGeneration: _responseGeneration, ...record } = entry;
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
