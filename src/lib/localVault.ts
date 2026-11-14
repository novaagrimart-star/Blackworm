const DB_NAME = 'blackworm_idb_vault_v1';
const DB_VERSION = 1;
const STORE_COLLECTIONS = 'collections';
const STORE_PENDING = 'pending_sync';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function getDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_COLLECTIONS)) {
          db.createObjectStore(STORE_COLLECTIONS, { keyPath: 'collection' });
        }
        if (!db.objectStoreNames.contains(STORE_PENDING)) {
          db.createObjectStore(STORE_PENDING, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

export async function saveCollectionToVault(colName: string, map: Record<string, any>): Promise<void> {
  try {
    const db = await getDb();
    if (!db || !colName) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_COLLECTIONS, 'readwrite');
      const store = tx.objectStore(STORE_COLLECTIONS);
      store.put({ collection: colName, map, updatedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {}
}

export async function loadCollectionFromVault(colName: string): Promise<Record<string, any> | null> {
  try {
    const db = await getDb();
    if (!db || !colName) return null;
    return await new Promise<Record<string, any> | null>((resolve) => {
      const tx = db.transaction(STORE_COLLECTIONS, 'readonly');
      const store = tx.objectStore(STORE_COLLECTIONS);
      const req = store.get(colName);
      req.onsuccess = () => {
        const res = req.result;
        resolve(res && res.map && typeof res.map === 'object' ? res.map : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function savePendingQueueToVault(queue: any[]): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_PENDING, 'readwrite');
      const store = tx.objectStore(STORE_PENDING);
      store.clear();
      if (Array.isArray(queue)) {
        queue.forEach((item) => {
          if (item && item.collection && item.id) {
            store.put({
              ...item,
              key: `${item.collection}:::${item.id}`,
            });
          }
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {}
}

export async function loadPendingQueueFromVault(): Promise<any[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    return await new Promise<any[]>((resolve) => {
      const tx = db.transaction(STORE_PENDING, 'readonly');
      const store = tx.objectStore(STORE_PENDING);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = Array.isArray(req.result) ? req.result : [];
        resolve(rows);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

/**
 * Safely clears browser HTTP/SW caches while strictly preserving all offline data vaults,
 * pending sync queues, user session, branding, and locally entered sheets.
 */
export async function safeClearTransientCaches(): Promise<void> {
  try {
    if (typeof window === 'undefined') return;
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((name) => caches.delete(name)));
    }
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        await reg.unregister();
      }
    }
    // Clean only volatile/stale quota flags so fresh online re-sync can run
    try {
      localStorage.removeItem('blackworm_quota_blocked_until');
    } catch {}
  } catch {}
}
