export interface CompanionConnection {
  baseUrl: string;
  token: string;
  deviceId?: string;
}

const DB_NAME = 'codemux-mobile';
const STORE_NAME = 'connection';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
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

export async function loadConnection(): Promise<CompanionConnection | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get('current');
    request.onsuccess = () => resolve((request.result as CompanionConnection | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function saveConnection(connection: CompanionConnection): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(connection, 'current');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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
