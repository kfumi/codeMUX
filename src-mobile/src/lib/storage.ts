import type { CompanionConnectionProfile, LegacyCompanionConnection } from '@shared/lib/companion-connection';
import {
  migrateLegacyConnection,
  normalizeStoredConnection,
} from '@shared/lib/companion-connection';

export type CompanionConnection = CompanionConnectionProfile;

const DB_NAME = 'codemux-mobile';
const STORE_NAME = 'connection';
const DB_VERSION = 3;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadProfile(): Promise<CompanionConnectionProfile | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get('current');
    request.onsuccess = () => {
      const raw = request.result as LegacyCompanionConnection | CompanionConnectionProfile | undefined;
      resolve(raw ? normalizeStoredConnection(raw) : null);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveProfile(profile: CompanionConnectionProfile): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(profile, 'current');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadConnection(): Promise<CompanionConnectionProfile | null> {
  return loadProfile();
}

export async function saveConnection(
  connection: LegacyCompanionConnection | CompanionConnectionProfile,
): Promise<void> {
  await saveProfile(normalizeStoredConnection(connection));
}

export async function clearConnection(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete('current');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export { migrateLegacyConnection };

export interface CachedSessionList {
  updatedAt: string;
  sessions: Array<{
    id: string;
    title: string;
    agent_kind: string;
    updated_at: string;
  }>;
}

export async function cacheSessionList(payload: CachedSessionList): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(payload, 'sessions');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadCachedSessionList(): Promise<CachedSessionList | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get('sessions');
    request.onsuccess = () => resolve((request.result as CachedSessionList | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export const TIMELINE_CACHE_VERSION = 1;

export interface CachedSessionEvents {
  cacheVersion: number;
  updatedAt: string;
  lastSequence: number;
  events: unknown[];
}

function sessionEventsKey(sessionId: string): string {
  return `events:${sessionId}`;
}

export async function cacheSessionEvents(sessionId: string, payload: CachedSessionEvents): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(payload, sessionEventsKey(sessionId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadCachedSessionEvents(sessionId: string): Promise<CachedSessionEvents | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(sessionEventsKey(sessionId));
    request.onsuccess = () => resolve((request.result as CachedSessionEvents | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export function maxEventSequence(events: unknown[]): number {
  let max = -1;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const sequence = (event as { sequence?: unknown }).sequence;
    if (typeof sequence === 'number') {
      max = Math.max(max, sequence);
    }
  }
  return max;
}

export function minEventSequence(events: unknown[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const sequence = (event as { sequence?: unknown }).sequence;
    if (typeof sequence === 'number') {
      min = Math.min(min, sequence);
    }
  }
  return Number.isFinite(min) ? min : -1;
}
