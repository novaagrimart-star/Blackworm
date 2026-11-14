import { 
  collection, 
  doc, 
  setDoc, 
  addDoc, 
  getDocs, 
  deleteDoc, 
  updateDoc, 
  serverTimestamp 
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { UserProfile } from './auth';
import { toTitleCase } from './utils';
import {
  saveCollectionToVault,
  savePendingQueueToVault,
  loadPendingQueueFromVault,
} from './localVault';
import {
  pushToSecondary,
  pushBatchToSecondary,
  fetchSecondaryCollection,
  initSecondaryStream,
  isSecondaryBlocked,
} from './secondaryDb';

export interface AuditLogItem {
  id: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE' | 'BACKUP_EXPORT' | 'BACKUP_IMPORT';
  collection: string;
  recordId: string;
  recordSummary: string;
  performedByUid: string;
  performedByName: string;
  timestamp: string;
}

let quotaExceededUntil = (() => {
  try {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('blackworm_quota_blocked_until');
      if (stored) {
        const val = Number(stored);
        if (!isNaN(val) && val > Date.now()) return val;
      }
    }
  } catch {}
  return 0;
})();

export function isQuotaBlocked(): boolean {
  if (quotaExceededUntil <= 0) return false;
  if (Date.now() >= quotaExceededUntil) {
    quotaExceededUntil = 0;
    try {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('blackworm_quota_blocked_until');
      }
    } catch {}
    return false;
  }
  return true;
}

export function setQuotaBlocked(durationMs: number = 10 * 60 * 1000) {
  if (durationMs <= 0) {
    quotaExceededUntil = 0;
    try {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('blackworm_quota_blocked_until');
      }
    } catch {}
    return;
  }
  quotaExceededUntil = Date.now() + durationMs;
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem('blackworm_quota_blocked_until', String(quotaExceededUntil));
    }
  } catch {}
}

export function trackFirestoreUsage(type: 'read' | 'write', count = 1): void {
  try {
    if (typeof window === 'undefined' || count <= 0) return;
    const today = getLocalDateStr();
    const key = 'blackworm_usage_metrics';
    const raw = localStorage.getItem(key);
    const current = raw ? JSON.parse(raw) : { date: today, reads: 0, writes: 0 };
    const next =
      current && current.date === today
        ? {
            date: today,
            reads: (Number(current.reads) || 0) + (type === 'read' ? count : 0),
            writes: (Number(current.writes) || 0) + (type === 'write' ? count : 0),
          }
        : {
            date: today,
            reads: type === 'read' ? count : 0,
            writes: type === 'write' ? count : 0,
          };
    localStorage.setItem(key, JSON.stringify(next));
  } catch {}
}

export function getDailyUsageStats(): { date: string; reads: number; writes: number } {
  const today = getLocalDateStr();
  try {
    if (typeof window === 'undefined') return { date: today, reads: 0, writes: 0 };
    const raw = localStorage.getItem('blackworm_usage_metrics');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.date === today) {
        return {
          date: today,
          reads: Number(parsed.reads) || 0,
          writes: Number(parsed.writes) || 0,
        };
      }
    }
  } catch {}
  return { date: today, reads: 0, writes: 0 };
}

export function stripUndefined<T>(val: T): T {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) {
    return val.map((v) => stripUndefined(v)) as unknown as T;
  }
  if (typeof val === 'object' && Object.prototype.toString.call(val) === '[object Object]') {
    const out: Record<string, any> = {};
    Object.entries(val as Record<string, any>).forEach(([k, v]) => {
      if (v !== undefined) {
        out[k] = stripUndefined(v);
      }
    });
    return out as T;
  }
  return val;
}

function emitSyncStatusEvent(): void {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('blackworm_sync_status', {
          detail: { pendingCount: getPendingSyncCount(), timestamp: Date.now() },
        })
      );
    }
  } catch {}
}

export function getPendingSyncIdSet(colName: string): Set<string> {
  const ids = new Set<string>();
  try {
    if (typeof window === 'undefined') return ids;
    const queueRaw = localStorage.getItem('blackworm_pending_sync');
    if (!queueRaw) return ids;
    const queue: any[] = JSON.parse(queueRaw);
    if (Array.isArray(queue)) {
      queue.forEach((q) => {
        if (q && q.collection === colName && q.id) {
          ids.add(String(q.id));
        }
      });
    }
  } catch {}
  return ids;
}

export function safeLocalStorageSet(key: string, value: string): boolean {
  try {
    if (typeof window === 'undefined') return false;
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn(`LocalStorage write notice for ${key}:`, e);
    return false;
  }
}

/**
 * Safely converts any Firestore Timestamp, {seconds, nanoseconds}, Date, number, or ISO string to epoch milliseconds.
 * Never returns NaN (returns 0 on invalid/missing input).
 */
export function toTimestampMs(val: any): number {
  if (!val) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (val instanceof Date) {
    const t = val.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  if (typeof val?.toMillis === 'function') {
    try {
      const t = val.toMillis();
      return Number.isFinite(t) ? t : 0;
    } catch {}
  }
  if (typeof val?.toDate === 'function') {
    try {
      const t = val.toDate().getTime();
      return Number.isFinite(t) ? t : 0;
    } catch {}
  }
  if (typeof val === 'object' && typeof val.seconds === 'number') {
    return val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6);
  }
  if (typeof val === 'string') {
    const t = Date.parse(val);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

export function formatDisplayDate(val: any, includeTime = false): string {
  const ms = toTimestampMs(val);
  if (!ms) return '';
  const d = new Date(ms);
  return includeTime ? d.toLocaleString('en-IN') : d.toLocaleDateString('en-IN');
}

/**
 * Returns local calendar date as YYYY-MM-DD (avoids UTC toISOString() off-by-one between 00:00 and 05:30 IST).
 */
export function getLocalDateStr(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Reliably triggers a Blob file download across desktop & mobile browsers by appending the anchor and deferring revokeObjectURL.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    try {
      if (link.parentNode) link.parentNode.removeChild(link);
    } catch {}
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }, 2000);
}

/**
 * Updates the persistent local cache for a collection so that incoming Firestore records
 * are immediately preserved locally on this device, preventing any data disappearance across logins.
 */
export function updateCollectionCache<T extends { id: string }>(colName: string, items: T[]): void {
  try {
    if (typeof window === 'undefined' || !items || items.length === 0) return;
    const storageKey = `blackworm_local_${colName}`;
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    const existing: Record<string, any> = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const pendingIds = getPendingSyncIdSet(colName);

    items.forEach((it: any) => {
      if (!it || !it.id) return;
      if (it.isArchived) {
        if (!pendingIds.has(it.id)) {
          delete existing[it.id];
        }
        return;
      }

      const prev = existing[it.id];
      if (!prev) {
        existing[it.id] = it;
        return;
      }

      // If this document has a genuine unsynced offline write pending, only let server win if server is newer
      if (pendingIds.has(it.id)) {
        const prevTime = toTimestampMs(prev._localSavedAt || prev.updatedAt || prev.createdAt);
        const nextTime = toTimestampMs(it.updatedAt || it.createdAt);
        if (nextTime <= prevTime) {
          return;
        }
      }

      // Otherwise, server snapshot is authoritative — clean up any stale _localSavedAt marker
      const merged = { ...prev, ...it };
      delete merged._localSavedAt;
      existing[it.id] = merged;
    });

    safeLocalStorageSet(storageKey, JSON.stringify(existing));
    void saveCollectionToVault(colName, existing);
  } catch (e) {
    console.warn(`Cache update notice for ${colName}:`, e);
  }
}

export function removeFromCollectionCache(colName: string, docId: string): void {
  try {
    if (typeof window === 'undefined' || !docId) return;
    const storageKey = `blackworm_local_${colName}`;
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const map = JSON.parse(raw);
      if (map && typeof map === 'object' && docId in map) {
        delete map[docId];
        localStorage.setItem(storageKey, JSON.stringify(map));
      }
    }
    if (colName === 'dealers_application') {
      const allRaw = localStorage.getItem('blackworm_all_dealers');
      if (allRaw) {
        const list = JSON.parse(allRaw);
        if (Array.isArray(list)) {
          localStorage.setItem('blackworm_all_dealers', JSON.stringify(list.filter((d: any) => d?.id !== docId)));
        }
      }
    } else if (colName === 'users') {
      const cachedUsersRaw = localStorage.getItem('blackworm_cached_users');
      if (cachedUsersRaw) {
        const list = JSON.parse(cachedUsersRaw);
        if (Array.isArray(list)) {
          localStorage.setItem('blackworm_cached_users', JSON.stringify(list.filter((u: any) => u?.uid !== docId && u?.id !== docId)));
        }
      }
    } else if (colName === 'outstanding_records') {
      const savedOutRaw = localStorage.getItem('blackworm_saved_outstanding_records');
      if (savedOutRaw) {
        const list = JSON.parse(savedOutRaw);
        if (Array.isArray(list)) {
          localStorage.setItem('blackworm_saved_outstanding_records', JSON.stringify(list.filter((r: any) => r?.id !== docId)));
        }
      }
    }
  } catch (e) {
    console.warn(`Cache removal notice for ${colName}/${docId}:`, e);
  }
}

/**
 * Saves document into persistent local collection cache (LocalStorage + IndexedDB vault)
 */
function writeLocalCollectionRecord(colName: string, docId: string, data: Record<string, any>, merge = true, markPending = true) {
  try {
    if (typeof window === 'undefined' || !colName || !docId) return;
    const storageKey = `blackworm_local_${colName}`;
    const raw = localStorage.getItem(storageKey);
    const map = raw ? JSON.parse(raw) : {};
    const prev = map[docId] && typeof map[docId] === 'object' ? map[docId] : {};
    const nextDoc: Record<string, any> = {
      ...(merge ? prev : {}),
      ...data,
      id: docId,
    };
    if (markPending) {
      nextDoc._localSavedAt = new Date().toISOString();
    } else {
      delete nextDoc._localSavedAt;
    }
    map[docId] = nextDoc;
    safeLocalStorageSet(storageKey, JSON.stringify(map));
    void saveCollectionToVault(colName, map);
  } catch (e) {
    console.warn(`Local caching notice for ${colName}/${docId}:`, e);
  }
}

function clearLocalSavedMarker(colName: string, docId: string) {
  try {
    if (typeof window === 'undefined' || !colName || !docId) return;
    const storageKey = `blackworm_local_${colName}`;
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const map = JSON.parse(raw);
      if (map[docId] && map[docId]._localSavedAt) {
        delete map[docId]._localSavedAt;
        safeLocalStorageSet(storageKey, JSON.stringify(map));
        void saveCollectionToVault(colName, map);
      }
    }
  } catch {}
}

function isQuotaErrorMsg(rawMsg: string): boolean {
  const lower = (rawMsg || '').toLowerCase();
  return (
    lower.includes('quota') ||
    lower.includes('resource_exhausted') ||
    lower.includes('resource-exhausted')
  );
}

/**
 * Safely deletes or soft-deletes a record across Primary (Firestore), Secondary DB, Local Vault,
 * and pending sync queue so deleted items never resurrect across refreshes or quota limits.
 */
export async function safeFirestoreDelete(
  colName: string,
  docId: string,
  options: { softDelete?: boolean; user?: UserProfile } = {}
): Promise<{ success: boolean; error?: string }> {
  removeFromCollectionCache(colName, docId);
  removeFromPendingSync(colName, docId);

  const nowIso = new Date().toISOString();
  const archivePayload = {
    isArchived: true,
    archivedAt: nowIso,
    updatedAt: nowIso,
    ...(options.user?.uid ? { archivedBy: options.user.uid } : {}),
  };

  const isCurrentlyOffline = typeof navigator !== 'undefined' && !navigator.onLine;
  if (isCurrentlyOffline) {
    setPendingSyncItem(colName, docId, archivePayload, { merge: true }, {
      needsFirebase: true,
      needsSecondary: true,
      deleted: true,
    });
    return { success: true };
  }

  let needsFirebase = true;
  let needsSecondary = true;
  let lastErrMsg = '';

  const firebaseTask = async () => {
    if (isQuotaBlocked()) return;
    try {
      if (options.softDelete) {
        await setDoc(doc(db, colName, docId), archivePayload, { merge: true });
      } else {
        try {
          await deleteDoc(doc(db, colName, docId));
        } catch (hardDelErr: any) {
          const msg = String(hardDelErr?.message || '').toLowerCase();
          if (msg.includes('permission') || msg.includes('denied')) {
            await setDoc(doc(db, colName, docId), archivePayload, { merge: true });
          } else {
            throw hardDelErr;
          }
        }
      }
      trackFirestoreUsage('write', 1);
      needsFirebase = false;
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      lastErrMsg = msg;
      if (isQuotaErrorMsg(msg)) setQuotaBlocked(15 * 60 * 1000);
    }
  };

  const secondaryTask = async () => {
    const secRes = await pushToSecondary({
      collection: colName,
      id: docId,
      doc: archivePayload,
      updatedAtMs: Date.now(),
      deleted: true,
      merge: true,
    });
    if (secRes.ok) {
      needsSecondary = false;
    }
  };

  await Promise.all([firebaseTask(), secondaryTask()]);

  if (needsFirebase || needsSecondary) {
    setPendingSyncItem(colName, docId, archivePayload, { merge: true }, {
      needsFirebase,
      needsSecondary,
      deleted: true,
    });
  }

  // Success if at least one remote tier or softDelete-queue absorbed it safely
  return {
    success: !needsFirebase || !needsSecondary || Boolean(options.softDelete),
    ...(lastErrMsg && needsFirebase && needsSecondary ? { error: lastErrMsg } : {}),
  };
}

/**
 * 3-Tier Automatic Dual-DB Write Helper:
 * 1. Immediately writes to Local Vault (LocalStorage + IndexedDB) for instant zero-latency UI
 * 2. Mirrors in parallel to Primary (Firebase Firestore) and Secondary (SQLite WAL + Real-Time SSE + optional Supabase)
 * 3. If Firebase quota is exhausted or offline, Secondary continues live cross-device sync automatically;
 *    if BOTH remote DBs are unreachable, retains item safely in IndexedDB/LocalStorage dual-queue and replays automatically.
 */
export async function safeFirestoreSet<T extends Record<string, any>>(
  colName: string,
  docId: string,
  data: T,
  options: { merge?: boolean } = { merge: true },
  retryCount = 0
): Promise<{ success: boolean; isCachedLocally: boolean; syncedTier?: 'both' | 'primary' | 'secondary' | 'local'; error?: string }> {
  const nowIso = new Date().toISOString();
  const cleanData = stripUndefined({
    ...data,
    id: docId,
    updatedAt: data.updatedAt || nowIso,
  });

  // 1. Immediate Local Vault save
  writeLocalCollectionRecord(colName, docId, cleanData, options.merge !== false, true);

  const isCurrentlyOffline = typeof navigator !== 'undefined' && !navigator.onLine;
  if (isCurrentlyOffline) {
    setPendingSyncItem(colName, docId, cleanData, options, {
      needsFirebase: true,
      needsSecondary: true,
    });
    return { success: true, isCachedLocally: true, syncedTier: 'local' };
  }

  let needsFirebase = true;
  let needsSecondary = true;
  let firebaseError = '';

  const writePrimary = async (attempt = retryCount): Promise<void> => {
    if (isQuotaBlocked()) return;
    try {
      await setDoc(doc(db, colName, docId), cleanData, options);
      trackFirestoreUsage('write', 1);
      needsFirebase = false;
    } catch (err: any) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      firebaseError = rawMsg;
      if (isQuotaErrorMsg(rawMsg)) {
        setQuotaBlocked(15 * 60 * 1000);
        return;
      }
      const lower = rawMsg.toLowerCase();
      const isNetworkError =
        lower.includes('network') || lower.includes('unavailable') || lower.includes('offline');
      if (isNetworkError && attempt < 2) {
        const delay = Math.pow(2, attempt) * 600;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return writePrimary(attempt + 1);
      }
    }
  };

  const writeSecondary = async (): Promise<void> => {
    const secRes = await pushToSecondary({
      collection: colName,
      id: docId,
      doc: cleanData,
      updatedAtMs: toTimestampMs(cleanData.updatedAt) || Date.now(),
      deleted: Boolean(cleanData.isArchived),
      merge: options.merge !== false,
    });
    if (secRes.ok) {
      needsSecondary = false;
    }
  };

  await Promise.all([writePrimary(), writeSecondary()]);

  if (needsFirebase || needsSecondary) {
    setPendingSyncItem(colName, docId, cleanData, options, {
      needsFirebase,
      needsSecondary,
      deleted: Boolean(cleanData.isArchived),
    });
  } else {
    removeFromPendingSync(colName, docId);
    clearLocalSavedMarker(colName, docId);
  }

  const bothFailed = needsFirebase && needsSecondary;
  const syncedTier =
    !needsFirebase && !needsSecondary
      ? 'both'
      : !needsFirebase
        ? 'primary'
        : !needsSecondary
          ? 'secondary'
          : 'local';

  if (bothFailed && firebaseError) {
    console.warn(`Both DBs queued locally (${colName}/${docId}):`, firebaseError);
  }

  return {
    success: true,
    isCachedLocally: bothFailed,
    syncedTier,
    ...(bothFailed && firebaseError ? { error: firebaseError } : {}),
  };
}

function persistPendingQueue(queue: any[]) {
  try {
    if (typeof window === 'undefined') return;
    const qKey = 'blackworm_pending_sync';
    const trimmed = queue.slice(-500);
    safeLocalStorageSet(qKey, JSON.stringify(trimmed));
    void savePendingQueueToVault(queue);
    emitSyncStatusEvent();
  } catch {}
}

function setPendingSyncItem(
  colName: string,
  docId: string,
  data: any,
  options: any,
  flags: { needsFirebase?: boolean; needsSecondary?: boolean; deleted?: boolean } = {}
) {
  try {
    if (typeof window === 'undefined') return;
    const qKey = 'blackworm_pending_sync';
    const queueRaw = localStorage.getItem(qKey);
    const queue: any[] = queueRaw ? JSON.parse(queueRaw) : [];
    const idx = queue.findIndex((q) => q && q.collection === colName && q.id === docId);

    const needsFirebase = flags.needsFirebase !== undefined ? flags.needsFirebase : true;
    const needsSecondary = flags.needsSecondary !== undefined ? flags.needsSecondary : true;

    if (!needsFirebase && !needsSecondary) {
      if (idx >= 0) {
        queue.splice(idx, 1);
        persistPendingQueue(queue);
      }
      return;
    }

    const item = {
      collection: colName,
      id: docId,
      data: stripUndefined(data),
      options: options || { merge: true },
      timestamp: Date.now(),
      needsFirebase,
      needsSecondary,
      deleted: Boolean(flags.deleted || data?.isArchived),
    };

    if (idx >= 0) queue[idx] = item;
    else queue.push(item);

    persistPendingQueue(queue);
  } catch {}
}

function addToPendingSync(colName: string, docId: string, data: any, options: any) {
  setPendingSyncItem(colName, docId, data, options, { needsFirebase: true, needsSecondary: true });
}

function removeFromPendingSync(colName: string, docId: string) {
  try {
    if (typeof window !== 'undefined') {
      const qKey = 'blackworm_pending_sync';
      const queueRaw = localStorage.getItem(qKey);
      if (!queueRaw) return;
      const queue: any[] = JSON.parse(queueRaw);
      const filtered = queue.filter((q) => !(q && q.collection === colName && q.id === docId));
      if (filtered.length !== queue.length) {
        persistPendingQueue(filtered);
      }
    }
  } catch {}
}

/**
 * Background worker that drains pending operations to both Primary (Firebase) and Secondary DB
 * independently whenever each service or internet becomes available.
 */
let isSyncing = false;
let syncStarted = false;

export async function startBackgroundSync() {
  if (typeof window === 'undefined') return;
  initSecondaryStream();

  const processQueue = async () => {
    if (isSyncing) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    const qKey = 'blackworm_pending_sync';
    let queue: any[] = [];
    try {
      const queueRaw = localStorage.getItem(qKey);
      if (queueRaw) queue = JSON.parse(queueRaw);
      if (!Array.isArray(queue) || queue.length === 0) {
        const vaultQueue = await loadPendingQueueFromVault();
        if (Array.isArray(vaultQueue) && vaultQueue.length > 0) {
          queue = vaultQueue;
        }
      }
    } catch {
      localStorage.removeItem(qKey);
      return;
    }

    if (!Array.isArray(queue) || queue.length === 0) return;

    const firebaseUp = !isQuotaBlocked();
    const secondaryUp = !isSecondaryBlocked();
    if (!firebaseUp && !secondaryUp) return;

    isSyncing = true;
    try {
      const remaining: any[] = [];
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        if (!item || !item.collection || !item.id) continue;

        let needsFb = item.needsFirebase !== false;
        let needsSec = item.needsSecondary !== false;
        let dropItem = false;

        // 1. Primary (Firebase) replay
        if (needsFb && !isQuotaBlocked()) {
          try {
            const payload = stripUndefined(item.data || {});
            await setDoc(doc(db, item.collection, item.id), payload, item.options || { merge: true });
            trackFirestoreUsage('write', 1);
            needsFb = false;
          } catch (err: any) {
            const rawMsg = err instanceof Error ? err.message : String(err);
            const lower = rawMsg.toLowerCase();
            if (isQuotaErrorMsg(rawMsg)) {
              setQuotaBlocked(30 * 60 * 1000);
            } else if (
              lower.includes('invalid-argument') ||
              lower.includes('unsupported field value') ||
              lower.includes('exceeds the maximum allowed size')
            ) {
              console.warn(`Dropped invalid queued Firebase sync item (${item.collection}/${item.id}):`, rawMsg);
              dropItem = true;
            }
          }
        }

        // 2. Secondary DB replay
        if (!dropItem && needsSec && !isSecondaryBlocked()) {
          const secRes = await pushToSecondary({
            collection: item.collection,
            id: item.id,
            doc: stripUndefined(item.data || {}),
            updatedAtMs: item.timestamp || Date.now(),
            deleted: Boolean(item.deleted || item.data?.isArchived),
            merge: item.options?.merge !== false,
          });
          if (secRes.ok) {
            needsSec = false;
          }
        }

        if (!dropItem && (needsFb || needsSec)) {
          remaining.push({
            ...item,
            needsFirebase: needsFb,
            needsSecondary: needsSec,
          });
        } else if (!needsFb && !needsSec) {
          clearLocalSavedMarker(item.collection, item.id);
        }
      }

      persistPendingQueue(remaining);
    } catch (e) {
      console.error('Background sync error:', e);
    } finally {
      isSyncing = false;
    }
  };

  await processQueue();

  if (!syncStarted) {
    syncStarted = true;
    window.addEventListener('online', () => {
      initSecondaryStream();
      void processQueue();
    });
    window.addEventListener('focus', () => {
      void processQueue();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void processQueue();
      }
    });
    setInterval(() => {
      void processQueue();
    }, 60000);
  }
}

/**
 * 3-Tier update helper with automatic Secondary DB failover & offline queue
 */
export async function safeFirestoreUpdate(
  colName: string,
  docId: string,
  data: any,
  retryCount = 0
): Promise<{ success: boolean; isCachedLocally?: boolean; error?: string }> {
  const nowIso = new Date().toISOString();
  const cleanData = stripUndefined({
    ...data,
    updatedAt: nowIso,
  });

  writeLocalCollectionRecord(colName, docId, cleanData, true, true);

  const isCurrentlyOffline = typeof navigator !== 'undefined' && !navigator.onLine;
  if (isCurrentlyOffline) {
    setPendingSyncItem(colName, docId, cleanData, { merge: true }, {
      needsFirebase: true,
      needsSecondary: true,
    });
    return { success: true, isCachedLocally: true };
  }

  let needsFirebase = true;
  let needsSecondary = true;
  let firebaseError = '';

  const updatePrimary = async (attempt = retryCount): Promise<void> => {
    if (isQuotaBlocked()) return;
    try {
      await updateDoc(doc(db, colName, docId), cleanData);
      trackFirestoreUsage('write', 1);
      needsFirebase = false;
    } catch (err: any) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      firebaseError = rawMsg;
      if (isQuotaErrorMsg(rawMsg)) {
        setQuotaBlocked(15 * 60 * 1000);
        return;
      }
      const lower = rawMsg.toLowerCase();
      if (lower.includes('no document to update') || lower.includes('not-found')) {
        try {
          await setDoc(doc(db, colName, docId), { ...cleanData, id: docId }, { merge: true });
          trackFirestoreUsage('write', 1);
          needsFirebase = false;
          return;
        } catch {}
      }
      const isNetworkError =
        lower.includes('network') || lower.includes('unavailable') || lower.includes('offline');
      if (isNetworkError && attempt < 2) {
        const delay = Math.pow(2, attempt) * 600;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return updatePrimary(attempt + 1);
      }
    }
  };

  const updateSecondary = async (): Promise<void> => {
    const secRes = await pushToSecondary({
      collection: colName,
      id: docId,
      doc: cleanData,
      updatedAtMs: Date.now(),
      merge: true,
    });
    if (secRes.ok) {
      needsSecondary = false;
    }
  };

  await Promise.all([updatePrimary(), updateSecondary()]);

  if (needsFirebase || needsSecondary) {
    setPendingSyncItem(colName, docId, cleanData, { merge: true }, {
      needsFirebase,
      needsSecondary,
    });
  } else {
    removeFromPendingSync(colName, docId);
    clearLocalSavedMarker(colName, docId);
  }

  const bothFailed = needsFirebase && needsSecondary;
  return {
    success: !bothFailed || true,
    isCachedLocally: bothFailed,
    ...(bothFailed && firebaseError ? { error: firebaseError } : {}),
  };
}

/**
 * 3-Tier add helper generating a deterministic unique ID when Primary is unavailable
 * so Secondary DB and subsequent Firebase sync share the exact same ID without duplicates.
 */
export async function safeFirestoreAdd(
  colName: string,
  data: any,
  retryCount = 0
): Promise<{ success: boolean; id?: string; error?: string }> {
  const nowIso = new Date().toISOString();
  const cleanData = stripUndefined({
    ...data,
    createdAt: data?.createdAt || nowIso,
    updatedAt: data?.updatedAt || nowIso,
  });

  // Always allocate a deterministic ID upfront when offline/quota-blocked, or write via Firebase doc() ref
  const generatedId =
    cleanData.id && typeof cleanData.id === 'string' && !cleanData.id.startsWith('temp_')
      ? cleanData.id
      : doc(collection(db, colName)).id;

  const docWithId = { ...cleanData, id: generatedId };
  const res = await safeFirestoreSet(colName, generatedId, docWithId, { merge: true }, retryCount);
  return {
    success: res.success,
    id: generatedId,
    ...(res.error ? { error: res.error } : {}),
  };
}

export function getPendingSyncCount(): number {
  try {
    if (typeof window === 'undefined') return 0;
    const qKey = 'blackworm_pending_sync';
    const queueRaw = localStorage.getItem(qKey);
    if (!queueRaw) return 0;
    const queue: any[] = JSON.parse(queueRaw);
    if (!Array.isArray(queue)) return 0;
    return queue.filter((q) => q && (q.needsFirebase !== false || q.needsSecondary !== false)).length;
  } catch {
    return 0;
  }
}

/**
 * Safe Firestore query helper that handles network errors and quota limits gracefully.
 */
export async function safeFirestoreQuery<T>(
  queryFn: () => Promise<T>,
  fallbackValue: T,
  retryCount = 0
): Promise<T> {
  try {
    return await queryFn();
  } catch (err: any) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const isNetworkError = rawMsg.toLowerCase().includes('network') || rawMsg.toLowerCase().includes('unavailable') || rawMsg.toLowerCase().includes('offline');
    
    if (isNetworkError && retryCount < 2) {
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return safeFirestoreQuery(queryFn, fallbackValue, retryCount + 1);
    }
    
    console.warn(`Firestore query failed: ${rawMsg}. Using fallback.`);
    return fallbackValue;
  }
}

/**
 * Normalizes string for deduplication (removes symbols, extra spaces, accents, registered trademarks)
 */
export function normalizeKey(s: any): string {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[®™]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Normalizes packing size strings to standard canonical formats:
 * e.g. "1 Kg * 25 Nos", "1 Kg x 25", "1Kg", "1000 gm" -> "1 Kg"
 * "2.5 Kg * 8 Nos", "2.5Kg", "2500 gm" -> "2.5 Kg"
 * "25 Kg HDPE Bag", "25Kg" -> "25 Kg"
 */
export function normalizePackingSize(raw: any): string {
  if (!raw) return '1 Kg';
  const s = String(raw).toLowerCase().replace(/\s+/g, ' ').trim();
  const hasBucket = /\bbucket\b/i.test(s);

  // Strip piece-count multipliers (e.g. "* 25 Nos", "* 8 Nos", ".*20 Nos", "* 4 Ns", "* 20 N0s", "* 1 No.")
  // BEFORE extracting container weight/volume so "1Kg * 25 Nos" never gets misread as "25 Kg".
  const base = s
    .replace(/\s*\.?\s*[\*x×]\s*\d+\s*n[o0]?s?\.?/gi, '')
    .replace(/\s*\.?\s*[\*x×]\s*\d+\s*pcs?\.?/gi, '')
    .trim();

  if (/(?:^|[^\d.])10(?:\.0)?\s*(ltr|litre|l\b)/.test(base)) {
    return '10 Ltr';
  }
  if (/(?:^|[^\d.])10(?:\.0)?\s*(kg|kilo|bucket|bag)/.test(base)) {
    return hasBucket ? '10 Kg Bucket' : '10 Kg';
  }
  if (/2\.5\s*(ltr|litre|l\b)/.test(base)) {
    return '2.5 Ltr';
  }
  if (/2\.5\s*(kg|kilo|bucket|bag)|2500\s*(gm|g)\b/.test(base)) {
    return '2.5 Kg';
  }
  if (/(?:^|[^\d.])2(?:\.0)?\s*(kg|kilo)/.test(base)) {
    return '2 Kg';
  }
  if (/(?:^|[^\d.])25(?:\.0)?\s*(kg|kilo|hdpe|bag)/.test(base)) {
    return '25 Kg';
  }
  if (/(?:^|[^\d.])50(?:\.0)?\s*(kg|kilo|bag)/.test(base)) {
    return '50 Kg';
  }
  if (/(?:^|[^\d.])5(?:\.0)?\s*(ltr|litre|l\b)/.test(base)) {
    return '5 Ltr';
  }
  if (/(?:^|[^\d.])5(?:\.0)?\s*(kg|kilo)/.test(base)) {
    return '5 Kg';
  }
  if (/(?:^|[^\d.])1(?:\.0)?\s*(ltr|litre|l\b)/.test(base)) {
    return '1 Ltr';
  }
  if (/(?:^|[^\d.])1(?:\.0)?\s*(kg|kilo|box|bag)|1000\s*(gm|g)\b/.test(base)) {
    return '1 Kg';
  }
  if (/500\s*ml/.test(base)) {
    return '500 ml';
  }
  if (/500\s*(gm|g)|0\.5\s*kg/.test(base)) {
    return '500 gm';
  }
  if (/250\s*ml/.test(base)) {
    return '250 ml';
  }
  if (/250\s*(gm|g)|0\.25\s*kg/.test(base)) {
    return '250 gm';
  }
  if (/100\s*ml/.test(base)) {
    return '100 ml';
  }
  if (/100\s*(gm|g)|0\.1\s*kg/.test(base)) {
    return '100 gm';
  }
  return String(raw).replace(/\s+/g, ' ').trim();
}

const PACKING_SORT_ORDER: Record<string, number> = {
  '100 ml': 10,
  '100 gm': 20,
  '250 ml': 30,
  '250 gm': 40,
  '500 ml': 50,
  '500 gm': 60,
  '1 Ltr': 70,
  '1 Kg': 80,
  '2 Kg': 90,
  '2.5 Ltr': 100,
  '2.5 Kg': 110,
  '5 Ltr': 120,
  '5 Kg': 125,
  '10 Ltr': 130,
  '10 Kg': 140,
  '10 Kg Bucket': 145,
  '25 Kg': 150,
  '50 Kg': 160,
};

export function getPackingSortWeight(packingSize: any): number {
  const norm = normalizePackingSize(packingSize);
  if (PACKING_SORT_ORDER[norm] !== undefined) {
    return PACKING_SORT_ORDER[norm];
  }
  const lower = norm.toLowerCase();
  const numMatch = lower.match(/(\d+(?:\.\d+)?)/);
  const num = numMatch ? parseFloat(numMatch[1]) : 0;
  if (lower.includes('ml') || lower.includes('gm')) {
    return 1000 + num * 0.001;
  }
  return 1000 + num;
}

export function sortPackings<T extends { packingSize?: any; rate?: any }>(packings: T[]): T[] {
  if (!Array.isArray(packings)) return [];
  return [...packings].sort((a, b) => {
    const wA = getPackingSortWeight(a?.packingSize);
    const wB = getPackingSortWeight(b?.packingSize);
    if (wA !== wB) return wA - wB;
    return (Number(a?.rate) || 0) - (Number(b?.rate) || 0);
  });
}

/**
 * Canonical Fertilizer Grade Key:
 * Recognizes nutrient ratios and micro-elements invariants:
 * e.g. "00:42:47 + Fe" and "0:42:47 + Fe" -> "0-42-47-fe"
 * "0:52:34" and "00:52:34" -> "0-52-34"
 * "0:0:50" and "00:00:50" -> "0-0-50"
 * "12:61:0" and "12:61:00" -> "12-61-0"
 * "Airawat® 19:19:19" and "19:19:19" -> "19-19-19"
 * "Calcium Nitrate" and "Airawat Calcium Nitrate" -> "calciumnitrate"
 */
export function getCanonicalFertilizerKey(gradeOrName: any): string {
  if (!gradeOrName) return '';
  let s = String(gradeOrName).toLowerCase()
    .replace(/[®™]/g, '')
    .replace(/blackworm|airawat/g, '')
    .replace(/^[a-z]?\s*\d+\s*[\.\-\)]\s*/i, '') // strip leading code/numbering like "A 1.", "S 1.", "1."
    .trim();

  // 1. Check for NPK Ratio e.g. 19:19:19, 00:42:47, 0:52:34, 12:61:0
  const ratioMatch = s.match(/(\d+)\s*[:\-/]\s*(\d+)\s*[:\-/]\s*(\d+)/);
  if (ratioMatch) {
    const n1 = parseInt(ratioMatch[1], 10);
    const n2 = parseInt(ratioMatch[2], 10);
    const n3 = parseInt(ratioMatch[3], 10);
    const ratioKey = `${n1}-${n2}-${n3}`;

    // Extract micro-nutrients or trace elements
    const elements: string[] = [];
    if (/\b(fe|iron)\b/.test(s)) elements.push('fe');
    if (/\b(mg|magnesium)\b/.test(s)) elements.push('mg');
    if (/\b(zn|zinc)\b/.test(s)) elements.push('zn');
    if (/\b(cu|copper)\b/.test(s)) elements.push('cu');
    if (/\b(b|boron)\b/.test(s)) elements.push('b');
    if (/\b(s|sulphur|sulfur)\b/.test(s)) elements.push('s');
    if (/\b(combi|te|trace)\b/.test(s)) elements.push('combi');

    elements.sort();
    return elements.length > 0 ? `${ratioKey}-${elements.join('-')}` : ratioKey;
  }

  // 2. Named Fertilizer Grades
  if (/calcium/i.test(s) && /nitrate/i.test(s)) return 'calciumnitrate';
  if (/schoenite/i.test(s) || (/potassium/i.test(s) && /schoen/i.test(s))) return 'potassiumschoenite';
  if (/magnesium/i.test(s) && (/sulphate/i.test(s) || /sulfate/i.test(s))) return 'magnesiumsulphate';
  if (/nitro/i.test(s) && /king/i.test(s)) return 'nitroking';

  // Fallback to strict alphanumeric
  return s.replace(/[^a-z0-9]/g, '');
}

/**
 * Standardizes product group / category names to prevent split sections
 */
export function normalizeProductGroupName(g: any): string {
  const s = String(g || '').trim();
  const lower = s.toLowerCase();
  if (lower.includes('specialty') || lower.includes('speciality') || lower.includes('स्पेशालिटी') || lower.includes('स्पेशल')) {
    return 'Specialty Grades';
  }
  if (
    lower.includes('group a') ||
    lower.includes('group-a') ||
    lower.includes('a group') ||
    lower.includes('gr. a') ||
    lower.includes('gr a') ||
    lower === 'a' ||
    lower.includes('water soluble') ||
    lower.includes('ग्रुप अ') ||
    lower.includes('गट अ')
  ) {
    return 'Group A - Water Soluble Fertilizers';
  }
  if (
    lower.includes('group b') ||
    lower.includes('group-b') ||
    lower.includes('b group') ||
    lower.includes('b-group') ||
    lower.includes('gr. b') ||
    lower.includes('gr b') ||
    lower === 'b' ||
    /^b\s*[-–:]/.test(lower) ||
    lower.includes('micronutrient') ||
    lower.includes('micro nutrient') ||
    lower.includes('micro') ||
    lower.includes('ग्रुप ब') ||
    lower.includes('गट ब')
  ) {
    return 'Group B - Micronutrients';
  }
  if (
    lower.includes('group c') ||
    lower.includes('group-c') ||
    lower.includes('c group') ||
    lower.includes('c-group') ||
    lower.includes('gr. c') ||
    lower.includes('gr c') ||
    lower === 'c' ||
    /^c\s*[-–:]/.test(lower) ||
    lower.includes('growth regulator') ||
    lower.includes('plant growth') ||
    lower.includes('pgr') ||
    lower.includes('stimulant') ||
    lower.includes('ग्रुप क') ||
    lower.includes('गट क')
  ) {
    return 'Group C - Plant Growth Regulators';
  }
  return s.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}

/**
 * Cleans gradeName and brandName to ensure brand is never repeated inside grade
 */
export function cleanProductGradeAndBrand(brand: any, grade: any): { brandName: string; gradeName: string } {
  let b = String(brand || '').replace(/\s+/g, ' ').trim() || 'Airawat®';
  let g = String(grade || '').replace(/\s+/g, ' ').trim();

  // Strip leading numbering or codes like "C 1.", "B 1.", "A 1.", "S 1.", "1."
  g = g.replace(/^[A-Za-z]?\s*\d+\s*[\.\-\)]\s*/i, '').trim();

  // If grade starts with brand name (with or without symbol), strip brand from grade
  if (b) {
    const bClean = b.toLowerCase().replace(/[^a-z0-9]/g, '');
    const gClean = g.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (gClean.startsWith(bClean) && g.length > b.length) {
      // Find the slice point
      const matchedPrefix = g.match(new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[®™]?\\s*`, 'i'));
      if (matchedPrefix) {
        g = g.slice(matchedPrefix[0].length).trim();
      } else {
        // Fallback by length of letters
        const stripped = g.replace(/^[A-Za-z0-9®™\s\-_]+\b/i, (match) => {
          if (match.toLowerCase().replace(/[^a-z0-9]/g, '') === bClean) return '';
          return match;
        }).trim();
        if (stripped) g = stripped;
      }
    }
  }

  // Common Blackworm brand names prefix check
  const knownBrands = [
    'BioVinS2® Plus', 'BioVinS2®', '4 Star', 'Black Gold™', 'AminoX', 'Fulvi Grow',
    'Siliboost®', 'Megaenergeol®', 'Strange Super™', 'Strange™', 'UV Guard™', 'Neemaza',
    'V-Lin', 'Blackelp', 'Blackworm Sulphur', 'Bullet™', 'Phantom™', 'Fungifight™ - P',
    'Fungifight™ - L', 'Whitewash™', 'KICK®', 'DRONA™', 'Sparsh™', 'Nutri Excel',
    'Microgrip DF®', 'Microgrip®', 'Nutrijet', 'Nutriva', 'BW Combi®', 'Nutrizen',
    'Zingo', 'PoMag®', 'BLOW - B', 'BLOW - Fe', 'BLOW - Zn', 'Blackworm’s VAM',
    'BLOW - Ca', 'BLOW - Mg', 'FENZO', 'BLACKWORM CMB'
  ];

  for (const kb of knownBrands) {
    const kbClean = kb.toLowerCase().replace(/[^a-z0-9]/g, '');
    const gClean = g.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (gClean.startsWith(kbClean) && gClean.length > kbClean.length) {
      if (!b || b === 'Airawat®') b = kb;
      const stripped = g.replace(new RegExp(`^${kb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim();
      if (stripped) g = stripped;
      break;
    }
  }

  const finalGrade = (g || String(grade || '')).replace(/\s+/g, ' ').trim();
  return { brandName: b, gradeName: finalGrade };
}

/**
 * Resolves a unique canonical key for any product object
 * Prioritizes (Group + Serial Code) so B 1. to B 16. and C 1. to C 27. never duplicate
 */
export function getCanonicalProductKey(p: any): string {
  if (!p) return '';
  const normGroup = normalizeProductGroupName(p.groupName);
  
  // 1. Group + Numeric Code Match (e.g. Group B + B 1. or 1. -> grp_b_1)
  const codeStr = String(p.code || '').trim();
  const numMatch = codeStr.match(/(\d+)/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    let groupPrefix = '';
    if (normGroup.includes('Group A')) groupPrefix = 'grp_a';
    else if (normGroup.includes('Specialty')) groupPrefix = 'grp_s';
    else if (normGroup.includes('Group B')) groupPrefix = 'grp_b';
    else if (normGroup.includes('Group C')) groupPrefix = 'grp_c';

    if (groupPrefix && num > 0) {
      return `${groupPrefix}_${num}`;
    }
  }

  // 2. Canonical Fertilizer / Nutrient Ratio / Chemical Key
  const { gradeName } = cleanProductGradeAndBrand(p.brandName, p.gradeName || p.name);
  const gradeKey = getCanonicalFertilizerKey(gradeName);
  if (gradeKey) {
    let groupPrefix = '';
    if (normGroup.includes('Group A')) groupPrefix = 'grp_a';
    else if (normGroup.includes('Specialty')) groupPrefix = 'grp_s';
    else if (normGroup.includes('Group B')) groupPrefix = 'grp_b';
    else if (normGroup.includes('Group C')) groupPrefix = 'grp_c';
    return groupPrefix ? `${groupPrefix}_${gradeKey}` : gradeKey;
  }

  if (p.code) {
    const codeClean = String(p.code).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (codeClean && !codeClean.startsWith('item')) return codeClean;
  }
  return normalizeKey(p.id || '');
}

/**
 * Deduplicates product list so no product ever appears duplicated.
 * Matches by invariant canonical keys (Group + Code and Nutrient/Chemical names).
 * When duplicate entries or packing rows occur, combines packings seamlessly
 * without duplicate packing sizes or conflicting rates.
 */
export function deduplicateProducts<T = any>(products: T[]): T[] {
  if (!products || !Array.isArray(products) || products.length === 0) return [];
  const map = new Map<string, any>();

  products.forEach((p: any) => {
    if (!p) return;
    const normGroup = normalizeProductGroupName(p.groupName);
    const { brandName, gradeName } = cleanProductGradeAndBrand(p.brandName, p.gradeName || p.name);

    // Standardize packing list for incoming item (with Group A 1Kg self-healing & ascending sort)
    const incomingPackingsRaw: any[] = [];
    if (Array.isArray(p.packings) && p.packings.length > 0) {
      p.packings.forEach((pk: any) => {
        if (!pk) return;
        let normSize = normalizePackingSize(pk.packingSize);
        const rate = Number(pk.rate) || 0;
        const mrp = Number(pk.mrp) || 0;
        // Self-heal Group A & Specialty single-kg pouches that were previously misclassified as "25 Kg" due to "1Kg * 25 Nos"
        if ((normGroup.includes('Group A') || normGroup.includes('Specialty')) && normSize === '25 Kg' && rate > 0 && rate < 1000) {
          normSize = '1 Kg';
        }
        const existingIdx = incomingPackingsRaw.findIndex((ep: any) => ep.packingSize === normSize);
        if (existingIdx >= 0) {
          incomingPackingsRaw[existingIdx] = {
            ...incomingPackingsRaw[existingIdx],
            packingSize: normSize,
            rate: rate > 0 ? rate : incomingPackingsRaw[existingIdx].rate,
            mrp: mrp > 0 ? mrp : incomingPackingsRaw[existingIdx].mrp,
          };
        } else {
          incomingPackingsRaw.push({ ...pk, packingSize: normSize, rate, mrp });
        }
      });
    }
    const incomingPackings = sortPackings(incomingPackingsRaw);

    const key = getCanonicalProductKey({ ...p, groupName: normGroup, gradeName, brandName });
    if (!key) {
      if (p.id) map.set(p.id, { ...p, groupName: normGroup, gradeName, brandName, packings: incomingPackings });
      return;
    }

    if (!map.has(key)) {
      map.set(key, {
        ...p,
        groupName: normGroup,
        brandName,
        gradeName,
        packings: incomingPackings,
        isArchived: false,
      });
    } else {
      const existing: any = map.get(key)!;
      const existingPackings: any[] = Array.isArray(existing.packings) ? [...existing.packings] : [];

      incomingPackings.forEach((pk: any) => {
        const pkSize = pk.packingSize;
        const idx = existingPackings.findIndex((ep: any) => ep?.packingSize === pkSize);
        if (idx >= 0) {
          existingPackings[idx] = {
            ...existingPackings[idx],
            packingSize: pkSize,
            rate: pk.rate > 0 ? pk.rate : existingPackings[idx].rate,
            mrp: pk.mrp > 0 ? pk.mrp : existingPackings[idx].mrp,
          };
        } else {
          existingPackings.push({
            packingSize: pkSize,
            rate: pk.rate || 0,
            mrp: pk.mrp || 0,
          });
        }
      });

      // Keep cleanest gradeName: prefer gradeName that does NOT contain brandName
      let chosenGrade = existing.gradeName;
      if (chosenGrade.toLowerCase().includes(brandName.toLowerCase().replace(/[®™]/g, '')) && !gradeName.toLowerCase().includes(brandName.toLowerCase().replace(/[®™]/g, ''))) {
        chosenGrade = gradeName;
      }

      const preferExistingCode = existing.code && !String(existing.code).startsWith('item_');
      const preferIncomingId = existing.id?.startsWith('temp_');

      const updatedItem: any = {
        ...existing,
        ...p,
        id: preferIncomingId ? (p.id || existing.id) : (existing.id || p.id),
        packings: sortPackings(existingPackings),
        groupName: normGroup,
        brandName: (brandName && brandName !== 'Airawat®') ? brandName : existing.brandName,
        code: preferExistingCode ? existing.code : (p.code || existing.code),
        gradeName: chosenGrade,
        hsn: p.hsn || existing.hsn,
        gstRate: p.gstRate !== undefined ? p.gstRate : existing.gstRate,
        orderIndex: existing.orderIndex || p.orderIndex,
        isArchived: false,
      };
      map.set(key, updatedItem);
    }
  });

  const list = Array.from(map.values()).map((item: any) => ({
    ...item,
    packings: sortPackings(item.packings || []),
  }));

  // Sort by official Group order and numeric serial number
  list.sort((a, b) => {
    const getGroupWeight = (g: string) => {
      if (g.includes('Group A')) return 1;
      if (g.includes('Specialty')) return 2;
      if (g.includes('Group B')) return 3;
      if (g.includes('Group C')) return 4;
      return 5;
    };
    const wA = getGroupWeight(a.groupName);
    const wB = getGroupWeight(b.groupName);
    if (wA !== wB) return wA - wB;

    const numA = parseInt(String(a.code || '').replace(/\D/g, '') || '0', 10);
    const numB = parseInt(String(b.code || '').replace(/\D/g, '') || '0', 10);
    if (numA !== numB) return numA - numB;

    return (a.orderIndex || 0) - (b.orderIndex || 0);
  });

  return list as unknown as T[];
}

/**
 * Deduplicates dealers so no dealership entry is doubled or tripled.
 * Matches by exact ID, dealerCode, and firmName + (contactNumber or proprietorName or village).
 * Prefers persistent Firestore documents over temp_ offline documents.
 */
export function deduplicateDealers<T = any>(dealers: T[]): T[] {
  if (!dealers || !Array.isArray(dealers) || dealers.length === 0) return [];
  const map = new Map<string, any>();

  dealers.forEach((d: any) => {
    if (!d) return;
    const docId = d.id || '';
    const cleanCode = (d.dealerCode || '').trim().toUpperCase();
    const cleanFirm = normalizeKey(d.firmName);
    const cleanContact = (d.contactNumber || '').replace(/\D/g, '').slice(-10);
    const cleanVillage = normalizeKey(d.village);
    const cleanProp = normalizeKey(d.proprietorName);

    let key = '';
    if (cleanFirm) {
      key = `${cleanFirm}_${cleanContact || cleanVillage || cleanProp || 'main'}`;
    } else if (cleanCode && cleanCode !== '-' && cleanCode !== 'NEW') {
      key = `code_${cleanCode}`;
    } else if (docId) {
      key = `id_${docId}`;
    }

    if (!key) return;

    if (!map.has(key)) {
      map.set(key, { ...d });
    } else {
      const existing = map.get(key)!;
      const preferIncomingId = existing.id?.startsWith('temp_') && !d.id?.startsWith('temp_');
      const preferIncomingCode = (!existing.dealerCode || existing.dealerCode === '-' || existing.dealerCode === 'NEW') && d.dealerCode;

      const merged = {
        ...existing,
        ...d,
        id: preferIncomingId ? d.id : (existing.id || d.id),
        dealerCode: preferIncomingCode ? d.dealerCode : (existing.dealerCode || d.dealerCode),
        firmName: existing.firmName || d.firmName,
        contactNumber: existing.contactNumber || d.contactNumber,
        village: existing.village || d.village,
        proprietorName: existing.proprietorName || d.proprietorName,
        isArchived: existing.isArchived !== undefined ? (existing.isArchived && d.isArchived) : d.isArchived,
      };
      map.set(key, merged);
    }
  });

  return Array.from(map.values()) as unknown as T[];
}

/**
 * Deduplicates orders so no order is duplicated.
 * Matches by exact ID and non-empty orderNumber.
 */
export function deduplicateOrders<T = any>(orders: T[]): T[] {
  if (!orders || !Array.isArray(orders) || orders.length === 0) return [];
  const result: T[] = [];
  const seenIds = new Set<string>();
  const seenOrderNums = new Set<string>();

  orders.forEach((o: any) => {
    if (!o) return;
    const docId = o.id || '';
    const orderNum = (o.orderNumber || '').trim().toUpperCase();

    if (docId && seenIds.has(docId)) return;
    if (orderNum && seenOrderNums.has(orderNum)) return;

    if (docId) seenIds.add(docId);
    if (orderNum) seenOrderNums.add(orderNum);

    result.push(o);
  });

  return result;
}

/**
 * Deduplicates collection entries so no receipt is doubled or tripled.
 * Matches by ID, receiptNumber, and composite (date + dealerId + amount + collectedByUid).
 */
export function deduplicateCollections<T = any>(entries: T[]): T[] {
  if (!entries || !Array.isArray(entries) || entries.length === 0) return [];
  const result: T[] = [];
  const seenIds = new Set<string>();
  const seenReceipts = new Set<string>();
  const seenComposite = new Set<string>();

  entries.forEach((e: any) => {
    if (!e) return;
    const docId = e.id || '';
    const receipt = (e.receiptNumber || '').trim().toUpperCase();
    const date = (e.date || '').trim();
    const dealerId = (e.dealerId || '').trim();
    const amount = Number(e.amount) || 0;
    const collector = (e.collectedByUid || e.userId || '').trim();

    const composite = (date && dealerId && amount > 0)
      ? `${date}_${dealerId}_${amount}_${collector}`
      : '';

    if (docId && seenIds.has(docId)) return;
    if (receipt && seenReceipts.has(receipt)) return;
    if (composite && seenComposite.has(composite)) return;

    if (docId) seenIds.add(docId);
    if (receipt) seenReceipts.add(receipt);
    if (composite) seenComposite.add(composite);

    result.push(e);
  });

  return result;
}

/**
 * Merges Firestore snapshot data with locally cached records and updates the device cache
 */
export function mergeWithLocalData<T extends { id: string }>(
  colName: string,
  serverItems: T[],
  options?: { archivedIds?: Set<string>; authoritativeServer?: boolean }
): T[] {
  try {
    if (typeof window === 'undefined') {
      return (serverItems || []).filter((it: any) => it && !it.isArchived);
    }
    const storageKey = `blackworm_local_${colName}`;
    const pendingIds = getPendingSyncIdSet(colName);
    const archivedSet = new Set<string>(options?.archivedIds ? Array.from(options.archivedIds) : []);
    (serverItems || []).forEach((it: any) => {
      if (it && it.id && it.isArchived) {
        archivedSet.add(it.id);
      }
    });

    // Automatically update local cache whenever fresh server data arrives
    if (serverItems && serverItems.length > 0) {
      updateCollectionCache(colName, serverItems);
    }

    const activeServerItems = (serverItems || []).filter((it: any) => it && !it.isArchived);
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      if (colName === 'dealers_application' || colName === 'dealers') return deduplicateDealers(activeServerItems as any) as unknown as T[];
      if (colName === 'orders') return deduplicateOrders(activeServerItems as any) as unknown as T[];
      if (colName === 'collection_entries') return deduplicateCollections(activeServerItems as any) as unknown as T[];
      if (colName === 'products_pricelist_v2' || colName === 'products') return deduplicateProducts(activeServerItems as any) as unknown as T[];
      return activeServerItems;
    }

    let map: Record<string, any>;
    try {
      const parsed = JSON.parse(raw);
      map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      console.warn(`Local cache corrupt for ${colName}, clearing.`);
      localStorage.removeItem(storageKey);
      return activeServerItems;
    }

    const mergedMap = new Map<string, any>();

    // First insert active server items
    activeServerItems.forEach((it) => {
      if (it && it.id) mergedMap.set(it.id, it);
    });

    // Clean up temporary or archived items from local map when server confirms
    let mapMutated = false;
    archivedSet.forEach((archId) => {
      if (archId in map && !pendingIds.has(archId)) {
        delete map[archId];
        mapMutated = true;
      }
    });

    Object.keys(map).forEach((id) => {
      if (id.startsWith('temp_')) {
        const tempItem = map[id];
        const hasMatch = activeServerItems.some((s: any) => {
          if (s.orderNumber && tempItem.orderNumber && s.orderNumber === tempItem.orderNumber) return true;
          if (s.dealerCode && tempItem.dealerCode && s.dealerCode === tempItem.dealerCode) return true;
          if (s.receiptNumber && tempItem.receiptNumber && s.receiptNumber === tempItem.receiptNumber) return true;
          if (s.firmName && tempItem.firmName && normalizeKey(s.firmName) === normalizeKey(tempItem.firmName) && s.contactNumber === tempItem.contactNumber) return true;
          return false;
        });
        if (hasMatch) {
          delete map[id];
          mapMutated = true;
        }
      }
    });

    if (mapMutated) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(map));
      } catch {}
    }

    // Overlay locally saved items ONLY when they are genuinely pending sync (prevents clock skew overwriting fresh server updates)
    Object.entries(map).forEach(([id, localDoc]) => {
      if (!localDoc || localDoc.isArchived || archivedSet.has(id)) {
        mergedMap.delete(id);
        return;
      }
      const isPending = pendingIds.has(id) || id.startsWith('temp_');
      if (mergedMap.has(id)) {
        const serverItem = mergedMap.get(id);
        if (serverItem?.isArchived) {
          mergedMap.delete(id);
          return;
        }
        if (isPending) {
          const localTime = toTimestampMs(localDoc._localSavedAt || localDoc.updatedAt);
          const serverTime = toTimestampMs(serverItem.updatedAt || serverItem.createdAt);
          if (localTime > serverTime) {
            mergedMap.set(id, { ...serverItem, ...localDoc });
          }
        }
      } else if (!options?.authoritativeServer || isPending) {
        mergedMap.set(id, localDoc);
      }
    });

    let mergedList = Array.from(mergedMap.values()).filter((it) => it && !it.isArchived);

    // Apply collection-specific intelligent deduplication
    if (colName === 'dealers_application' || colName === 'dealers') {
      mergedList = deduplicateDealers(mergedList);
    } else if (colName === 'orders') {
      mergedList = deduplicateOrders(mergedList);
    } else if (colName === 'collection_entries') {
      mergedList = deduplicateCollections(mergedList);
    } else if (colName === 'products_pricelist_v2' || colName === 'products') {
      mergedList = deduplicateProducts(mergedList);
    }

    return mergedList as T[];
  } catch (e) {
    console.warn(`Merge error for ${colName}:`, e);
    return serverItems;
  }
}

/**
 * Triggers a comprehensive sync across all devices and broadcasts a refresh event
 */
export async function triggerFullDataRefresh(): Promise<void> {
  try {
    await startBackgroundSync();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blackworm_data_refresh', { detail: { timestamp: Date.now() } }));
    }
  } catch (e) {
    console.warn('triggerFullDataRefresh notice:', e);
  }
}

export interface DeletedRecordItem {
  id: string;
  originalCollection: string;
  originalRecordId: string;
  data: any;
  deletedByUid: string;
  deletedByName: string;
  deletedAt: string;
}

export async function logAudit(
  action: AuditLogItem['action'],
  colName: string,
  recordId: string,
  summary: string,
  user: UserProfile
) {
  try {
    const auditRef = collection(db, 'audit_logs');
    const logData = {
      action,
      collection: colName,
      recordId,
      recordSummary: summary,
      performedByUid: user.uid,
      performedByName: user.fullName || 'User',
      timestamp: new Date().toISOString(),
      createdAt: serverTimestamp(),
    };
    await addDoc(auditRef, logData);
  } catch (err) {
    // Non-fatal audit log absorption
  }
}

export async function softDeleteRecord(
  colName: string,
  recordId: string,
  recordData: any,
  user: UserProfile
) {
  try {
    const trashDocRef = doc(collection(db, 'deleted_records'));
    await setDoc(trashDocRef, {
      id: trashDocRef.id,
      originalCollection: colName,
      originalRecordId: recordId,
      data: recordData,
      deletedByUid: user.uid,
      deletedByName: user.fullName || 'User',
      deletedAt: new Date().toISOString(),
    });

    const originalDocRef = doc(db, colName, recordId);
    await updateDoc(originalDocRef, {
      isArchived: true,
      updatedAt: new Date().toISOString(),
      updatedBy: user.uid,
    });

    await logAudit('DELETE', colName, recordId, `Soft deleted: ${recordData.name || recordData.shopName || recordData.title || recordId}`, user);
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `${colName}/${recordId}`);
    return false;
  }
}

export async function restoreRecord(
  trashRecord: DeletedRecordItem,
  user: UserProfile
) {
  try {
    const originalDocRef = doc(db, trashRecord.originalCollection, trashRecord.originalRecordId);
    await updateDoc(originalDocRef, {
      isArchived: false,
      updatedAt: new Date().toISOString(),
      restoredBy: user.uid,
    });

    await deleteDoc(doc(db, 'deleted_records', trashRecord.id));
    await logAudit('RESTORE', trashRecord.originalCollection, trashRecord.originalRecordId, `Restored from recycle bin`, user);
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `deleted_records/${trashRecord.id}`);
    return false;
  }
}

export async function exportAllData() {
  const collectionsToExport = ['users', 'farmers', 'orders', 'targets', 'travel_records', 'dealers', 'products', 'schemes', 'audit_logs'];
  const backup: Record<string, any[]> = {
    _metadata: [{
      version: '1.0',
      exportedAt: new Date().toISOString(),
      app: 'Blackworm Agritech Pvt Ltd',
    }]
  };

  for (const col of collectionsToExport) {
    try {
      const snap = await getDocs(collection(db, col));
      backup[col] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.warn(`Export skipping ${col}:`, e);
      backup[col] = [];
    }
  }

  const jsonStr = JSON.stringify(backup, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  triggerBlobDownload(blob, `blackworm_backup_${getLocalDateStr()}.json`);
}

export async function seedInitialDataIfEmpty(user: UserProfile) {
  try {
    if (typeof window !== 'undefined' && localStorage.getItem('blackworm_initial_seeded') === 'true') {
      return;
    }

    const productsSnap = await getDocs(collection(db, 'products'));
    if (productsSnap.empty) {
      const initialProducts = [
        { name: 'Blackworm Premium Vermicompost', category: 'Organic Fertilizers', packSize: '50 kg Bag', mrp: 750, dealerPrice: 580, farmerPrice: 650, inStock: true },
        { name: 'Blackworm Vermiwash Liquid Extract', category: 'Bio-Stimulants', packSize: '5 Litre Can', mrp: 600, dealerPrice: 450, farmerPrice: 520, inStock: true },
        { name: 'Bio-NPK Consortium Culture', category: 'Bio-Fertilizers', packSize: '1 Litre Bottle', mrp: 480, dealerPrice: 340, farmerPrice: 400, inStock: true },
        { name: 'Neem Oil Pest Guard 10000 PPM', category: 'Bio-Pesticides', packSize: '1 Litre Bottle', mrp: 650, dealerPrice: 490, farmerPrice: 560, inStock: true },
        { name: 'Humic Acid 98% Potassium Humate', category: 'Soil Conditioners', packSize: '1 kg Pouch', mrp: 550, dealerPrice: 380, farmerPrice: 450, inStock: true }
      ];

      for (const p of initialProducts) {
        const pRef = doc(collection(db, 'products'));
        await setDoc(pRef, {
          id: pRef.id,
          ...p,
          isArchived: false,
          createdAt: new Date().toISOString(),
        });
      }
    }

    const dealersSnap = await getDocs(collection(db, 'dealers'));
    if (dealersSnap.empty) {
      const initialDealers = [
        { shopName: 'Kisan Krushi Seva Kendra', proprietorName: 'Ramesh Patil', mobile: '9822012345', village: 'Baramati', district: 'Pune', gstNo: '27AABCU9603R1ZM', creditLimit: 150000, outstandingBalance: 42500 },
        { shopName: 'Sai Agro Agencies', proprietorName: 'Sanjay Deshmukh', mobile: '9823156789', village: 'Sangamner', district: 'Ahmednagar', gstNo: '27BDCPC1234F1Z3', creditLimit: 200000, outstandingBalance: 68000 }
      ];

      for (const d of initialDealers) {
        const dRef = doc(collection(db, 'dealers'));
        await setDoc(dRef, {
          id: dRef.id,
          ...d,
          ownerId: user.uid,
          isArchived: false,
          createdAt: new Date().toISOString(),
        });
      }
    }

    if (typeof window !== 'undefined') {
      localStorage.setItem('blackworm_initial_seeded', 'true');
    }
  } catch (err) {
    console.error('Initial seeding notice:', err);
  }
}

/**
 * Synchronizes updated user/officer details (name, designation, center) across all linked historical records.
 * Historical form data, calculations, serial numbers, and relationships remain strictly intact.
 * Avoids duplicate or broken records by updating documents by exact ID.
 */
export async function syncOfficerDetailsEverywhere(
  userId: string,
  updatedName: string,
  updatedDesignation?: string,
  updatedCenter?: string,
  extraIdentifiers?: { loginId?: string; oldName?: string; userCode?: string }
) {
  if (!userId || !updatedName) return;

  const cleanName = toTitleCase(updatedName);
  const cleanDesig = toTitleCase(updatedDesignation);
  const cleanCenter = toTitleCase(updatedCenter);
  const extraLogin = (extraIdentifiers?.loginId || '').trim().toLowerCase();
  const extraOldName = (extraIdentifiers?.oldName || '').trim().toUpperCase();
  const extraCode = (extraIdentifiers?.userCode || '').trim().toLowerCase();

  // Helper to update matching cached collection documents without full-collection remote scans
  const updateTargets = async (
    colName: string,
    matcher: (data: any, id: string) => Record<string, any> | null
  ) => {
    try {
      const storageKey = `blackworm_local_${colName}`;
      const raw = typeof window !== 'undefined' ? localStorage.getItem(storageKey) : null;
      if (raw) {
        const map = JSON.parse(raw);
        if (map && typeof map === 'object' && !Array.isArray(map)) {
          const updates: Promise<any>[] = [];
          Object.entries(map).forEach(([id, data]) => {
            const patch = matcher(data, id);
            if (patch) {
              updates.push(
                safeFirestoreUpdate(colName, id, patch).catch((e) =>
                  console.warn(`Sync notice for ${colName}/${id}:`, e)
                )
              );
            }
          });
          if (updates.length > 0) {
            await Promise.all(updates);
            return;
          }
        }
      }

      if (!isQuotaBlocked()) {
        try {
          const snap = await getDocs(collection(db, colName));
          trackFirestoreUsage('read', Math.max(1, snap.docs.length));
          const updates: Promise<any>[] = [];
          snap.forEach((d) => {
            const patch = matcher(d.data(), d.id);
            if (patch) {
              updates.push(
                safeFirestoreUpdate(colName, d.id, patch).catch((e) =>
                  console.warn(`Sync notice for ${colName}/${d.id}:`, e)
                )
              );
            }
          });
          if (updates.length > 0) {
            await Promise.all(updates);
          }
          return;
        } catch (fbErr: any) {
          if (isQuotaErrorMsg(fbErr?.message || '')) setQuotaBlocked(15 * 60 * 1000);
        }
      }

      const sec = await fetchSecondaryCollection(colName, { limit: 2000 });
      if (sec.ok && sec.items.length > 0) {
        const updates: Promise<any>[] = [];
        sec.items.forEach((d) => {
          const patch = matcher(d, d.id);
          if (patch) {
            updates.push(
              safeFirestoreUpdate(colName, d.id, patch).catch((e) =>
                console.warn(`Secondary sync notice for ${colName}/${d.id}:`, e)
              )
            );
          }
        });
        if (updates.length > 0) {
          await Promise.all(updates);
        }
      }
    } catch (err) {
      console.warn(`Sync notice in ${colName}:`, err);
    }
  };

  await updateTargets('dealers_application', (data) => {
    const isLinked =
      data.created_by_user_id === userId ||
      data.createdByUid === userId ||
      data.userId === userId ||
      data.ownerId === userId ||
      (extraLogin && data.loginId && data.loginId.toLowerCase() === extraLogin) ||
      (extraCode && data.userCode && String(data.userCode).toLowerCase() === extraCode) ||
      (extraOldName && data.officerName && data.officerName.toUpperCase() === extraOldName) ||
      (extraOldName && data.created_by_name && data.created_by_name.toUpperCase() === extraOldName);
    const needsChange =
      data.officerName !== cleanName ||
      data.created_by_name !== cleanName ||
      (cleanDesig && data.designation !== cleanDesig);
    if (!isLinked || !needsChange) return null;
    return {
      officerName: cleanName,
      created_by_name: cleanName,
      createdByName: cleanName,
      ...(cleanDesig ? { designation: cleanDesig } : {}),
    };
  });

  await updateTargets('orders', (data) => {
    const isLinked =
      data.userId === userId ||
      data.ownerId === userId ||
      (extraLogin && data.loginId && data.loginId.toLowerCase() === extraLogin) ||
      (extraOldName && data.createdByName && data.createdByName.toUpperCase() === extraOldName);
    const needsChange =
      data.createdByName !== cleanName ||
      (cleanDesig && data.designation !== cleanDesig);
    if (!isLinked || !needsChange) return null;
    return {
      createdByName: cleanName,
      ...(cleanDesig ? { designation: cleanDesig } : {}),
    };
  });

  await updateTargets('collection_entries', (data) => {
    const isLinked =
      data.userId === userId ||
      data.ownerId === userId ||
      data.collectedByUid === userId ||
      (extraLogin && data.loginId && data.loginId.toLowerCase() === extraLogin) ||
      (extraOldName && data.collectedByName && data.collectedByName.toUpperCase() === extraOldName) ||
      (extraOldName && data.createdByName && data.createdByName.toUpperCase() === extraOldName);
    const needsChange =
      data.createdByName !== cleanName ||
      data.collectedByName !== cleanName ||
      data.officerName !== cleanName;
    if (!isLinked || !needsChange) return null;
    return {
      createdByName: cleanName,
      collectedByName: cleanName,
      officerName: cleanName,
    };
  });

  await updateTargets('travel_sheets', (data, id) => {
    const isLinked = data.userId === userId || id.startsWith(`travel_${userId}`);
    const needsChange =
      data.officerName !== cleanName ||
      (cleanDesig && data.designation !== cleanDesig);
    if (!isLinked || !needsChange) return null;
    return {
      officerName: cleanName,
      ...(cleanDesig ? { designation: cleanDesig } : {}),
    };
  });

  await updateTargets('yearly_targets', (data, id) => {
    const isLinked = data.userId === userId || id.startsWith(`yearly_${userId}`);
    const needsChange =
      data.fullName !== cleanName ||
      (cleanDesig && data.designation !== cleanDesig) ||
      (cleanCenter && data.center !== cleanCenter);
    if (!isLinked || !needsChange) return null;
    return {
      fullName: cleanName,
      ...(cleanDesig ? { designation: cleanDesig } : {}),
      ...(cleanCenter ? { center: cleanCenter } : {}),
    };
  });

  await updateTargets('targets', (data) => {
    if (data.userId === userId && data.userName !== cleanName) {
      return { userName: cleanName };
    }
    return null;
  });
}

/**
 * Creates a comprehensive full backup of the entire application database across all collections.
 * Generates and downloads a complete JSON file that any developer can run or restore anywhere.
 */
export async function exportFullDatabaseBackup(profile: UserProfile): Promise<{ success: boolean; filename: string; stats: Record<string, number> }> {
  const collectionsToBackup = [
    'users',
    'dealers_application',
    'orders',
    'collection_entries',
    'travel_sheets',
    'yearly_targets',
    'targets',
    'travel_records',
    'products_pricelist_v2',
    'pricelist_backups',
    'config',
    'deleted_records',
    'audit_logs',
  ];

  const backupData: Record<string, any[]> = {};
  const stats: Record<string, number> = {};

  for (const colName of collectionsToBackup) {
    let docsList: any[] = [];
    if (!isQuotaBlocked()) {
      try {
        const snap = await getDocs(collection(db, colName));
        trackFirestoreUsage('read', Math.max(1, snap.docs.length));
        snap.forEach((d) => {
          docsList.push({ _id: d.id, ...d.data() });
        });
      } catch (e: any) {
        if (isQuotaErrorMsg(e?.message || '')) setQuotaBlocked(15 * 60 * 1000);
        console.warn(`Could not export primary collection ${colName}:`, e);
      }
    }
    if (docsList.length === 0) {
      try {
        const sec = await fetchSecondaryCollection(colName, { limit: 5000, includeDeleted: true });
        if (sec.ok && sec.items.length > 0) {
          docsList = sec.items.map((it) => ({ _id: it.id, ...it }));
        }
      } catch {}
    }
    if (docsList.length === 0) {
      docsList = mergeWithLocalData<any>(colName, []).map((it) => ({ _id: it.id, ...it }));
    }
    backupData[colName] = docsList;
    stats[colName] = docsList.length;
  }

  const exportPayload = {
    appName: 'Blackworm Agritech Pvt Ltd - Core Business Data',
    exportVersion: '2.0',
    exportedAt: new Date().toISOString(),
    exportedByUid: profile.uid,
    exportedByName: profile.fullName || profile.loginId || 'Admin',
    statistics: stats,
    collections: backupData,
  };

  // Local mirror backup in browser storage as additional offline safety net
  try {
    localStorage.setItem('BLACKWORM_LOCAL_DATA_MIRROR', JSON.stringify({
      savedAt: new Date().toISOString(),
      statistics: stats,
    }));
  } catch (e) {
    console.warn('Local mirror storage failed:', e);
  }

  const dateStr = getLocalDateStr();
  const timeStr = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
  const filename = `Blackworm_Full_Database_Backup_${dateStr}_${timeStr}.json`;

  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
  triggerBlobDownload(blob, filename);

  try {
    await logAudit(
      'BACKUP_EXPORT',
      'system',
      'full_export',
      `Full system database backup exported by ${profile.fullName || profile.loginId} (${Object.values(stats).reduce((a, b) => a + b, 0)} total records)`,
      profile
    );
  } catch (e) {
    console.warn('Audit failed on backup export:', e);
  }

  return { success: true, filename, stats };
}

/**
 * Restores all collections from a JSON backup file.
 */
export async function restoreDatabaseFromJson(jsonData: string, profile: UserProfile): Promise<{ success: boolean; restoredCount: number; message: string }> {
  const parsed = JSON.parse(jsonData);
  if (!parsed || typeof parsed !== 'object' || !parsed.collections || typeof parsed.collections !== 'object' || Array.isArray(parsed.collections)) {
    throw new Error('अवैध बॅकअप फाईल स्वरूप (Invalid backup file structure).');
  }

  let totalRestored = 0;
  for (const [colName, docsList] of Object.entries(parsed.collections)) {
    if (!colName || colName.startsWith('_') || !Array.isArray(docsList)) continue;
    const restoredForCache: any[] = [];
    const secondaryBatch: any[] = [];
    for (const item of docsList) {
      if (!item || typeof item !== 'object') continue;
      const docId = String(item._id || item.id || '').trim();
      if (!docId || docId.includes('/')) continue;
      const cleanItem = { ...item, id: docId };
      delete cleanItem._id;
      if (!isQuotaBlocked()) {
        try {
          await setDoc(doc(db, colName, docId), cleanItem, { merge: true });
        } catch (err: any) {
          if (isQuotaErrorMsg(err?.message || '')) setQuotaBlocked(15 * 60 * 1000);
          setPendingSyncItem(colName, docId, cleanItem, { merge: true }, { needsFirebase: true, needsSecondary: false });
        }
      } else {
        setPendingSyncItem(colName, docId, cleanItem, { merge: true }, { needsFirebase: true, needsSecondary: false });
      }
      secondaryBatch.push({
        collection: colName,
        id: docId,
        doc: cleanItem,
        deleted: Boolean(cleanItem.isArchived),
        merge: true,
      });
      restoredForCache.push(cleanItem);
      totalRestored++;
    }
    if (secondaryBatch.length > 0) {
      await pushBatchToSecondary(secondaryBatch);
    }
    if (restoredForCache.length > 0) {
      updateCollectionCache(colName, restoredForCache);
    }
  }

  try {
    await logAudit(
      'BACKUP_IMPORT',
      'system',
      'full_import',
      `Restored database from JSON backup (${totalRestored} records restored) by ${profile.fullName || profile.loginId}`,
      profile
    );
  } catch (e) {
    console.warn('Audit failed on backup import:', e);
  }

  return { success: true, restoredCount: totalRestored, message: `${totalRestored} रेकॉर्ड यशस्वीरित्या रिस्टोर झाले.` };
}
