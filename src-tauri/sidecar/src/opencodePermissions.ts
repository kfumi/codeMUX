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
  nativeRequestIdentity?: string;
  nativePayloadFingerprint?: string;
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
  expiredTombstoneTtlMs?: number;
  maxExpiredTombstones?: number;
  nativeResponseTimeoutMs?: number;
}

export interface OpenCodePermissionUpsertResult {
  record?: OpenCodePermissionRecord;
  updated: boolean;
  accepted: boolean;
}

interface PermissionEntry extends OpenCodePermissionRecord {
  respond: (response: OpenCodeNativePermissionResponse) => Promise<unknown>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  responsePromise?: Promise<NativeResponseOutcome>;
  responseToken?: number;
  responseGeneration?: number;
  nativeRequestIdentity?: string;
  nativePayloadFingerprint?: string;
}

interface ExpiredTombstone {
  expiresAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  nativeRequestIdentity?: string;
  nativePayloadFingerprint?: string;
}

type NativeResponseOutcome =
  | { ok: true }
  | { ok: false; timedOut: false; error: unknown }
  | { ok: false; timedOut: true };

export class OpenCodePermissionError extends Error {
  readonly code: 'not_found' | 'session_mismatch' | 'invalid_response' | 'expired' | 'native_response_failed' | 'native_response_timeout';

  constructor(code: OpenCodePermissionError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OpenCodePermissionError';
    this.code = code;
  }
}

export class OpenCodePermissionRegistry {
  private readonly timeoutMs: number;
  private readonly nativeResponseTimeoutMs: number;
  private readonly expiredTombstoneTtlMs: number;
  private readonly maxExpiredTombstones: number;
  private readonly entries = new Map<string, PermissionEntry>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly expiredTombstones = new Map<string, ExpiredTombstone>();
  private nextResponseToken = 0;

  constructor(options: OpenCodePermissionRegistryOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
    this.nativeResponseTimeoutMs = options.nativeResponseTimeoutMs ?? 30_000;
    this.expiredTombstoneTtlMs = options.expiredTombstoneTtlMs ?? Math.max(this.timeoutMs, 60_000);
    this.maxExpiredTombstones = options.maxExpiredTombstones ?? 1_024;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('OpenCode permission timeout must be a positive finite number');
    }
    if (!Number.isFinite(this.expiredTombstoneTtlMs) || this.expiredTombstoneTtlMs <= 0) {
      throw new RangeError('OpenCode expired permission tombstone TTL must be a positive finite number');
    }
    if (!Number.isFinite(this.nativeResponseTimeoutMs) || this.nativeResponseTimeoutMs <= 0) {
      throw new RangeError('OpenCode native permission response timeout must be a positive finite number');
    }
    if (!Number.isInteger(this.maxExpiredTombstones) || this.maxExpiredTombstones <= 0) {
      throw new RangeError('OpenCode expired permission tombstone limit must be a positive integer');
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

  get expiredTombstoneCount(): number {
    this.pruneExpiredTombstones();
    return this.expiredTombstones.size;
  }

  add(request: OpenCodePermissionRequest): OpenCodePermissionRecord {
    const result = this.upsert(request);
    if (!result.record) {
      throw new OpenCodePermissionError('expired', `OpenCode permission request ${request.requestId} has expired`);
    }
    return result.record;
  }

  upsert(request: OpenCodePermissionRequest): OpenCodePermissionUpsertResult {
    const tombstone = this.getExpiredTombstone(request.requestId);
    if (tombstone && !isNewNativeRequest(tombstone, request)) {
      return { updated: false, accepted: false };
    }
    if (tombstone) this.clearExpiredTombstone(request.requestId);
    let existing = this.entries.get(request.requestId);
    if (
      existing?.state === 'cancelled'
      && hasNewNativeRequest(
        existing.nativeRequestIdentity,
        existing.nativePayloadFingerprint,
        request.nativeRequestIdentity,
        request.nativePayloadFingerprint,
      )
    ) {
      this.removeEntry(existing);
      existing = undefined;
    }
    if (existing) {
      this.clearTimeout(existing);
      existing.permissionType = request.permissionType;
      existing.description = request.description;
      existing.metadata = request.metadata;
      existing.raw = request.raw;
      existing.nativeRequestIdentity = request.nativeRequestIdentity;
      existing.nativePayloadFingerprint = request.nativePayloadFingerprint;
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
      return { record: this.toRecord(existing), updated: true, accepted: true };
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
      nativeRequestIdentity: request.nativeRequestIdentity,
      nativePayloadFingerprint: request.nativePayloadFingerprint,
      createdAt: now,
      deadline: now + this.timeoutMs,
      state: 'pending',
      respond: request.respond,
    };
    this.entries.set(request.requestId, entry);
    this.ensureSessionGeneration(entry.codeMuxSessionId);
    this.scheduleTimeout(entry);
    return { record: this.toRecord(entry), updated: false, accepted: true };
  }

  get(requestId: string): OpenCodePermissionRecord | undefined {
    const entry = this.entries.get(requestId);
    return entry ? this.toRecord(entry) : undefined;
  }

  async respond(requestId: string, codeMuxSessionId: string, response: OpenCodePermissionResponse): Promise<void> {
    const nativeResponse = toNativeResponse(response);
    const entry = this.entries.get(requestId);
    if (this.getExpiredTombstone(requestId)) {
      throw new OpenCodePermissionError('expired', `OpenCode permission request ${requestId} has expired`);
    }
    if (!entry || entry.state !== 'pending') {
      throw new OpenCodePermissionError('not_found', `OpenCode permission request ${requestId} is no longer pending`);
    }
    if (entry.codeMuxSessionId !== codeMuxSessionId) {
      throw new OpenCodePermissionError('session_mismatch', `OpenCode permission request ${requestId} does not belong to session ${codeMuxSessionId}`);
    }
    if (Date.now() >= entry.deadline) {
      await this.expireEntry(entry, 'expired');
      throw new OpenCodePermissionError('expired', `OpenCode permission request ${requestId} has expired`);
    }

    this.clearTimeout(entry);
    entry.state = 'responding';
    const responseToken = ++this.nextResponseToken;
    entry.responseToken = responseToken;
    entry.responseGeneration = this.getSessionGeneration(entry.codeMuxSessionId);
    const responder = entry.respond;
    const responsePromise = this.runNativeResponse(responder, nativeResponse);
    entry.responsePromise = responsePromise;
    try {
      const outcome = await responsePromise;
      if (outcome.ok) {
        if (this.isCurrentResponse(entry, responseToken)) {
          this.removeEntry(entry);
        }
        return;
      }
      if (this.isCurrentResponse(entry, responseToken)) {
        if ((entry.state as PermissionEntry['state']) === 'cancelled' || this.getSessionGeneration(entry.codeMuxSessionId) !== (entry.responseGeneration ?? 0)) {
          this.removeEntry(entry);
        } else if (outcome.timedOut) {
          this.removeEntry(entry);
          throw this.nativeResponseTimeoutError(requestId);
        } else if (Date.now() >= entry.deadline) {
          this.rememberExpiredTombstone(entry);
          this.removeEntry(entry);
          throw new OpenCodePermissionError('expired', `OpenCode permission request ${requestId} has expired`, { cause: outcome.error });
        } else {
          entry.state = 'pending';
          this.scheduleTimeout(entry);
        }
      }
      if (outcome.timedOut) {
        throw this.nativeResponseTimeoutError(requestId);
      }
      throw new OpenCodePermissionError('native_response_failed', `OpenCode permission request ${requestId} response failed`, { cause: outcome.error });
    } finally {
      if (entry.responsePromise === responsePromise) {
        entry.responsePromise = undefined;
      }
    }
  }

  private async runNativeResponse(responder: (response: OpenCodeNativePermissionResponse) => Promise<unknown>, response: OpenCodeNativePermissionResponse): Promise<NativeResponseOutcome> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    return new Promise<NativeResponseOutcome>((resolve) => {
      const finish = (outcome: NativeResponseOutcome) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        resolve(outcome);
      };
      void Promise.resolve()
        .then(() => responder(response))
        .then(() => finish({ ok: true }), (error) => finish({ ok: false, timedOut: false, error }));
      timeoutHandle = setTimeout(() => finish({ ok: false, timedOut: true }), this.nativeResponseTimeoutMs);
      timeoutHandle.unref?.();
    });
  }

  private nativeResponseTimeoutError(requestId: string): OpenCodePermissionError {
    return new OpenCodePermissionError('native_response_timeout', `OpenCode permission request ${requestId} native response timed out`);
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
    return this.expireEntry(entry, 'cancelled');
  }

  private async expireEntry(entry: PermissionEntry, reason: 'expired' | 'cancelled' = 'cancelled'): Promise<unknown> {
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
    if (reason === 'expired') {
      this.rememberExpiredTombstone(entry);
    }
    const rejectPromise = this.runNativeResponse(entry.respond, 'reject');
    entry.responsePromise = rejectPromise;
    try {
      const outcome = await rejectPromise;
      if (outcome.ok) return undefined;
      if (outcome.timedOut) return this.nativeResponseTimeoutError(entry.requestId);
      return new OpenCodePermissionError('native_response_failed', `OpenCode permission request ${entry.requestId} rejection failed`, { cause: outcome.error });
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
      const outcome = await entry.responsePromise;
      if (outcome.ok) return undefined;
      if (outcome.timedOut) return this.nativeResponseTimeoutError(entry.requestId);
      return new OpenCodePermissionError('native_response_failed', `OpenCode permission request ${entry.requestId} response failed`, { cause: outcome.error });
    } catch (error) {
      return error;
    }
  }

  private scheduleTimeout(entry: PermissionEntry): void {
    const remainingMs = entry.deadline - Date.now();
    if (remainingMs <= 0) {
      void this.expireEntry(entry, 'expired');
      return;
    }
    entry.timeoutHandle = setTimeout(() => {
      void this.expireEntry(entry, 'expired');
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

  private rememberExpiredTombstone(entry: PermissionEntry): void {
    this.clearExpiredTombstone(entry.requestId);
    const tombstone: ExpiredTombstone = {
      expiresAt: Date.now() + this.expiredTombstoneTtlMs,
      nativeRequestIdentity: entry.nativeRequestIdentity,
      nativePayloadFingerprint: entry.nativePayloadFingerprint,
      timeoutHandle: setTimeout(() => {
        if (this.expiredTombstones.get(entry.requestId) === tombstone) {
          this.expiredTombstones.delete(entry.requestId);
        }
      }, this.expiredTombstoneTtlMs),
    };
    tombstone.timeoutHandle.unref?.();
    this.expiredTombstones.set(entry.requestId, tombstone);
    while (this.expiredTombstones.size > this.maxExpiredTombstones) {
      const oldestRequestId = this.expiredTombstones.keys().next().value;
      if (oldestRequestId === undefined) break;
      this.clearExpiredTombstone(oldestRequestId);
    }
  }

  private getExpiredTombstone(requestId: string): ExpiredTombstone | undefined {
    const tombstone = this.expiredTombstones.get(requestId);
    if (!tombstone) return undefined;
    if (tombstone.expiresAt <= Date.now()) {
      this.clearExpiredTombstone(requestId);
      return undefined;
    }
    return tombstone;
  }

  private clearExpiredTombstone(requestId: string): void {
    const tombstone = this.expiredTombstones.get(requestId);
    if (!tombstone) return;
    clearTimeout(tombstone.timeoutHandle);
    this.expiredTombstones.delete(requestId);
  }

  private pruneExpiredTombstones(): void {
    for (const [requestId, tombstone] of this.expiredTombstones) {
      if (tombstone.expiresAt <= Date.now()) {
        this.clearExpiredTombstone(requestId);
      }
    }
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
    const { respond: _respond, timeoutHandle: _timeoutHandle, responsePromise: _responsePromise, responseToken: _responseToken, responseGeneration: _responseGeneration, nativeRequestIdentity: _nativeRequestIdentity, nativePayloadFingerprint: _nativePayloadFingerprint, ...record } = entry;
    return record;
  }
}

function isNewNativeRequest(tombstone: ExpiredTombstone, request: OpenCodePermissionRequest): boolean {
  return hasNewNativeRequest(
    tombstone.nativeRequestIdentity,
    tombstone.nativePayloadFingerprint,
    request.nativeRequestIdentity,
    request.nativePayloadFingerprint,
  );
}

function hasNewNativeRequest(
  previousIdentity: string | undefined,
  previousFingerprint: string | undefined,
  nextIdentity: string | undefined,
  nextFingerprint: string | undefined,
): boolean {
  if (previousIdentity && nextIdentity) {
    return previousIdentity !== nextIdentity;
  }
  if (!nextIdentity) {
    return Boolean(nextFingerprint && nextFingerprint !== previousFingerprint);
  }
  return true;
}

function toNativeResponse(response: OpenCodePermissionResponse): OpenCodeNativePermissionResponse {
  if (response === 'once' || response === 'always' || response === 'reject') return response;
  if (typeof response === 'object' && response !== null && typeof response.approved === 'boolean') {
    if (!response.approved) return 'reject';
    return response.always ? 'always' : 'once';
  }
  throw new OpenCodePermissionError('invalid_response', 'OpenCode permission response must be once, always, reject, or an approval object');
}
