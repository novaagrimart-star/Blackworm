import { useState, useEffect, type SetStateAction } from 'react';
import {
  collection,
  doc,
  query,
  limit,
  onSnapshot,
  getDocFromServer,
  getDocsFromServer,
} from 'firebase/firestore';
import { db, isQuotaExceededError } from '../firebase';
import { UserProfile } from './auth';
import {
  mergeWithLocalData,
  deduplicateDealers,
  deduplicateOrders,
  deduplicateCollections,
  deduplicateProducts,
  removeFromCollectionCache,
  updateCollectionCache,
  trackFirestoreUsage,
  toTimestampMs,
  isQuotaBlocked,
  setQuotaBlocked,
  resetReadQuotaBackoff,
  safeLocalStorageSet,
  safeFirestoreSet,
  getPendingSyncMap,
  isRecordDeleted,
  mergeTravelSheetDocs,
} from './dataService';
import {
  DEFAULT_STATE,
  LocationTalukaItem,
  LocationVillageItem,
  canonicalizeDistrictName,
  canonicalizeTalukaName,
  deduplicateLocationTalukas,
  deduplicateLocationVillages,
  getDistrictMeta,
  getLocationTalukaDocId,
  getLocationVillageDocId,
  getStateMeta,
  getTalukaMeta,
  normalizeLocationKey,
  normalizeStateName,
} from './maharashtraLocations';
import { findOfficialLgdVillageSync, loadLgdStateVillages } from './lgdCache';
import { loadCollectionFromVault } from './localVault';
import {
  subscribeSecondaryCollection,
  fetchSecondaryCollection,
  bootstrapCollectionToSecondary,
  pushToSecondary,
  SecondaryDeltaEvent,
} from './secondaryDb';

const TAB_STALE_PULL_MS = 12000;

interface StoreChannel<T> {
  data: T;
  loaded: boolean;
  subscribers: Set<(val: T, loaded: boolean) => void>;
  unsub: (() => void) | null;
  secUnsub: (() => void) | null;
  secPulledOnce?: boolean;
  lastSecPullAtMs: number;
  lingerTimer: ReturnType<typeof setTimeout> | null;
  docMap: Map<string, any>;
  archivedIds: Set<string>;
  secIds: Set<string>;
  hasServerSnapshot?: boolean;
}

function createChannel<T>(initial: T): StoreChannel<T> {
  const docMap = new Map<string, any>();
  if (Array.isArray(initial)) {
    initial.forEach((it: any) => {
      const id = it?.id || it?.uid;
      if (id && !isRecordDeleted(it)) {
        docMap.set(String(id), { ...it, id: String(id) });
      }
    });
  }
  return {
    data: initial,
    loaded: false,
    subscribers: new Set(),
    unsub: null,
    secUnsub: null,
    secPulledOnce: false,
    lastSecPullAtMs: 0,
    lingerTimer: null,
    docMap,
    archivedIds: new Set(),
    secIds: new Set(),
    hasServerSnapshot: false,
  };
}

function getDocSyncTs(docObj: any): number {
  if (!docObj) return 0;
  return Math.max(
    Number(docObj._syncUpdatedAtMs) || 0,
    toTimestampMs(docObj.updatedAt || docObj.markedAt || docObj.createdAt)
  );
}

function getContentTs(docObj: any): number {
  if (!docObj) return 0;
  return toTimestampMs(docObj.updatedAt || docObj.markedAt || docObj.createdAt);
}

function shouldSecondaryDocWin(
  existing: any,
  incoming: any,
  ch: StoreChannel<any[]>,
  id: string,
  pendingMap: Map<string, { ts: number; needsFirebase: boolean; needsSecondary: boolean; deleted: boolean }>
): boolean {
  const incomingTs = getDocSyncTs(incoming);
  const pendingMeta = pendingMap.get(id);
  if (pendingMeta && pendingMeta.needsSecondary && pendingMeta.ts > incomingTs) {
    return false;
  }
  if (!existing) return true;
  const existingTs = getDocSyncTs(existing);
  // Protect live Firestore docs against synthetic SQLite timestamps unless failover or strictly newer content timestamp
  if (
    ch.hasServerSnapshot &&
    !isQuotaBlocked() &&
    !ch.secIds.has(id) &&
    incoming?._syncSource !== 'secondary_failover'
  ) {
    const existingContentTs = getContentTs(existing);
    const incomingContentTs = getContentTs(incoming);
    if (existingContentTs > 0 && incomingContentTs > 0) {
      return incomingContentTs > existingContentTs;
    }
    if (existingContentTs > 0 && incomingContentTs === 0) {
      return false;
    }
  }
  return incomingTs > existingTs;
}

function notifyChannel<T>(ch: StoreChannel<T>, next: T, loaded = true) {
  ch.data = next;
  ch.loaded = Boolean(loaded || ch.loaded);
  ch.subscribers.forEach((cb) => cb(next, ch.loaded));
}

function subscribeChannel<T>(
  ch: StoreChannel<T>,
  starter: () => void,
  onChange: (val: T, loaded: boolean) => void
): () => void {
  if (ch.lingerTimer) {
    clearTimeout(ch.lingerTimer);
    ch.lingerTimer = null;
  }
  // If user switched tabs and returns after >12s, refresh from Secondary DB without re-reading Firebase
  if (ch.secPulledOnce && Date.now() - ch.lastSecPullAtMs > TAB_STALE_PULL_MS) {
    ch.secPulledOnce = false;
  }
  ch.subscribers.add(onChange);
  starter();
  onChange(ch.data, ch.loaded);

  return () => {
    ch.subscribers.delete(onChange);
    // Keep session onSnapshot & SSE listeners warm across tab switches so Firebase NEVER re-reads entire collections!
  };
}

function isQuotaError(err: any): boolean {
  return isQuotaExceededError(err);
}

function applyIncrementalSnapshot(
  ch: StoreChannel<any[]>,
  colName: string,
  snap: any,
  queryLimit = 0
): { items: any[]; changedCount: number; skipNotify?: boolean } {
  const changes = typeof snap.docChanges === 'function' ? snap.docChanges() : [];
  let changedCount = changes.length;
  const fromCache = Boolean(snap?.metadata?.fromCache);
  if (fromCache && (!snap?.docs || snap.docs.length === 0) && !ch.hasServerSnapshot) {
    // Do not wipe cache or flip loaded=true from an empty Firestore IndexedDB cache snapshot
    return { items: Array.from(ch.docMap.values()), changedCount: 0, skipNotify: true };
  }
  const pendingMap = getPendingSyncMap(colName);

  const upsertWithLww = (id: string, data: any) => {
    const pendingMeta = pendingMap.get(id);
    if (isRecordDeleted(data)) {
      const archTs = toTimestampMs(data.archivedAt || data.updatedAt || data._syncUpdatedAtMs);
      if (pendingMeta && pendingMeta.needsFirebase && !pendingMeta.deleted) {
        if (pendingMeta.ts > archTs) return;
      }
      ch.archivedIds.add(id);
      ch.secIds.delete(id);
      ch.docMap.delete(id);
      removeFromCollectionCache(colName, id);
      return;
    }

    ch.archivedIds.delete(id);
    const incoming = { ...data, id };
    const existing = ch.docMap.get(id);
    if (colName === 'travel_sheets' && existing && Array.isArray(existing.rows) && Array.isArray(incoming.rows)) {
      const mergedTravel = mergeTravelSheetDocs(existing, incoming);
      ch.secIds.delete(id);
      ch.docMap.set(id, mergedTravel);
      return;
    }
    if (existing) {
      const incomingTs = getDocSyncTs(incoming);
      const existingTs = getDocSyncTs(existing);
      if (pendingMeta && pendingMeta.needsFirebase) {
        // Protect locally queued edits on THIS device that haven't finished syncing to Firebase yet
        if (pendingMeta.ts > incomingTs) return;
      } else if (fromCache) {
        if (existingTs >= incomingTs) return;
      } else if (
        ch.secIds.has(id) &&
        existing?._syncSource === 'secondary_failover' &&
        existingTs > incomingTs + 1500
      ) {
        // Only defer to Secondary DB when that write explicitly happened under Firebase failover and is strictly newer
        return;
      }
    }
    ch.secIds.delete(id);
    ch.docMap.set(id, incoming);
  };

  if (!fromCache && !ch.hasServerSnapshot && Array.isArray(snap.docs)) {
    // First authoritative server snapshot: only prune truly archived or temp items; NEVER drop active Secondary/offline docs
    ch.hasServerSnapshot = true;
    const isFullServerView = !queryLimit || snap.docs.length < queryLimit;
    if (isFullServerView) {
      const serverIds = new Set<string>(snap.docs.map((d: any) => String(d.id)));
      Array.from(ch.docMap.keys()).forEach((existingId) => {
        if (serverIds.has(existingId)) return;
        const pendingMeta = pendingMap.get(existingId);
        const existing = ch.docMap.get(existingId);
        const isProtectedSecondaryOrPending =
          (pendingMeta && pendingMeta.needsFirebase) ||
          ch.secIds.has(existingId) ||
          Boolean(existing?._localSavedAt) ||
          existing?._syncSource === 'secondary_failover' ||
          colName === 'travel_sheets';
        if (!isProtectedSecondaryOrPending || isRecordDeleted(existing) || ch.archivedIds.has(existingId)) {
          ch.docMap.delete(existingId);
          ch.secIds.delete(existingId);
          removeFromCollectionCache(colName, existingId);
        }
      });
    }
    snap.docs.forEach((d: any) => upsertWithLww(d.id, d.data()));
    changedCount = snap.docs.length || 1;
  } else if (ch.docMap.size === 0 && snap.docs) {
    snap.docs.forEach((d: any) => upsertWithLww(d.id, d.data()));
    changedCount = snap.docs.length || 1;
  } else {
    changes.forEach((change: any) => {
      const id = change.doc.id;
      if (change.type === 'removed') {
        const pendingMeta = pendingMap.get(id);
        if (!pendingMeta?.needsFirebase && !ch.secIds.has(id) && colName !== 'travel_sheets') {
          ch.docMap.delete(id);
          ch.secIds.delete(id);
          ch.archivedIds.add(id);
          removeFromCollectionCache(colName, id);
        }
      } else {
        upsertWithLww(id, change.doc.data());
      }
    });
  }

  trackFirestoreUsage('read', Math.max(1, changedCount));
  return { items: Array.from(ch.docMap.values()), changedCount };
}

function applySecondaryDeltas(
  ch: StoreChannel<any[]>,
  colName: string,
  events: SecondaryDeltaEvent[]
): any[] | null {
  let mutated = false;
  const pendingMap = getPendingSyncMap(colName);
  events.forEach((evt) => {
    if (!evt || evt.collection !== colName || !evt.id) return;
    const evtTs = Number(evt.updatedAtMs) || 0;
    const pendingMeta = pendingMap.get(evt.id);
    if (pendingMeta && pendingMeta.needsSecondary && pendingMeta.ts > evtTs) {
      return;
    }

    if (evt.deleted || isRecordDeleted(evt.doc)) {
      ch.secIds.delete(evt.id);
      if (ch.docMap.has(evt.id) || !ch.archivedIds.has(evt.id)) {
        ch.docMap.delete(evt.id);
        ch.archivedIds.add(evt.id);
        removeFromCollectionCache(colName, evt.id);
        mutated = true;
      }
      return;
    }

    if (evt.doc) {
      const incoming: Record<string, any> = {
        ...evt.doc,
        id: evt.id,
        ...(evt.updatedAtMs ? { _syncUpdatedAtMs: evt.updatedAtMs } : {}),
      };
      const existing = ch.docMap.get(evt.id);
      if (colName === 'travel_sheets' && existing && Array.isArray(existing.rows) && Array.isArray(incoming.rows)) {
        const mergedTravel = mergeTravelSheetDocs(existing, incoming);
        if (JSON.stringify(existing) !== JSON.stringify(mergedTravel)) {
          ch.secIds.add(evt.id);
          ch.archivedIds.delete(evt.id);
          ch.docMap.set(evt.id, mergedTravel);
          mutated = true;
        }
      } else if (shouldSecondaryDocWin(existing, incoming, ch, evt.id, pendingMap)) {
        ch.secIds.add(evt.id);
        ch.archivedIds.delete(evt.id);
        ch.docMap.set(
          evt.id,
          existing && existing.createdAt && !incoming.createdAt
            ? { createdAt: existing.createdAt, ...incoming }
            : incoming
        );
        mutated = true;
      }
    }
  });

  if (!mutated) return null;
  return Array.from(ch.docMap.values());
}

async function pullSecondaryIntoChannel(
  ch: StoreChannel<any[]>,
  colName: string,
  transform: (items: any[], archivedIds: Set<string>, authoritative: boolean) => any[]
) {
  ch.lastSecPullAtMs = Date.now();
  const pendingMap = getPendingSyncMap(colName);
  try {
    const sec = await fetchSecondaryCollection(colName, { limit: 5000 });
    if (sec.ok) {
      sec.archivedIds.forEach((id) => {
        const pendingMeta = pendingMap.get(id);
        if (pendingMeta && pendingMeta.needsSecondary && !pendingMeta.deleted) return;
        ch.archivedIds.add(id);
        ch.secIds.delete(id);
        ch.docMap.delete(id);
        removeFromCollectionCache(colName, id);
      });
      sec.items.forEach((it) => {
        if (!it || !it.id) return;
        const existing = ch.docMap.get(it.id);
        if (colName === 'travel_sheets' && existing && Array.isArray(existing.rows) && Array.isArray(it.rows)) {
          ch.secIds.add(it.id);
          ch.archivedIds.delete(it.id);
          ch.docMap.set(it.id, mergeTravelSheetDocs(existing, it));
          return;
        }
        if (shouldSecondaryDocWin(existing, it, ch, it.id, pendingMap)) {
          ch.secIds.add(it.id);
          ch.archivedIds.delete(it.id);
          ch.docMap.set(
            it.id,
            existing && existing.createdAt && !it.createdAt
              ? { createdAt: existing.createdAt, ...it }
              : it
          );
        }
      });
      if (sec.items.length > 0 || sec.archivedIds.length > 0 || ch.docMap.size > 0 || isQuotaBlocked()) {
        const finalList = transform(Array.from(ch.docMap.values()), ch.archivedIds, false);
        notifyChannel(ch, finalList, true);
        if (sec.items.length > 0) return;
      }
    }
  } catch {}

  // Fallback to IndexedDB vault — always respect strict LWW & live server docs
  try {
    const vaultMap = await loadCollectionFromVault(colName);
    if (vaultMap) {
      const vaultItems = Object.values(vaultMap).filter((it: any) => it && !isRecordDeleted(it));
      if (vaultItems.length > 0) {
        vaultItems.forEach((it: any) => {
          const id = String(it?.id || it?.uid || '').trim();
          if (!id || ch.archivedIds.has(id)) return;
          const existing = ch.docMap.get(id);
          if (colName === 'travel_sheets' && existing && Array.isArray(existing.rows) && Array.isArray(it.rows)) {
            ch.docMap.set(id, mergeTravelSheetDocs(existing, { ...it, id }));
            return;
          }
          if (shouldSecondaryDocWin(existing, { ...it, id }, ch, id, pendingMap)) {
            ch.docMap.set(
              id,
              existing && existing.createdAt && !it.createdAt
                ? { createdAt: existing.createdAt, ...it, id }
                : { ...it, id }
            );
          }
        });
        const finalList = transform(Array.from(ch.docMap.values()), ch.archivedIds, false);
        notifyChannel(ch, finalList, true);
      }
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// 1. SHARED USERS STORE (Primary + Secondary Real-Time Sync)
// ---------------------------------------------------------------------------
function loadInitialUsers(): UserProfile[] {
  try {
    if (typeof window === 'undefined') return [];
    const merged = mergeWithLocalData<any>('users', []);
    if (merged.length > 0) return merged as UserProfile[];
    const cached = localStorage.getItem('blackworm_cached_users');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed.filter((u: any) => u && !isRecordDeleted(u));
    }
  } catch {}
  return [];
}

const usersChannel = createChannel<UserProfile[]>(loadInitialUsers());

function sortUsers(list: UserProfile[]): UserProfile[] {
  return [...list].sort((a, b) => {
    const aCode = (a.userCode ? String(a.userCode) : '').replace(/\D/g, '');
    const bCode = (b.userCode ? String(b.userCode) : '').replace(/\D/g, '');
    const aNum = parseInt(aCode, 10);
    const bNum = parseInt(bCode, 10);
    if (!isNaN(aNum) && !isNaN(bNum) && aNum !== bNum) return aNum - bNum;
    if (a.role === 'owner' && b.role !== 'owner') return -1;
    if (b.role === 'owner' && a.role !== 'owner') return 1;
    return (a.fullName || '').localeCompare(b.fullName || '');
  });
}

function finalizeUsersList(rawItems: any[], archivedIds: Set<string>, authoritative: boolean): UserProfile[] {
  const normalized = rawItems.map((u: any) => ({ ...u, uid: u.uid || u.id, id: u.id || u.uid }));
  const merged = mergeWithLocalData<any>('users', normalized, {
    archivedIds,
    authoritativeServer: authoritative,
  }).map((u: any) => ({ ...u, uid: u.uid || u.id, id: u.id || u.uid }));
  const sorted = sortUsers(merged as UserProfile[]);
  safeLocalStorageSet('blackworm_cached_users', JSON.stringify(sorted));
  return sorted;
}

function startUsersListener() {
  ensureGlobalResyncListeners();
  if (!usersChannel.secUnsub) {
    usersChannel.secUnsub = subscribeSecondaryCollection('users', (events) => {
      const updated = applySecondaryDeltas(usersChannel, 'users', events);
      if (updated) {
        notifyChannel(usersChannel, finalizeUsersList(updated, usersChannel.archivedIds, false), true);
      }
    });
  }

  if (!usersChannel.secPulledOnce) {
    usersChannel.secPulledOnce = true;
    void pullSecondaryIntoChannel(usersChannel, 'users', finalizeUsersList);
  }

  if (usersChannel.unsub) return;
  if (isQuotaBlocked()) {
    void pullSecondaryIntoChannel(usersChannel, 'users', finalizeUsersList);
    return;
  }

  try {
    usersChannel.unsub = onSnapshot(
      collection(db, 'users'),
      (snap) => {
        const { items, skipNotify } = applyIncrementalSnapshot(usersChannel, 'users', snap);
        if (skipNotify) return;
        const sorted = finalizeUsersList(items, usersChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(usersChannel, sorted, true);
        if (!snap.metadata?.fromCache) {
          bootstrapCollectionToSecondary('users', sorted);
        }
      },
      (err) => {
        console.warn('Shared users sync notice:', err);
        if (usersChannel.unsub) {
          try { usersChannel.unsub(); } catch {}
          usersChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        void pullSecondaryIntoChannel(usersChannel, 'users', finalizeUsersList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared users listener:', e);
    usersChannel.unsub = null;
    void pullSecondaryIntoChannel(usersChannel, 'users', finalizeUsersList);
  }
}

export function useSharedUsers() {
  const [users, setUsers] = useState<UserProfile[]>(() => usersChannel.data);
  const [loaded, setLoaded] = useState<boolean>(() => usersChannel.loaded);

  useEffect(() => {
    return subscribeChannel(usersChannel, startUsersListener, (val, isLoaded) => {
      setUsers(val);
      setLoaded(isLoaded);
    });
  }, []);

  const officers = users.filter((u) => u.role !== 'dealer');
  const fieldOfficers = users.filter((u) => u.role !== 'dealer' && u.role !== 'owner');
  const usersMap: Record<string, string> = {};
  users.forEach((u) => {
    const id = u.uid || (u as any).id;
    if (u.fullName && id) {
      usersMap[id] = u.fullName;
      if (u.loginId) usersMap[String(u.loginId).toLowerCase()] = u.fullName;
      if (u.userCode) usersMap[String(u.userCode).toLowerCase()] = u.fullName;
    }
  });

  const setUsersOptimistic = (updater: SetStateAction<UserProfile[]>) => {
    const nowMs = Date.now();
    const rawNext = typeof updater === 'function' ? updater(usersChannel.data) : updater;
    const next = sortUsers(rawNext);
    const nextIds = new Set<string>();
    next.forEach((u: any) => {
      const id = u?.uid || u?.id;
      if (id) {
        nextIds.add(String(id));
        usersChannel.archivedIds.delete(id);
        usersChannel.docMap.set(id, { ...u, id, uid: id, _syncUpdatedAtMs: Math.max(Number(u._syncUpdatedAtMs) || 0, nowMs) });
      }
    });
    Array.from(usersChannel.docMap.keys()).forEach((k) => {
      if (!nextIds.has(k)) {
        usersChannel.docMap.delete(k);
        usersChannel.secIds.delete(k);
        usersChannel.archivedIds.add(k);
      }
    });
    safeLocalStorageSet('blackworm_cached_users', JSON.stringify(next));
    notifyChannel(usersChannel, next, usersChannel.loaded);
  };

  return { users, officers, fieldOfficers, usersMap, loaded, setUsersOptimistic };
}

// ---------------------------------------------------------------------------
// 2. SHARED DEALERS STORE (Primary + Secondary Real-Time Sync)
// ---------------------------------------------------------------------------
function loadInitialDealers(): any[] {
  try {
    if (typeof window === 'undefined') return [];
    const local = mergeWithLocalData<any>('dealers_application', []);
    if (local.length > 0) return deduplicateDealers(local);
    const cached = localStorage.getItem('blackworm_all_dealers');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return deduplicateDealers(parsed);
    }
  } catch {}
  return [];
}

const dealersChannel = createChannel<any[]>(loadInitialDealers());

function sortDealers(list: any[]): any[] {
  return [...list].sort((a, b) => {
    const numA = parseInt(String(a.dealerCode || '').replace(/\D/g, ''), 10) || 0;
    const numB = parseInt(String(b.dealerCode || '').replace(/\D/g, ''), 10) || 0;
    if (numA !== numB) return numB - numA;
    return toTimestampMs(b.createdAt) - toTimestampMs(a.createdAt);
  });
}

function finalizeDealersList(rawItems: any[], archivedIds: Set<string>, authoritative: boolean): any[] {
  const merged = mergeWithLocalData<any>('dealers_application', rawItems, {
    archivedIds,
    authoritativeServer: authoritative,
  });
  const sorted = sortDealers(deduplicateDealers(merged));
  safeLocalStorageSet('blackworm_all_dealers', JSON.stringify(sorted));
  return sorted;
}

function startDealersListener() {
  ensureGlobalResyncListeners();
  if (!dealersChannel.secUnsub) {
    dealersChannel.secUnsub = subscribeSecondaryCollection('dealers_application', (events) => {
      const updated = applySecondaryDeltas(dealersChannel, 'dealers_application', events);
      if (updated) {
        notifyChannel(dealersChannel, finalizeDealersList(updated, dealersChannel.archivedIds, false), true);
      }
    });
  }

  if (!dealersChannel.secPulledOnce) {
    dealersChannel.secPulledOnce = true;
    void pullSecondaryIntoChannel(dealersChannel, 'dealers_application', finalizeDealersList);
  }

  if (dealersChannel.unsub) return;
  if (isQuotaBlocked()) {
    void pullSecondaryIntoChannel(dealersChannel, 'dealers_application', finalizeDealersList);
    return;
  }

  try {
    const q = query(collection(db, 'dealers_application'), limit(1000));
    dealersChannel.unsub = onSnapshot(
      q,
      (snap) => {
        const { items, skipNotify } = applyIncrementalSnapshot(dealersChannel, 'dealers_application', snap, 1000);
        if (skipNotify) return;
        const sorted = finalizeDealersList(items, dealersChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(dealersChannel, sorted, true);
        if (!snap.metadata?.fromCache) {
          bootstrapCollectionToSecondary('dealers_application', sorted);
        }
      },
      (err) => {
        console.warn('Shared dealers sync notice:', err);
        if (dealersChannel.unsub) {
          try { dealersChannel.unsub(); } catch {}
          dealersChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        void pullSecondaryIntoChannel(dealersChannel, 'dealers_application', finalizeDealersList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared dealers listener:', e);
    dealersChannel.unsub = null;
    void pullSecondaryIntoChannel(dealersChannel, 'dealers_application', finalizeDealersList);
  }
}

export function useSharedDealers() {
  const [dealers, setDealers] = useState<any[]>(() => dealersChannel.data);
  const [loaded, setLoaded] = useState<boolean>(() => dealersChannel.loaded);

  useEffect(() => {
    return subscribeChannel(dealersChannel, startDealersListener, (val, isLoaded) => {
      setDealers(val);
      setLoaded(isLoaded);
    });
  }, []);

  const updateLocalDealersOptimistic = (updater: SetStateAction<any[]>) => {
    const nowMs = Date.now();
    const rawNext = typeof updater === 'function' ? updater(dealersChannel.data) : updater;
    const next = sortDealers(deduplicateDealers(rawNext));
    const nextIds = new Set<string>();
    next.forEach((d: any) => {
      if (d?.id) {
        nextIds.add(d.id);
        dealersChannel.archivedIds.delete(d.id);
        dealersChannel.docMap.set(d.id, { ...d, _syncUpdatedAtMs: Math.max(Number(d._syncUpdatedAtMs) || 0, nowMs) });
      }
    });
    Array.from(dealersChannel.docMap.keys()).forEach((k) => {
      if (!nextIds.has(k)) dealersChannel.docMap.delete(k);
    });
    safeLocalStorageSet('blackworm_all_dealers', JSON.stringify(next));
    notifyChannel(dealersChannel, next, dealersChannel.loaded);
  };

  return { dealers, loaded, setDealersOptimistic: updateLocalDealersOptimistic };
}

// ---------------------------------------------------------------------------
// 3. SHARED ORDERS STORE (Primary + Secondary Real-Time Sync)
// ---------------------------------------------------------------------------
function loadInitialOrders(): any[] {
  try {
    if (typeof window === 'undefined') return [];
    const local = mergeWithLocalData<any>('orders', []);
    return deduplicateOrders(local).sort((a, b) => toTimestampMs(b.createdAt) - toTimestampMs(a.createdAt));
  } catch {}
  return [];
}

const ordersChannel = createChannel<any[]>(loadInitialOrders());

function finalizeOrdersList(rawItems: any[], archivedIds: Set<string>, authoritative: boolean): any[] {
  const merged = mergeWithLocalData<any>('orders', rawItems, {
    archivedIds,
    authoritativeServer: authoritative,
  });
  return deduplicateOrders(merged).sort((a, b) => toTimestampMs(b.createdAt) - toTimestampMs(a.createdAt));
}

function startOrdersListener() {
  ensureGlobalResyncListeners();
  if (!ordersChannel.secUnsub) {
    ordersChannel.secUnsub = subscribeSecondaryCollection('orders', (events) => {
      const updated = applySecondaryDeltas(ordersChannel, 'orders', events);
      if (updated) {
        notifyChannel(ordersChannel, finalizeOrdersList(updated, ordersChannel.archivedIds, false), true);
      }
    });
  }

  if (!ordersChannel.secPulledOnce) {
    ordersChannel.secPulledOnce = true;
    void pullSecondaryIntoChannel(ordersChannel, 'orders', finalizeOrdersList);
  }

  if (ordersChannel.unsub) return;
  if (isQuotaBlocked()) {
    void pullSecondaryIntoChannel(ordersChannel, 'orders', finalizeOrdersList);
    return;
  }

  try {
    const q = query(collection(db, 'orders'), limit(1000));
    ordersChannel.unsub = onSnapshot(
      q,
      (snap) => {
        const { items, skipNotify } = applyIncrementalSnapshot(ordersChannel, 'orders', snap, 1000);
        if (skipNotify) return;
        const sorted = finalizeOrdersList(items, ordersChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(ordersChannel, sorted, true);
        if (!snap.metadata?.fromCache) {
          bootstrapCollectionToSecondary('orders', sorted);
        }
      },
      (err) => {
        console.warn('Shared orders sync notice:', err);
        if (ordersChannel.unsub) {
          try { ordersChannel.unsub(); } catch {}
          ordersChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        void pullSecondaryIntoChannel(ordersChannel, 'orders', finalizeOrdersList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared orders listener:', e);
    ordersChannel.unsub = null;
    void pullSecondaryIntoChannel(ordersChannel, 'orders', finalizeOrdersList);
  }
}

export function useSharedOrders() {
  const [orders, setOrders] = useState<any[]>(() => ordersChannel.data);
  const [loaded, setLoaded] = useState<boolean>(() => ordersChannel.loaded);

  useEffect(() => {
    return subscribeChannel(ordersChannel, startOrdersListener, (val, isLoaded) => {
      setOrders(val);
      setLoaded(isLoaded);
    });
  }, []);

  const setOrdersOptimistic = (updater: SetStateAction<any[]>) => {
    const nowMs = Date.now();
    const rawNext = typeof updater === 'function' ? updater(ordersChannel.data) : updater;
    const next = deduplicateOrders(rawNext).sort(
      (a, b) => toTimestampMs(b.createdAt) - toTimestampMs(a.createdAt)
    );
    const nextIds = new Set<string>();
    next.forEach((o: any) => {
      if (o?.id) {
        nextIds.add(o.id);
        ordersChannel.archivedIds.delete(o.id);
        ordersChannel.docMap.set(o.id, { ...o, _syncUpdatedAtMs: Math.max(Number(o._syncUpdatedAtMs) || 0, nowMs) });
      }
    });
    Array.from(ordersChannel.docMap.keys()).forEach((k) => {
      if (!nextIds.has(k)) ordersChannel.docMap.delete(k);
    });
    notifyChannel(ordersChannel, next, ordersChannel.loaded);
  };

  return { orders, loaded, setOrdersOptimistic };
}

// ---------------------------------------------------------------------------
// 4. SHARED COLLECTION ENTRIES STORE (Primary + Secondary Real-Time Sync)
// ---------------------------------------------------------------------------
function loadInitialCollections(): any[] {
  try {
    if (typeof window === 'undefined') return [];
    const local = mergeWithLocalData<any>('collection_entries', []);
    return deduplicateCollections(local).sort(
      (a, b) => toTimestampMs(b.createdAt || b.date) - toTimestampMs(a.createdAt || a.date)
    );
  } catch {}
  return [];
}

const collectionsChannel = createChannel<any[]>(loadInitialCollections());

function finalizeCollectionsList(rawItems: any[], archivedIds: Set<string>, authoritative: boolean): any[] {
  const merged = mergeWithLocalData<any>('collection_entries', rawItems, {
    archivedIds,
    authoritativeServer: authoritative,
  });
  return deduplicateCollections(merged).sort(
    (a, b) => toTimestampMs(b.createdAt || b.date) - toTimestampMs(a.createdAt || a.date)
  );
}

function startCollectionsListener() {
  ensureGlobalResyncListeners();
  if (!collectionsChannel.secUnsub) {
    collectionsChannel.secUnsub = subscribeSecondaryCollection('collection_entries', (events) => {
      const updated = applySecondaryDeltas(collectionsChannel, 'collection_entries', events);
      if (updated) {
        notifyChannel(collectionsChannel, finalizeCollectionsList(updated, collectionsChannel.archivedIds, false), true);
      }
    });
  }

  if (!collectionsChannel.secPulledOnce) {
    collectionsChannel.secPulledOnce = true;
    void pullSecondaryIntoChannel(collectionsChannel, 'collection_entries', finalizeCollectionsList);
  }

  if (collectionsChannel.unsub) return;
  if (isQuotaBlocked()) {
    void pullSecondaryIntoChannel(collectionsChannel, 'collection_entries', finalizeCollectionsList);
    return;
  }

  try {
    const q = query(collection(db, 'collection_entries'), limit(1000));
    collectionsChannel.unsub = onSnapshot(
      q,
      (snap) => {
        const { items, skipNotify } = applyIncrementalSnapshot(collectionsChannel, 'collection_entries', snap, 1000);
        if (skipNotify) return;
        const sorted = finalizeCollectionsList(items, collectionsChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(collectionsChannel, sorted, true);
        if (!snap.metadata?.fromCache) {
          bootstrapCollectionToSecondary('collection_entries', sorted);
        }
      },
      (err) => {
        console.warn('Shared collections sync notice:', err);
        if (collectionsChannel.unsub) {
          try { collectionsChannel.unsub(); } catch {}
          collectionsChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        void pullSecondaryIntoChannel(collectionsChannel, 'collection_entries', finalizeCollectionsList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared collections listener:', e);
    collectionsChannel.unsub = null;
    void pullSecondaryIntoChannel(collectionsChannel, 'collection_entries', finalizeCollectionsList);
  }
}

export function useSharedCollectionEntries() {
  const [collectionEntries, setCollectionEntries] = useState<any[]>(() => collectionsChannel.data);
  const [loaded, setLoaded] = useState<boolean>(() => collectionsChannel.loaded);

  useEffect(() => {
    return subscribeChannel(collectionsChannel, startCollectionsListener, (val, isLoaded) => {
      setCollectionEntries(val);
      setLoaded(isLoaded);
    });
  }, []);

  const setCollectionsOptimistic = (updater: SetStateAction<any[]>) => {
    const nowMs = Date.now();
    const rawNext = typeof updater === 'function' ? updater(collectionsChannel.data) : updater;
    const next = deduplicateCollections(rawNext).sort(
      (a, b) => toTimestampMs(b.createdAt || b.date) - toTimestampMs(a.createdAt || a.date)
    );
    const nextIds = new Set<string>();
    next.forEach((c: any) => {
      if (c?.id) {
        nextIds.add(c.id);
        collectionsChannel.archivedIds.delete(c.id);
        collectionsChannel.docMap.set(c.id, { ...c, _syncUpdatedAtMs: Math.max(Number(c._syncUpdatedAtMs) || 0, nowMs) });
      }
    });
    Array.from(collectionsChannel.docMap.keys()).forEach((k) => {
      if (!nextIds.has(k)) collectionsChannel.docMap.delete(k);
    });
    notifyChannel(collectionsChannel, next, collectionsChannel.loaded);
  };

  return { collectionEntries, loaded, setCollectionsOptimistic };
}

// ---------------------------------------------------------------------------
// 5. SHARED YEARLY TARGETS STORE (Primary + Secondary Real-Time Sync)
// ---------------------------------------------------------------------------
function loadInitialYearlyTargets(): any[] {
  try {
    if (typeof window === 'undefined') return [];
    return mergeWithLocalData<any>('yearly_targets', []);
  } catch {}
  return [];
}

const yearlyTargetsChannel = createChannel<any[]>(loadInitialYearlyTargets());

function finalizeYearlyTargetsList(rawItems: any[], archivedIds: Set<string>, authoritative: boolean): any[] {
  return mergeWithLocalData<any>('yearly_targets', rawItems, {
    archivedIds,
    authoritativeServer: authoritative,
  }).map((t: any) => ({ ...t, _id: t._id || t.id }));
}

function startYearlyTargetsListener() {
  ensureGlobalResyncListeners();
  if (!yearlyTargetsChannel.secUnsub) {
    yearlyTargetsChannel.secUnsub = subscribeSecondaryCollection('yearly_targets', (events) => {
      const updated = applySecondaryDeltas(yearlyTargetsChannel, 'yearly_targets', events);
      if (updated) {
        notifyChannel(yearlyTargetsChannel, finalizeYearlyTargetsList(updated, yearlyTargetsChannel.archivedIds, false), true);
      }
    });
  }

  if (!yearlyTargetsChannel.secPulledOnce) {
    yearlyTargetsChannel.secPulledOnce = true;
    void pullSecondaryIntoChannel(yearlyTargetsChannel, 'yearly_targets', finalizeYearlyTargetsList);
  }

  if (yearlyTargetsChannel.unsub) return;
  if (isQuotaBlocked()) {
    void pullSecondaryIntoChannel(yearlyTargetsChannel, 'yearly_targets', finalizeYearlyTargetsList);
    return;
  }

  try {
    yearlyTargetsChannel.unsub = onSnapshot(
      collection(db, 'yearly_targets'),
      (snap) => {
        const { items, skipNotify } = applyIncrementalSnapshot(yearlyTargetsChannel, 'yearly_targets', snap);
        if (skipNotify) return;
        const merged = finalizeYearlyTargetsList(items, yearlyTargetsChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(yearlyTargetsChannel, merged, true);
        if (!snap.metadata?.fromCache) {
          bootstrapCollectionToSecondary('yearly_targets', merged);
        }
      },
      (err) => {
        console.warn('Shared yearly_targets sync notice:', err);
        if (yearlyTargetsChannel.unsub) {
          try { yearlyTargetsChannel.unsub(); } catch {}
          yearlyTargetsChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        void pullSecondaryIntoChannel(yearlyTargetsChannel, 'yearly_targets', finalizeYearlyTargetsList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared yearly_targets listener:', e);
    yearlyTargetsChannel.unsub = null;
    void pullSecondaryIntoChannel(yearlyTargetsChannel, 'yearly_targets', finalizeYearlyTargetsList);
  }
}

export function useSharedYearlyTargets() {
  const [yearlyTargets, setYearlyTargets] = useState<any[]>(() => yearlyTargetsChannel.data);
  const [loaded, setLoaded] = useState<boolean>(() => yearlyTargetsChannel.loaded);

  useEffect(() => {
    return subscribeChannel(yearlyTargetsChannel, startYearlyTargetsListener, (val, isLoaded) => {
      setYearlyTargets(val);
      setLoaded(isLoaded);
    });
  }, []);

  const refreshYearlyTargetDocFromServer = async (docId: string) => {
    let fbData: any = null;
    let secData: any = null;

    await Promise.all([
      (async () => {
        if (isQuotaBlocked()) return;
        try {
          const docSnap = await getDocFromServer(doc(db, 'yearly_targets', docId));
          trackFirestoreUsage('read', 1);
          if (docSnap.exists()) {
            fbData = { ...docSnap.data(), id: docSnap.id, _id: docSnap.id };
          }
        } catch (err) {
          if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
          console.warn('Refresh target doc notice:', err);
        }
      })(),
      (async () => {
        try {
          const sec = await fetchSecondaryCollection('yearly_targets', { limit: 500 });
          if (sec.ok) {
            const found = sec.items.find((it) => it.id === docId);
            if (found) secData = { ...found, _id: found.id };
          }
        } catch {}
      })(),
    ]);

    const best =
      fbData && secData
        ? getDocSyncTs(secData) >= getDocSyncTs(fbData)
          ? { ...fbData, ...secData }
          : { ...secData, ...fbData }
        : secData || fbData;

    if (best) {
      const existing = yearlyTargetsChannel.docMap.get(docId);
      if (!existing || getDocSyncTs(best) >= getDocSyncTs(existing)) {
        yearlyTargetsChannel.docMap.set(docId, best);
      }
      const merged = finalizeYearlyTargetsList(
        Array.from(yearlyTargetsChannel.docMap.values()),
        yearlyTargetsChannel.archivedIds,
        false
      );
      notifyChannel(yearlyTargetsChannel, merged, true);
      return yearlyTargetsChannel.docMap.get(docId) || best;
    }
    return null;
  };

  const refreshAllYearlyTargetsFromServer = async () => {
    await Promise.all([
      (async () => {
        if (isQuotaBlocked() || yearlyTargetsChannel.unsub) return;
        try {
          const snap = await getDocsFromServer(collection(db, 'yearly_targets'));
          trackFirestoreUsage('read', Math.max(1, snap.docs.length));
          snap.docs.forEach((d) => {
            const incoming = { ...d.data(), id: d.id, _id: d.id };
            yearlyTargetsChannel.docMap.set(d.id, incoming);
          });
        } catch (err) {
          if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
          console.warn('Refresh all targets notice:', err);
        }
      })(),
      pullSecondaryIntoChannel(yearlyTargetsChannel, 'yearly_targets', finalizeYearlyTargetsList),
    ]);

    const merged = finalizeYearlyTargetsList(
      Array.from(yearlyTargetsChannel.docMap.values()),
      yearlyTargetsChannel.archivedIds,
      false
    );
    notifyChannel(yearlyTargetsChannel, merged, true);
  };

  const setYearlyTargetsOptimistic = (updater: SetStateAction<any[]>) => {
    const nowMs = Date.now();
    const rawNext = typeof updater === 'function' ? updater(yearlyTargetsChannel.data) : updater;
    const next = rawNext.map((t: any) => ({
      ...t,
      _id: t._id || t.id,
      _syncUpdatedAtMs: Math.max(Number(t._syncUpdatedAtMs) || 0, nowMs),
    }));
    next.forEach((t: any) => {
      const id = t?.id || t?._id;
      if (id) {
        yearlyTargetsChannel.archivedIds.delete(id);
        yearlyTargetsChannel.docMap.set(id, t);
      }
    });
    notifyChannel(yearlyTargetsChannel, next, true);
  };

  return {
    yearlyTargets,
    loaded,
    setYearlyTargetsOptimistic,
    refreshYearlyTargetDocFromServer,
    refreshAllYearlyTargetsFromServer,
  };
}

export function findYearlySheetForUser<T extends { id?: string; userId?: string; loginId?: string; fullName?: string }>(
  sheets: T[],
  user: Partial<UserProfile> | null | undefined,
  yearKey = '2026_27'
): T | undefined {
  if (!sheets || sheets.length === 0 || !user) return undefined;
  const uid = String(user.uid || '').trim();
  const uidLower = uid.toLowerCase();
  const loginLower = String(user.loginId || '').trim().toLowerCase();
  const nameUpper = String(user.fullName || '').trim().toUpperCase();

  if (uid) {
    const exactId = `yearly_${uid}_${yearKey}`;
    const byId = sheets.find((s) => s && s.id === exactId);
    if (byId) return byId;
  }
  if (uidLower) {
    const byUid = sheets.find((s) => s && String(s.userId || '').trim().toLowerCase() === uidLower);
    if (byUid) return byUid;
  }
  if (loginLower) {
    const byLogin = sheets.find(
      (s) =>
        s &&
        (String(s.loginId || '').trim().toLowerCase() === loginLower ||
          String(s.userId || '').trim().toLowerCase() === loginLower ||
          s.id === `yearly_${loginLower}_${yearKey}`)
    );
    if (byLogin) return byLogin;
  }
  if (nameUpper) {
    return sheets.find((s) => s && String(s.fullName || '').trim().toUpperCase() === nameUpper);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 6. SHARED TRAVEL SHEETS STORE (Primary + Secondary Real-Time Sync)
// ---------------------------------------------------------------------------
function loadInitialTravelSheets(): any[] {
  try {
    if (typeof window === 'undefined') return [];
    const local = mergeWithLocalData<any>('travel_sheets', []);
    if (local.length > 0) return local;
    const raw = localStorage.getItem('blackworm_cached_travel_sheets');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((s: any) => s && !isRecordDeleted(s));
    }
  } catch {}
  return [];
}

const travelSheetsChannel = createChannel<any[]>(loadInitialTravelSheets());

function finalizeTravelSheetsList(rawItems: any[], archivedIds: Set<string>, authoritative: boolean): any[] {
  const merged = mergeWithLocalData<any>('travel_sheets', rawItems, {
    archivedIds,
    authoritativeServer: authoritative,
  }).map((s: any) => ({ ...s, _id: s._id || s.id }));
  // Reconcile any matching sheet IDs non-destructively so rows are never dropped
  const byId = new Map<string, any>();
  merged.forEach((s: any) => {
    const id = String(s?.id || s?._id || '').trim();
    if (!id || isRecordDeleted(s)) return;
    const existing = byId.get(id);
    byId.set(id, existing ? mergeTravelSheetDocs(existing, s) : s);
  });
  const finalList = Array.from(byId.values());
  safeLocalStorageSet('blackworm_cached_travel_sheets', JSON.stringify(finalList));
  return finalList;
}

function startTravelSheetsListener() {
  ensureGlobalResyncListeners();
  if (!travelSheetsChannel.secUnsub) {
    travelSheetsChannel.secUnsub = subscribeSecondaryCollection('travel_sheets', (events) => {
      const updated = applySecondaryDeltas(travelSheetsChannel, 'travel_sheets', events);
      if (updated) {
        notifyChannel(travelSheetsChannel, finalizeTravelSheetsList(updated, travelSheetsChannel.archivedIds, false), true);
      }
    });
  }

  if (!travelSheetsChannel.secPulledOnce) {
    travelSheetsChannel.secPulledOnce = true;
    void pullSecondaryIntoChannel(travelSheetsChannel, 'travel_sheets', finalizeTravelSheetsList);
  }

  if (travelSheetsChannel.unsub) return;
  if (isQuotaBlocked()) {
    void pullSecondaryIntoChannel(travelSheetsChannel, 'travel_sheets', finalizeTravelSheetsList);
    return;
  }

  try {
    travelSheetsChannel.unsub = onSnapshot(
      collection(db, 'travel_sheets'),
      (snap) => {
        const { items, skipNotify } = applyIncrementalSnapshot(travelSheetsChannel, 'travel_sheets', snap);
        if (skipNotify) return;
        const merged = finalizeTravelSheetsList(items, travelSheetsChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(travelSheetsChannel, merged, true);
        if (!snap.metadata?.fromCache) {
          bootstrapCollectionToSecondary('travel_sheets', merged);
        }
      },
      (err) => {
        console.warn('Shared travel_sheets sync notice:', err);
        if (travelSheetsChannel.unsub) {
          try { travelSheetsChannel.unsub(); } catch {}
          travelSheetsChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        void pullSecondaryIntoChannel(travelSheetsChannel, 'travel_sheets', finalizeTravelSheetsList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared travel_sheets listener:', e);
    travelSheetsChannel.unsub = null;
    void pullSecondaryIntoChannel(travelSheetsChannel, 'travel_sheets', finalizeTravelSheetsList);
  }
}

export function useSharedTravelSheets() {
  const [travelSheets, setTravelSheets] = useState<any[]>(() => travelSheetsChannel.data);
  const [loaded, setLoaded] = useState<boolean>(() => travelSheetsChannel.loaded);

  useEffect(() => {
    return subscribeChannel(travelSheetsChannel, startTravelSheetsListener, (val, isLoaded) => {
      setTravelSheets(val);
      setLoaded(isLoaded);
    });
  }, []);

  const setTravelSheetsOptimistic = (updater: SetStateAction<any[]>) => {
    const nowMs = Date.now();
    const rawNext = typeof updater === 'function' ? updater(travelSheetsChannel.data) : updater;
    const next = rawNext.map((s: any) => ({
      ...s,
      _id: s._id || s.id,
      _syncUpdatedAtMs: Math.max(Number(s._syncUpdatedAtMs) || 0, nowMs),
    }));
    next.forEach((s: any) => {
      const id = s?.id || s?._id;
      if (id) {
        travelSheetsChannel.archivedIds.delete(id);
        travelSheetsChannel.docMap.set(id, s);
      }
    });
    safeLocalStorageSet('blackworm_cached_travel_sheets', JSON.stringify(next));
    notifyChannel(travelSheetsChannel, next, true);
  };

  return { travelSheets, loaded, setTravelSheetsOptimistic };
}

// ---------------------------------------------------------------------------
// 7. SHARED MASTER PRICELIST STORE (Primary + Secondary Real-Time Sync)
// ---------------------------------------------------------------------------
interface MasterPricelistState {
  products: any[];
  validityDate: string;
}

function loadInitialMasterPricelist(): MasterPricelistState {
  try {
    if (typeof window === 'undefined') return { products: [], validityDate: '' };
    const masterRaw = localStorage.getItem('blackworm_master_pricelist');
    if (masterRaw) {
      const parsed = JSON.parse(masterRaw);
      if (parsed && Array.isArray(parsed.products) && parsed.products.length > 0) {
        return {
          products: deduplicateProducts(parsed.products),
          validityDate: parsed.validityDate || '',
        };
      }
    }
    const cachedRaw = localStorage.getItem('blackworm_cached_pricelist');
    if (cachedRaw) {
      const parsed = JSON.parse(cachedRaw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { products: deduplicateProducts(parsed), validityDate: '' };
      }
    }
  } catch {}
  return { products: [], validityDate: '' };
}

const masterPricelistChannel = createChannel<MasterPricelistState>(loadInitialMasterPricelist());

let masterPricelistDocTs = 0;

function applyMasterPricelistDoc(data: any, authoritativeServer = false) {
  if (!data || !Array.isArray(data.products) || data.products.length === 0) return;
  const incomingTs = getDocSyncTs(data);
  if (!authoritativeServer && masterPricelistDocTs > 0 && incomingTs > 0 && masterPricelistDocTs > incomingTs + 500) {
    return;
  }
  if (incomingTs > 0) masterPricelistDocTs = incomingTs;
  const clean = deduplicateProducts(data.products.filter((p: any) => !isRecordDeleted(p)));
  const nextState: MasterPricelistState = {
    products: clean,
    validityDate: data.validityDate || '',
  };
  safeLocalStorageSet('blackworm_master_pricelist', JSON.stringify({ ...data, products: clean }));
  safeLocalStorageSet('blackworm_cached_pricelist', JSON.stringify(clean));
  notifyChannel(masterPricelistChannel, nextState, true);
}

function pullMasterPricelistFromSecondary() {
  void fetchSecondaryCollection('config', { limit: 50 }).then((res) => {
    if (!res.ok) return;
    const match = res.items.find((it) => it?.id === 'master_pricelist');
    if (match) applyMasterPricelistDoc(match);
  });
}

function startMasterPricelistListener() {
  ensureGlobalResyncListeners();
  if (!masterPricelistChannel.secUnsub) {
    masterPricelistChannel.secUnsub = subscribeSecondaryCollection('config', (events) => {
      events.forEach((evt) => {
        if (evt.id === 'master_pricelist' && evt.doc && !evt.deleted) {
          applyMasterPricelistDoc({ ...evt.doc, ...(evt.updatedAtMs ? { _syncUpdatedAtMs: evt.updatedAtMs } : {}) });
        }
      });
    });
  }

  if (!masterPricelistChannel.secPulledOnce) {
    masterPricelistChannel.secPulledOnce = true;
    pullMasterPricelistFromSecondary();
  }

  if (masterPricelistChannel.unsub) return;
  if (isQuotaBlocked()) {
    pullMasterPricelistFromSecondary();
    return;
  }

  try {
    masterPricelistChannel.unsub = onSnapshot(
      doc(db, 'config', 'master_pricelist'),
      (docSnap) => {
        trackFirestoreUsage('read', 1);
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data && Array.isArray(data.products) && data.products.length > 0) {
            applyMasterPricelistDoc(data, !docSnap.metadata?.fromCache);
            if (!docSnap.metadata?.fromCache) {
              void pushToSecondary({
                collection: 'config',
                id: 'master_pricelist',
                doc: { ...data, id: 'master_pricelist' },
                merge: true,
              });
            }
            return;
          }
        }
        notifyChannel(masterPricelistChannel, masterPricelistChannel.data, true);
      },
      (err) => {
        console.warn('Shared master_pricelist sync notice:', err);
        if (masterPricelistChannel.unsub) {
          try { masterPricelistChannel.unsub(); } catch {}
          masterPricelistChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        pullMasterPricelistFromSecondary();
      }
    );
  } catch (e) {
    console.warn('Failed to start shared master_pricelist listener:', e);
    masterPricelistChannel.unsub = null;
    pullMasterPricelistFromSecondary();
  }
}

export function setMasterPricelistStateOptimistic(products: any[], validityDate?: string) {
  const clean = deduplicateProducts((products || []).filter((p: any) => !isRecordDeleted(p)));
  const resolvedValidity = validityDate !== undefined ? validityDate : masterPricelistChannel.data.validityDate;
  masterPricelistDocTs = Date.now();
  const nextState: MasterPricelistState = {
    products: clean,
    validityDate: resolvedValidity,
  };
  safeLocalStorageSet(
    'blackworm_master_pricelist',
    JSON.stringify({
      products: clean,
      validityDate: resolvedValidity,
      updatedAt: new Date(masterPricelistDocTs).toISOString(),
      _syncUpdatedAtMs: masterPricelistDocTs,
    })
  );
  safeLocalStorageSet('blackworm_cached_pricelist', JSON.stringify(clean));
  notifyChannel(masterPricelistChannel, nextState, true);
}

export function useSharedMasterPricelist() {
  const [state, setState] = useState<MasterPricelistState>(() => masterPricelistChannel.data);
  const [loaded, setLoaded] = useState<boolean>(() => masterPricelistChannel.loaded);

  useEffect(() => {
    return subscribeChannel(masterPricelistChannel, startMasterPricelistListener, (val, isLoaded) => {
      setState(val);
      setLoaded(isLoaded);
    });
  }, []);

  return {
    products: state.products,
    validityDate: state.validityDate,
    loaded,
    setMasterPricelistOptimistic: setMasterPricelistStateOptimistic,
  };
}

// ---------------------------------------------------------------------------
// 8. SHARED OUTSTANDING RECORDS STORE (Primary + Secondary Real-Time Sync)
// ---------------------------------------------------------------------------
function loadInitialOutstanding(): any[] {
  try {
    if (typeof window === 'undefined') return [];
    const local = mergeWithLocalData<any>('outstanding_records', []);
    if (local.length > 0) return local;
    const raw = localStorage.getItem('blackworm_saved_outstanding_records');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((r: any) => r && !isRecordDeleted(r));
    }
  } catch {}
  return [];
}

const outstandingChannel = createChannel<any[]>(loadInitialOutstanding());

function finalizeOutstandingList(rawItems: any[], archivedIds: Set<string>, authoritative: boolean): any[] {
  const merged = mergeWithLocalData<any>('outstanding_records', rawItems, {
    archivedIds,
    authoritativeServer: authoritative,
  });
  safeLocalStorageSet('blackworm_saved_outstanding_records', JSON.stringify(merged));
  return merged;
}

function startOutstandingListener() {
  ensureGlobalResyncListeners();
  if (!outstandingChannel.secUnsub) {
    outstandingChannel.secUnsub = subscribeSecondaryCollection('outstanding_records', (events) => {
      const updated = applySecondaryDeltas(outstandingChannel, 'outstanding_records', events);
      if (updated) {
        notifyChannel(outstandingChannel, finalizeOutstandingList(updated, outstandingChannel.archivedIds, false), true);
      }
    });
  }

  if (!outstandingChannel.secPulledOnce) {
    outstandingChannel.secPulledOnce = true;
    void pullSecondaryIntoChannel(outstandingChannel, 'outstanding_records', finalizeOutstandingList);
  }

  if (outstandingChannel.unsub) return;
  if (isQuotaBlocked()) {
    void pullSecondaryIntoChannel(outstandingChannel, 'outstanding_records', finalizeOutstandingList);
    return;
  }

  try {
    const q = query(collection(db, 'outstanding_records'), limit(1000));
    outstandingChannel.unsub = onSnapshot(
      q,
      (snap) => {
        const { items, skipNotify } = applyIncrementalSnapshot(outstandingChannel, 'outstanding_records', snap, 1000);
        if (skipNotify) return;
        const merged = finalizeOutstandingList(items, outstandingChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(outstandingChannel, merged, true);
        if (!snap.metadata?.fromCache && merged.length > 0) {
          bootstrapCollectionToSecondary('outstanding_records', merged);
        }
      },
      (err) => {
        console.warn('Shared outstanding_records sync notice:', err);
        if (outstandingChannel.unsub) {
          try { outstandingChannel.unsub(); } catch {}
          outstandingChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        void pullSecondaryIntoChannel(outstandingChannel, 'outstanding_records', finalizeOutstandingList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared outstanding_records listener:', e);
    outstandingChannel.unsub = null;
    void pullSecondaryIntoChannel(outstandingChannel, 'outstanding_records', finalizeOutstandingList);
  }
}

export function useSharedOutstandingRecords() {
  const [outstandingRecords, setOutstandingRecords] = useState<any[]>(() => outstandingChannel.data);
  const [loaded, setLoaded] = useState<boolean>(() => outstandingChannel.loaded);

  useEffect(() => {
    return subscribeChannel(outstandingChannel, startOutstandingListener, (val, isLoaded) => {
      setOutstandingRecords(val);
      setLoaded(isLoaded);
    });
  }, []);

  const setOutstandingOptimistic = (updater: SetStateAction<any[]>) => {
    const nowMs = Date.now();
    const rawNext = typeof updater === 'function' ? updater(outstandingChannel.data) : updater;
    const next = Array.isArray(rawNext) ? rawNext : [];
    const nextIds = new Set<string>();
    next.forEach((r: any) => {
      if (r?.id) {
        nextIds.add(r.id);
        outstandingChannel.archivedIds.delete(r.id);
        outstandingChannel.docMap.set(r.id, { ...r, _syncUpdatedAtMs: Math.max(Number(r._syncUpdatedAtMs) || 0, nowMs) });
      }
    });
    Array.from(outstandingChannel.docMap.keys()).forEach((k) => {
      if (!nextIds.has(k)) outstandingChannel.docMap.delete(k);
    });
    safeLocalStorageSet('blackworm_saved_outstanding_records', JSON.stringify(next));
    notifyChannel(outstandingChannel, next, outstandingChannel.loaded);
  };

  return { outstandingRecords, loaded, setOutstandingOptimistic };
}

// ---------------------------------------------------------------------------
// 9. SHARED SCHEME EXTRA DISCOUNTS STORE (Primary + Secondary Real-Time Sync)
// ---------------------------------------------------------------------------
const SCHEME_DISCOUNTS_KEY = 'blackworm_scheme_extra_discounts_v5';

function loadInitialSchemeDiscounts(): Record<string, number> {
  try {
    if (typeof window === 'undefined') return {};
    const saved = localStorage.getItem(SCHEME_DISCOUNTS_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return {};
}

const schemeDiscountsChannel = createChannel<Record<string, number>>(loadInitialSchemeDiscounts());

let schemeDiscountsDocTs = 0;

function applySchemeDiscountsDoc(data: any, authoritativeServer = false) {
  if (data && data.discounts && typeof data.discounts === 'object') {
    const incomingTs = getDocSyncTs(data);
    if (!authoritativeServer && schemeDiscountsDocTs > 0 && incomingTs > 0 && schemeDiscountsDocTs > incomingTs + 500) {
      return;
    }
    if (incomingTs > 0) schemeDiscountsDocTs = incomingTs;
    const next = { ...data.discounts };
    safeLocalStorageSet(SCHEME_DISCOUNTS_KEY, JSON.stringify(next));
    notifyChannel(schemeDiscountsChannel, next, true);
  }
}

function pullSchemeDiscountsFromSecondary() {
  void fetchSecondaryCollection('config', { limit: 50 }).then((res) => {
    if (!res.ok) return;
    const match = res.items.find((it) => it?.id === 'schemes_extra_discounts');
    if (match) applySchemeDiscountsDoc(match);
  });
}

function startSchemeDiscountsListener() {
  ensureGlobalResyncListeners();
  if (!schemeDiscountsChannel.secUnsub) {
    schemeDiscountsChannel.secUnsub = subscribeSecondaryCollection('config', (events) => {
      events.forEach((evt) => {
        if (evt.id === 'schemes_extra_discounts' && evt.doc && !evt.deleted) {
          applySchemeDiscountsDoc({ ...evt.doc, ...(evt.updatedAtMs ? { _syncUpdatedAtMs: evt.updatedAtMs } : {}) });
        }
      });
    });
  }

  if (!schemeDiscountsChannel.secPulledOnce) {
    schemeDiscountsChannel.secPulledOnce = true;
    pullSchemeDiscountsFromSecondary();
  }

  if (schemeDiscountsChannel.unsub) return;
  if (isQuotaBlocked()) {
    pullSchemeDiscountsFromSecondary();
    return;
  }

  try {
    schemeDiscountsChannel.unsub = onSnapshot(
      doc(db, 'config', 'schemes_extra_discounts'),
      (snap) => {
        trackFirestoreUsage('read', 1);
        if (snap.exists()) {
          const data = snap.data();
          applySchemeDiscountsDoc(data, !snap.metadata?.fromCache);
          if (!snap.metadata?.fromCache) {
            void pushToSecondary({
              collection: 'config',
              id: 'schemes_extra_discounts',
              doc: { ...data, id: 'schemes_extra_discounts' },
              merge: true,
            });
          }
        } else {
          notifyChannel(schemeDiscountsChannel, schemeDiscountsChannel.data, true);
        }
      },
      (err) => {
        console.warn('Shared schemes_extra_discounts sync notice:', err);
        if (schemeDiscountsChannel.unsub) {
          try { schemeDiscountsChannel.unsub(); } catch {}
          schemeDiscountsChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        pullSchemeDiscountsFromSecondary();
      }
    );
  } catch (e) {
    console.warn('Failed to start shared schemes_extra_discounts listener:', e);
    schemeDiscountsChannel.unsub = null;
    pullSchemeDiscountsFromSecondary();
  }
}

export function useSharedSchemeDiscounts() {
  const [discounts, setDiscounts] = useState<Record<string, number>>(() => schemeDiscountsChannel.data);
  const [loaded, setLoaded] = useState<boolean>(() => schemeDiscountsChannel.loaded);

  useEffect(() => {
    return subscribeChannel(schemeDiscountsChannel, startSchemeDiscountsListener, (val, isLoaded) => {
      setDiscounts(val);
      setLoaded(isLoaded);
    });
  }, []);

  const setDiscountsOptimistic = (updater: (prev: Record<string, number>) => Record<string, number>) => {
    schemeDiscountsDocTs = Date.now();
    const next = updater(schemeDiscountsChannel.data);
    safeLocalStorageSet(SCHEME_DISCOUNTS_KEY, JSON.stringify(next));
    notifyChannel(schemeDiscountsChannel, next, schemeDiscountsChannel.loaded);
  };

  return { discounts, loaded, setDiscountsOptimistic };
}

// ---------------------------------------------------------------------------
// 10. SHARED LOCATION VILLAGES STORE (Primary + Secondary Real-Time Sync)
// ---------------------------------------------------------------------------
const LOCATION_VILLAGES_CACHE_KEY = 'blackworm_cached_location_villages';

function loadInitialLocationVillages(): LocationVillageItem[] {
  try {
    if (typeof window === 'undefined') return [];
    const local = mergeWithLocalData<any>('location_villages', []);
    if (local.length > 0) return deduplicateLocationVillages(local);
    const cached = localStorage.getItem(LOCATION_VILLAGES_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return deduplicateLocationVillages(parsed);
    }
  } catch {}
  return [];
}

const locationVillagesChannel = createChannel<LocationVillageItem[]>(loadInitialLocationVillages());

function finalizeLocationVillagesList(
  rawItems: any[],
  archivedIds: Set<string>,
  authoritative: boolean
): LocationVillageItem[] {
  const merged = mergeWithLocalData<any>('location_villages', rawItems, {
    archivedIds,
    authoritativeServer: authoritative,
  });
  const deduped = deduplicateLocationVillages(merged);
  safeLocalStorageSet(LOCATION_VILLAGES_CACHE_KEY, JSON.stringify(deduped));
  return deduped;
}

function startLocationVillagesListener() {
  ensureGlobalResyncListeners();
  if (!locationVillagesChannel.secUnsub) {
    locationVillagesChannel.secUnsub = subscribeSecondaryCollection('location_villages', (events) => {
      const updated = applySecondaryDeltas(locationVillagesChannel, 'location_villages', events);
      if (updated) {
        notifyChannel(
          locationVillagesChannel,
          finalizeLocationVillagesList(updated, locationVillagesChannel.archivedIds, false),
          true
        );
      }
    });
  }

  if (!locationVillagesChannel.secPulledOnce) {
    locationVillagesChannel.secPulledOnce = true;
    void pullSecondaryIntoChannel(locationVillagesChannel, 'location_villages', finalizeLocationVillagesList);
  }

  if (locationVillagesChannel.unsub) return;
  if (isQuotaBlocked()) {
    void pullSecondaryIntoChannel(locationVillagesChannel, 'location_villages', finalizeLocationVillagesList);
    return;
  }

  try {
    const q = query(collection(db, 'location_villages'), limit(2000));
    locationVillagesChannel.unsub = onSnapshot(
      q,
      (snap) => {
        const { items, skipNotify } = applyIncrementalSnapshot(locationVillagesChannel, 'location_villages', snap, 2000);
        if (skipNotify) return;
        const sorted = finalizeLocationVillagesList(
          items,
          locationVillagesChannel.archivedIds,
          !snap.metadata?.fromCache
        );
        notifyChannel(locationVillagesChannel, sorted, true);
        if (!snap.metadata?.fromCache && sorted.length > 0) {
          bootstrapCollectionToSecondary('location_villages', sorted);
        }
      },
      (err) => {
        console.warn('Shared location_villages sync notice:', err);
        if (locationVillagesChannel.unsub) {
          try { locationVillagesChannel.unsub(); } catch {}
          locationVillagesChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        void pullSecondaryIntoChannel(locationVillagesChannel, 'location_villages', finalizeLocationVillagesList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared location_villages listener:', e);
    locationVillagesChannel.unsub = null;
    void pullSecondaryIntoChannel(locationVillagesChannel, 'location_villages', finalizeLocationVillagesList);
  }
}

export function useSharedLocationVillages() {
  const [locationVillages, setLocationVillages] = useState<LocationVillageItem[]>(() => locationVillagesChannel.data);
  const [loaded, setLoaded] = useState<boolean>(() => locationVillagesChannel.loaded);

  useEffect(() => {
    return subscribeChannel(locationVillagesChannel, startLocationVillagesListener, (val, isLoaded) => {
      setLocationVillages(val);
      setLoaded(isLoaded);
    });
  }, []);

  const setLocationVillagesOptimistic = (
    updater: SetStateAction<LocationVillageItem[]>
  ) => {
    const nowMs = Date.now();
    const rawNext = typeof updater === 'function' ? updater(locationVillagesChannel.data) : updater;
    const next = deduplicateLocationVillages(rawNext);
    const nextIds = new Set<string>();
    next.forEach((v: any) => {
      if (v?.id) {
        nextIds.add(v.id);
        locationVillagesChannel.archivedIds.delete(v.id);
        locationVillagesChannel.docMap.set(v.id, { ...v, _syncUpdatedAtMs: Math.max(Number(v._syncUpdatedAtMs) || 0, nowMs) });
      }
    });
    Array.from(locationVillagesChannel.docMap.keys()).forEach((k) => {
      if (!nextIds.has(k)) locationVillagesChannel.docMap.delete(k);
    });
    safeLocalStorageSet(LOCATION_VILLAGES_CACHE_KEY, JSON.stringify(next));
    notifyChannel(locationVillagesChannel, next, locationVillagesChannel.loaded);
  };

  return { locationVillages, loaded, setLocationVillagesOptimistic };
}

/**
 * Automatically ensures a Dealer's selected State -> District -> Taluka -> Village
 * is registered in Location Mapping. Checks official LGD Master + in-memory cache first
 * so zero duplicate Firestore reads/writes occur for official LGD villages.
 */
export async function ensureLocationVillageLinked(params: {
  state?: string;
  stateCode?: string;
  district?: string;
  districtCode?: string;
  taluka?: string;
  talukaCode?: string;
  village?: string;
  villageCode?: string;
  pinCode?: string;
  user?: Partial<UserProfile> | null;
}): Promise<{ created: boolean; updated: boolean; item?: LocationVillageItem }> {
  const cleanVillage = String(params.village || '').trim();
  const cleanDistrict = canonicalizeDistrictName(params.district || '', params.stateCode || params.state);
  if (!cleanVillage || !cleanDistrict) {
    return { created: false, updated: false };
  }

  const stateMeta = getStateMeta(params.stateCode || params.state || DEFAULT_STATE);
  const cleanState = stateMeta?.name || normalizeStateName(params.state || DEFAULT_STATE);
  const stateCode = String(params.stateCode || stateMeta?.code || '');
  const districtMeta = getDistrictMeta(params.districtCode || cleanDistrict, stateCode);
  const districtCode = String(params.districtCode || districtMeta?.code || '');
  const talukaMeta = getTalukaMeta(districtCode || cleanDistrict, params.talukaCode || params.taluka, stateCode);
  const cleanTaluka = talukaMeta?.name || canonicalizeTalukaName(cleanDistrict, params.taluka || '', cleanState) || 'Other';
  const talukaCode = String(params.talukaCode || talukaMeta?.code || '');
  const cleanPin = String(params.pinCode || '').trim();

  // Check official LGD master first (load from IndexedDB if supported state)
  if (stateCode === '27' || stateCode === '29') {
    await loadLgdStateVillages(stateCode);
    const officialHit = findOfficialLgdVillageSync({
      stateCode,
      talukaCode,
      villageCode: params.villageCode,
      villageName: cleanVillage,
    });
    if (officialHit) {
      return { created: false, updated: false };
    }
  }

  const vCode = String(params.villageCode || '').trim();
  const docId = getLocationVillageDocId(cleanState, cleanDistrict, cleanTaluka, cleanVillage, vCode);

  const matchKey = `${normalizeLocationKey(cleanState)}|${normalizeLocationKey(cleanDistrict)}|${normalizeLocationKey(cleanTaluka)}|${normalizeLocationKey(cleanVillage)}`;
  const existing = locationVillagesChannel.data.find((v) => {
    if (vCode && v.villageCode === vCode) return true;
    const vk = `${normalizeLocationKey(v.state)}|${normalizeLocationKey(v.district)}|${normalizeLocationKey(v.taluka)}|${normalizeLocationKey(v.village)}`;
    return vk === matchKey || v.id === docId;
  });

  // Skip write completely if already cached and pincode doesn't add new info
  if (existing && (!cleanPin || existing.pinCode === cleanPin)) {
    return { created: false, updated: false, item: existing };
  }

  const nowIso = new Date().toISOString();
  const generatedCode =
    vCode ||
    existing?.villageCode ||
    `CUST-V-${normalizeLocationKey(cleanDistrict).slice(0, 3).toUpperCase()}-${normalizeLocationKey(cleanVillage).slice(0, 4).toUpperCase()}-${Date.now().toString().slice(-4)}`;

  const record: LocationVillageItem = {
    ...(existing || {}),
    id: existing?.id || docId,
    state: cleanState,
    stateCode,
    district: cleanDistrict,
    districtCode,
    taluka: cleanTaluka,
    talukaCode,
    village: cleanVillage,
    villageCode: generatedCode,
    pinCode: cleanPin || existing?.pinCode || '',
    isCustom: true,
    createdByUid: existing?.createdByUid || params.user?.uid || '',
    createdByName: existing?.createdByName || params.user?.fullName || params.user?.loginId || '',
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    isArchived: false,
  };

  const nextList = deduplicateLocationVillages([
    ...locationVillagesChannel.data.filter((v) => v.id !== record.id),
    record,
  ]);
  safeLocalStorageSet(LOCATION_VILLAGES_CACHE_KEY, JSON.stringify(nextList));
  notifyChannel(locationVillagesChannel, nextList, true);

  await safeFirestoreSet('location_villages', record.id, record, { merge: true });
  return { created: !existing, updated: Boolean(existing), item: record };
}

// ---------------------------------------------------------------------------
// 11. SHARED LOCATION TALUKAS STORE (Admin-added Custom Talukas)
// ---------------------------------------------------------------------------
const LOCATION_TALUKAS_CACHE_KEY = 'blackworm_cached_location_talukas';

function loadInitialLocationTalukas(): LocationTalukaItem[] {
  try {
    if (typeof window === 'undefined') return [];
    const local = mergeWithLocalData<any>('location_talukas', []);
    if (local.length > 0) return deduplicateLocationTalukas(local);
    const cached = localStorage.getItem(LOCATION_TALUKAS_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return deduplicateLocationTalukas(parsed);
    }
  } catch {}
  return [];
}

const locationTalukasChannel = createChannel<LocationTalukaItem[]>(loadInitialLocationTalukas());

function finalizeLocationTalukasList(
  rawItems: any[],
  archivedIds: Set<string>,
  authoritative: boolean
): LocationTalukaItem[] {
  const merged = mergeWithLocalData<any>('location_talukas', rawItems, {
    archivedIds,
    authoritativeServer: authoritative,
  });
  const deduped = deduplicateLocationTalukas(merged);
  safeLocalStorageSet(LOCATION_TALUKAS_CACHE_KEY, JSON.stringify(deduped));
  return deduped;
}

function startLocationTalukasListener() {
  ensureGlobalResyncListeners();
  if (!locationTalukasChannel.secUnsub) {
    locationTalukasChannel.secUnsub = subscribeSecondaryCollection('location_talukas', (events) => {
      const updated = applySecondaryDeltas(locationTalukasChannel, 'location_talukas', events);
      if (updated) {
        notifyChannel(
          locationTalukasChannel,
          finalizeLocationTalukasList(updated, locationTalukasChannel.archivedIds, false),
          true
        );
      }
    });
  }

  if (!locationTalukasChannel.secPulledOnce) {
    locationTalukasChannel.secPulledOnce = true;
    void pullSecondaryIntoChannel(locationTalukasChannel, 'location_talukas', finalizeLocationTalukasList);
  }

  if (locationTalukasChannel.unsub) return;
  if (isQuotaBlocked()) {
    void pullSecondaryIntoChannel(locationTalukasChannel, 'location_talukas', finalizeLocationTalukasList);
    return;
  }

  try {
    const q = query(collection(db, 'location_talukas'), limit(1000));
    locationTalukasChannel.unsub = onSnapshot(
      q,
      (snap) => {
        const { items, skipNotify } = applyIncrementalSnapshot(locationTalukasChannel, 'location_talukas', snap, 1000);
        if (skipNotify) return;
        const sorted = finalizeLocationTalukasList(
          items,
          locationTalukasChannel.archivedIds,
          !snap.metadata?.fromCache
        );
        notifyChannel(locationTalukasChannel, sorted, true);
        if (!snap.metadata?.fromCache && sorted.length > 0) {
          bootstrapCollectionToSecondary('location_talukas', sorted);
        }
      },
      (err) => {
        console.warn('Shared location_talukas sync notice:', err);
        if (locationTalukasChannel.unsub) {
          try { locationTalukasChannel.unsub(); } catch {}
          locationTalukasChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        void pullSecondaryIntoChannel(locationTalukasChannel, 'location_talukas', finalizeLocationTalukasList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared location_talukas listener:', e);
    locationTalukasChannel.unsub = null;
    void pullSecondaryIntoChannel(locationTalukasChannel, 'location_talukas', finalizeLocationTalukasList);
  }
}

export function useSharedLocationTalukas() {
  const [locationTalukas, setLocationTalukas] = useState<LocationTalukaItem[]>(
    () => locationTalukasChannel.data
  );
  const [loaded, setLoaded] = useState<boolean>(() => locationTalukasChannel.loaded);

  useEffect(() => {
    return subscribeChannel(locationTalukasChannel, startLocationTalukasListener, (val, isLoaded) => {
      setLocationTalukas(val);
      setLoaded(isLoaded);
    });
  }, []);

  const setLocationTalukasOptimistic = (
    updater: SetStateAction<LocationTalukaItem[]>
  ) => {
    const nowMs = Date.now();
    const rawNext = typeof updater === 'function' ? updater(locationTalukasChannel.data) : updater;
    const next = deduplicateLocationTalukas(rawNext);
    const nextIds = new Set<string>();
    next.forEach((t: any) => {
      if (t?.id) {
        nextIds.add(t.id);
        locationTalukasChannel.archivedIds.delete(t.id);
        locationTalukasChannel.docMap.set(t.id, { ...t, _syncUpdatedAtMs: Math.max(Number(t._syncUpdatedAtMs) || 0, nowMs) });
      }
    });
    Array.from(locationTalukasChannel.docMap.keys()).forEach((k) => {
      if (!nextIds.has(k)) locationTalukasChannel.docMap.delete(k);
    });
    safeLocalStorageSet(LOCATION_TALUKAS_CACHE_KEY, JSON.stringify(next));
    notifyChannel(locationTalukasChannel, next, locationTalukasChannel.loaded);
  };

  return { locationTalukas, loaded, setLocationTalukasOptimistic };
}

export { getLocationTalukaDocId };

// ---------------------------------------------------------------------------
// 12. SHARED OFFICE / FACTORY STAFF ROSTER (Godown Incharge & Admin)
// ---------------------------------------------------------------------------
export interface OfficeStaffMember {
  id: string;
  fullName: string;
  category: 'Office Staff' | 'Factory Staff';
  workRole?: string;
  mobileNumber?: string;
  joiningDate?: string;
  status?: 'Active' | 'Inactive';
  linkedUserUid?: string;
  createdByUid?: string;
  createdByName?: string;
  isArchived?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

const OFFICE_STAFF_CACHE_KEY = 'blackworm_cached_office_staff';

function normalizeOfficeStaffList(rawItems: any[]): OfficeStaffMember[] {
  const map = new Map<string, OfficeStaffMember>();
  rawItems.forEach((it) => {
    if (!it || !it.id || isRecordDeleted(it)) return;
    const prev = map.get(it.id);
    if (!prev || toTimestampMs(it.updatedAt || it.createdAt) >= toTimestampMs(prev.updatedAt || prev.createdAt)) {
      map.set(it.id, {
        ...it,
        id: String(it.id),
        fullName: String(it.fullName || '').trim(),
        category: it.category === 'Factory Staff' ? 'Factory Staff' : 'Office Staff',
        status: it.status === 'Inactive' ? 'Inactive' : 'Active',
      });
    }
  });

  // Pass 1: Deduplicate by linkedUserUid (when linked to same user account)
  const dedupedByUid = new Map<string, OfficeStaffMember>();
  Array.from(map.values()).forEach((item) => {
    const normName = item.fullName.toLowerCase().replace(/\s+/g, ' ').trim();
    const uidKey = item.linkedUserUid
      ? `uid:${item.linkedUserUid}`
      : `id:${item.id}`;
    const existing = dedupedByUid.get(uidKey);
    if (!existing) {
      dedupedByUid.set(uidKey, item);
      return;
    }
    const existingTs = toTimestampMs(existing.updatedAt || existing.createdAt);
    const incomingTs = toTimestampMs(item.updatedAt || item.createdAt);
    if (incomingTs >= existingTs) {
      dedupedByUid.set(uidKey, item);
    } else if (!normName) {
      dedupedByUid.set(uidKey, existing);
    }
  });

  // Pass 2: Person-level deduplication by normalized (fullName + category), preventing duplicate Warehouse/Godown Incharge rows
  const deduped = new Map<string, OfficeStaffMember>();
  Array.from(dedupedByUid.values()).forEach((item) => {
    const normName = item.fullName.toLowerCase().replace(/\s+/g, ' ').trim();
    const personKey = `name:${normName}|${item.category}`;
    const existing = deduped.get(personKey);
    if (!existing) {
      deduped.set(personKey, item);
      return;
    }
    const existingManual = !existing.id.startsWith('staff_user_');
    const incomingManual = !item.id.startsWith('staff_user_');
    if (incomingManual && !existingManual) {
      deduped.set(personKey, item);
      return;
    }
    if (existingManual && !incomingManual) {
      return;
    }
    const existingTs = toTimestampMs(existing.updatedAt || existing.createdAt);
    const incomingTs = toTimestampMs(item.updatedAt || item.createdAt);
    if (incomingTs >= existingTs) {
      deduped.set(personKey, item);
    }
  });

  return Array.from(deduped.values()).sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function loadInitialOfficeStaff(): OfficeStaffMember[] {
  try {
    if (typeof window === 'undefined') return [];
    const local = mergeWithLocalData<any>('office_staff_members', []);
    if (local.length > 0) return normalizeOfficeStaffList(local);
    const cached = localStorage.getItem(OFFICE_STAFF_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return normalizeOfficeStaffList(parsed);
    }
  } catch {}
  return [];
}

const officeStaffChannel = createChannel<OfficeStaffMember[]>(loadInitialOfficeStaff());

function finalizeOfficeStaffList(
  rawItems: any[],
  archivedIds: Set<string>,
  authoritative: boolean
): OfficeStaffMember[] {
  const merged = mergeWithLocalData<any>('office_staff_members', rawItems, {
    archivedIds,
    authoritativeServer: authoritative,
  });
  const finalList = normalizeOfficeStaffList(merged);
  safeLocalStorageSet(OFFICE_STAFF_CACHE_KEY, JSON.stringify(finalList));
  return finalList;
}

function startOfficeStaffListener() {
  ensureGlobalResyncListeners();
  if (!officeStaffChannel.secUnsub) {
    officeStaffChannel.secUnsub = subscribeSecondaryCollection('office_staff_members', (events) => {
      const updated = applySecondaryDeltas(officeStaffChannel, 'office_staff_members', events);
      if (updated) {
        notifyChannel(
          officeStaffChannel,
          finalizeOfficeStaffList(updated, officeStaffChannel.archivedIds, false),
          true
        );
      }
    });
  }

  if (!officeStaffChannel.secPulledOnce) {
    officeStaffChannel.secPulledOnce = true;
    void pullSecondaryIntoChannel(officeStaffChannel, 'office_staff_members', finalizeOfficeStaffList);
  }

  if (officeStaffChannel.unsub) return;
  if (isQuotaBlocked()) {
    void pullSecondaryIntoChannel(officeStaffChannel, 'office_staff_members', finalizeOfficeStaffList);
    return;
  }

  try {
    const q = query(collection(db, 'office_staff_members'), limit(500));
    officeStaffChannel.unsub = onSnapshot(
      q,
      (snap) => {
        const { items, skipNotify } = applyIncrementalSnapshot(officeStaffChannel, 'office_staff_members', snap, 500);
        if (skipNotify) return;
        const finalList = finalizeOfficeStaffList(
          items,
          officeStaffChannel.archivedIds,
          !snap.metadata?.fromCache
        );
        notifyChannel(officeStaffChannel, finalList, true);
        if (!snap.metadata?.fromCache && finalList.length > 0) {
          bootstrapCollectionToSecondary('office_staff_members', finalList);
        }
      },
      (err) => {
        console.warn('Shared office_staff_members sync notice:', err);
        if (officeStaffChannel.unsub) {
          try { officeStaffChannel.unsub(); } catch {}
          officeStaffChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        void pullSecondaryIntoChannel(officeStaffChannel, 'office_staff_members', finalizeOfficeStaffList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared office_staff_members listener:', e);
    officeStaffChannel.unsub = null;
    void pullSecondaryIntoChannel(officeStaffChannel, 'office_staff_members', finalizeOfficeStaffList);
  }
}

export function useSharedOfficeStaff() {
  const [staffMembers, setStaffMembers] = useState<OfficeStaffMember[]>(() => officeStaffChannel.data);
  const [loaded, setLoaded] = useState<boolean>(() => officeStaffChannel.loaded);

  useEffect(() => {
    return subscribeChannel(officeStaffChannel, startOfficeStaffListener, (val, isLoaded) => {
      setStaffMembers(val);
      setLoaded(isLoaded);
    });
  }, []);

  const setOfficeStaffOptimistic = (
    updater: SetStateAction<OfficeStaffMember[]>
  ) => {
    const nowMs = Date.now();
    const rawNext = typeof updater === 'function' ? updater(officeStaffChannel.data) : updater;
    const next = normalizeOfficeStaffList(rawNext);
    const nextIds = new Set<string>();
    next.forEach((m: any) => {
      if (m?.id) {
        nextIds.add(m.id);
        officeStaffChannel.archivedIds.delete(m.id);
        officeStaffChannel.docMap.set(m.id, { ...m, _syncUpdatedAtMs: Math.max(Number(m._syncUpdatedAtMs) || 0, nowMs) });
      }
    });
    Array.from(officeStaffChannel.docMap.keys()).forEach((k) => {
      if (!nextIds.has(k)) officeStaffChannel.docMap.delete(k);
    });
    safeLocalStorageSet(OFFICE_STAFF_CACHE_KEY, JSON.stringify(next));
    notifyChannel(officeStaffChannel, next, officeStaffChannel.loaded);
  };

  return { staffMembers, loaded, setOfficeStaffOptimistic };
}

// ---------------------------------------------------------------------------
// 13. SHARED OFFICE / FACTORY STAFF ATTENDANCE (Godown Incharge & Admin)
// ---------------------------------------------------------------------------
export interface OfficeStaffAttendanceRecord {
  id: string;
  date: string; // YYYY-MM-DD
  monthKey: string; // YYYY-MM
  staffId: string;
  staffName: string;
  category: 'Office Staff' | 'Factory Staff';
  workRole?: string;
  status: 'present' | 'half_day' | 'absent' | 'leave';
  note?: string;
  markedByUid?: string;
  markedByName?: string;
  markedAt?: string;
  isArchived?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

const OFFICE_ATTENDANCE_CACHE_KEY = 'blackworm_cached_office_attendance';

function normalizeOfficeAttendanceList(rawItems: any[]): OfficeStaffAttendanceRecord[] {
  const map = new Map<string, OfficeStaffAttendanceRecord>();
  rawItems.forEach((it) => {
    if (!it || !it.id || isRecordDeleted(it)) return;
    const prev = map.get(it.id);
    if (!prev || toTimestampMs(it.updatedAt || it.markedAt || it.createdAt) >= toTimestampMs(prev.updatedAt || prev.markedAt || prev.createdAt)) {
      const dateStr = String(it.date || '').slice(0, 10);
      map.set(it.id, {
        ...it,
        id: String(it.id),
        date: dateStr,
        monthKey: String(it.monthKey || dateStr.slice(0, 7)),
        staffId: String(it.staffId || ''),
        staffName: String(it.staffName || '').trim(),
        category: it.category === 'Factory Staff' ? 'Factory Staff' : 'Office Staff',
        status:
          it.status === 'half_day' || it.status === 'absent' || it.status === 'leave'
            ? it.status
            : 'present',
      });
    }
  });
  return Array.from(map.values()).sort((a, b) =>
    toTimestampMs(b.updatedAt || b.markedAt || b.date) - toTimestampMs(a.updatedAt || a.markedAt || a.date)
  );
}

function loadInitialOfficeAttendance(): OfficeStaffAttendanceRecord[] {
  try {
    if (typeof window === 'undefined') return [];
    const local = mergeWithLocalData<any>('office_staff_attendance', []);
    if (local.length > 0) return normalizeOfficeAttendanceList(local);
    const cached = localStorage.getItem(OFFICE_ATTENDANCE_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return normalizeOfficeAttendanceList(parsed);
    }
  } catch {}
  return [];
}

const officeAttendanceChannel = createChannel<OfficeStaffAttendanceRecord[]>(loadInitialOfficeAttendance());

function finalizeOfficeAttendanceList(
  rawItems: any[],
  archivedIds: Set<string>,
  authoritative: boolean
): OfficeStaffAttendanceRecord[] {
  const merged = mergeWithLocalData<any>('office_staff_attendance', rawItems, {
    archivedIds,
    authoritativeServer: authoritative,
  });
  const finalList = normalizeOfficeAttendanceList(merged);
  safeLocalStorageSet(OFFICE_ATTENDANCE_CACHE_KEY, JSON.stringify(finalList));
  return finalList;
}

function startOfficeAttendanceListener() {
  ensureGlobalResyncListeners();
  if (!officeAttendanceChannel.secUnsub) {
    officeAttendanceChannel.secUnsub = subscribeSecondaryCollection('office_staff_attendance', (events) => {
      const updated = applySecondaryDeltas(officeAttendanceChannel, 'office_staff_attendance', events);
      if (updated) {
        notifyChannel(
          officeAttendanceChannel,
          finalizeOfficeAttendanceList(updated, officeAttendanceChannel.archivedIds, false),
          true
        );
      }
    });
  }

  if (!officeAttendanceChannel.secPulledOnce) {
    officeAttendanceChannel.secPulledOnce = true;
    void pullSecondaryIntoChannel(officeAttendanceChannel, 'office_staff_attendance', finalizeOfficeAttendanceList);
  }

  if (officeAttendanceChannel.unsub) return;
  if (isQuotaBlocked()) {
    void pullSecondaryIntoChannel(officeAttendanceChannel, 'office_staff_attendance', finalizeOfficeAttendanceList);
    return;
  }

  try {
    const q = query(collection(db, 'office_staff_attendance'), limit(2000));
    officeAttendanceChannel.unsub = onSnapshot(
      q,
      (snap) => {
        const { items, skipNotify } = applyIncrementalSnapshot(officeAttendanceChannel, 'office_staff_attendance', snap, 2000);
        if (skipNotify) return;
        const finalList = finalizeOfficeAttendanceList(
          items,
          officeAttendanceChannel.archivedIds,
          !snap.metadata?.fromCache
        );
        notifyChannel(officeAttendanceChannel, finalList, true);
        if (!snap.metadata?.fromCache && finalList.length > 0) {
          bootstrapCollectionToSecondary('office_staff_attendance', finalList);
        }
      },
      (err) => {
        console.warn('Shared office_staff_attendance sync notice:', err);
        if (officeAttendanceChannel.unsub) {
          try { officeAttendanceChannel.unsub(); } catch {}
          officeAttendanceChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        void pullSecondaryIntoChannel(officeAttendanceChannel, 'office_staff_attendance', finalizeOfficeAttendanceList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared office_staff_attendance listener:', e);
    officeAttendanceChannel.unsub = null;
    void pullSecondaryIntoChannel(officeAttendanceChannel, 'office_staff_attendance', finalizeOfficeAttendanceList);
  }
}

export function useSharedOfficeAttendance() {
  const [attendanceRecords, setAttendanceRecords] = useState<OfficeStaffAttendanceRecord[]>(
    () => officeAttendanceChannel.data
  );
  const [loaded, setLoaded] = useState<boolean>(() => officeAttendanceChannel.loaded);

  useEffect(() => {
    return subscribeChannel(officeAttendanceChannel, startOfficeAttendanceListener, (val, isLoaded) => {
      setAttendanceRecords(val);
      setLoaded(isLoaded);
    });
  }, []);

  const setOfficeAttendanceOptimistic = (
    updater: SetStateAction<OfficeStaffAttendanceRecord[]>
  ) => {
    const nowMs = Date.now();
    const rawNext = typeof updater === 'function' ? updater(officeAttendanceChannel.data) : updater;
    const next = normalizeOfficeAttendanceList(rawNext);
    const nextIds = new Set<string>();
    next.forEach((a: any) => {
      if (a?.id) {
        nextIds.add(a.id);
        officeAttendanceChannel.archivedIds.delete(a.id);
        officeAttendanceChannel.docMap.set(a.id, { ...a, _syncUpdatedAtMs: Math.max(Number(a._syncUpdatedAtMs) || 0, nowMs) });
      }
    });
    Array.from(officeAttendanceChannel.docMap.keys()).forEach((k) => {
      if (!nextIds.has(k)) officeAttendanceChannel.docMap.delete(k);
    });
    safeLocalStorageSet(OFFICE_ATTENDANCE_CACHE_KEY, JSON.stringify(next));
    notifyChannel(officeAttendanceChannel, next, officeAttendanceChannel.loaded);
  };

  return { attendanceRecords, loaded, setOfficeAttendanceOptimistic };
}

// ---------------------------------------------------------------------------
// 14. SHARED MONTHLY TARGETS STORE (targets collection - Primary + Secondary)
// ---------------------------------------------------------------------------
function loadInitialTargets(): any[] {
  try {
    if (typeof window === 'undefined') return [];
    const local = mergeWithLocalData<any>('targets', []);
    if (local.length > 0) return local;
    const cached = localStorage.getItem('blackworm_cached_targets');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed.filter((t: any) => t && !isRecordDeleted(t));
    }
  } catch {}
  return [];
}

const targetsChannel = createChannel<any[]>(loadInitialTargets());

function finalizeTargetsList(rawItems: any[], archivedIds: Set<string>, authoritative: boolean): any[] {
  const merged = mergeWithLocalData<any>('targets', rawItems, {
    archivedIds,
    authoritativeServer: authoritative,
  });
  safeLocalStorageSet('blackworm_cached_targets', JSON.stringify(merged));
  return merged;
}

function startTargetsListener() {
  ensureGlobalResyncListeners();
  if (!targetsChannel.secUnsub) {
    targetsChannel.secUnsub = subscribeSecondaryCollection('targets', (events) => {
      const updated = applySecondaryDeltas(targetsChannel, 'targets', events);
      if (updated) {
        notifyChannel(targetsChannel, finalizeTargetsList(updated, targetsChannel.archivedIds, false), true);
      }
    });
  }

  if (!targetsChannel.secPulledOnce) {
    targetsChannel.secPulledOnce = true;
    void pullSecondaryIntoChannel(targetsChannel, 'targets', finalizeTargetsList);
  }

  if (targetsChannel.unsub) return;
  if (isQuotaBlocked()) {
    void pullSecondaryIntoChannel(targetsChannel, 'targets', finalizeTargetsList);
    return;
  }

  try {
    targetsChannel.unsub = onSnapshot(
      collection(db, 'targets'),
      (snap) => {
        const { items, skipNotify } = applyIncrementalSnapshot(targetsChannel, 'targets', snap);
        if (skipNotify) return;
        const merged = finalizeTargetsList(items, targetsChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(targetsChannel, merged, true);
        if (!snap.metadata?.fromCache && merged.length > 0) {
          bootstrapCollectionToSecondary('targets', merged);
        }
      },
      (err) => {
        console.warn('Shared targets sync notice:', err);
        if (targetsChannel.unsub) {
          try { targetsChannel.unsub(); } catch {}
          targetsChannel.unsub = null;
        }
        if (isQuotaError(err)) setQuotaBlocked(2 * 60 * 1000);
        void pullSecondaryIntoChannel(targetsChannel, 'targets', finalizeTargetsList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared targets listener:', e);
    targetsChannel.unsub = null;
    void pullSecondaryIntoChannel(targetsChannel, 'targets', finalizeTargetsList);
  }
}

export function useSharedTargets() {
  const [targets, setTargets] = useState<any[]>(() => targetsChannel.data);
  const [loaded, setLoaded] = useState<boolean>(() => targetsChannel.loaded);

  useEffect(() => {
    return subscribeChannel(targetsChannel, startTargetsListener, (val, isLoaded) => {
      setTargets(val);
      setLoaded(isLoaded);
    });
  }, []);

  return { targets, loaded };
}

// ---------------------------------------------------------------------------
// 15. IN-TAB INSTANT MUTATION PROPAGATION + GLOBAL MULTI-TIER FAILOVER COORDINATOR
// ---------------------------------------------------------------------------
const channelRegistry: Record<
  string,
  {
    channel: StoreChannel<any[]>;
    finalize: (items: any[], archivedIds: Set<string>, authoritative: boolean) => any[];
  }
> = {
  users: { channel: usersChannel, finalize: finalizeUsersList },
  dealers_application: { channel: dealersChannel, finalize: finalizeDealersList },
  orders: { channel: ordersChannel, finalize: finalizeOrdersList },
  collection_entries: { channel: collectionsChannel, finalize: finalizeCollectionsList },
  yearly_targets: { channel: yearlyTargetsChannel, finalize: finalizeYearlyTargetsList },
  travel_sheets: { channel: travelSheetsChannel, finalize: finalizeTravelSheetsList },
  outstanding_records: { channel: outstandingChannel, finalize: finalizeOutstandingList },
  location_villages: { channel: locationVillagesChannel, finalize: finalizeLocationVillagesList },
  location_talukas: { channel: locationTalukasChannel, finalize: finalizeLocationTalukasList },
  office_staff_members: { channel: officeStaffChannel, finalize: finalizeOfficeStaffList },
  office_staff_attendance: { channel: officeAttendanceChannel, finalize: finalizeOfficeAttendanceList },
  targets: { channel: targetsChannel, finalize: finalizeTargetsList },
};

function handleLocalRecordMutation(detail: {
  collection?: string;
  id?: string;
  doc?: any;
  merge?: boolean;
  deleted?: boolean;
  updatedAtMs?: number;
}) {
  const col = String(detail?.collection || '').trim();
  const id = String(detail?.id || '').trim();
  if (!col || !id) return;

  if (col === 'config' && id === 'master_pricelist' && detail.doc && !detail.deleted) {
    applyMasterPricelistDoc(
      { ...detail.doc, ...(detail.updatedAtMs ? { _syncUpdatedAtMs: detail.updatedAtMs } : {}) },
      false
    );
    return;
  }
  if (col === 'config' && id === 'schemes_extra_discounts' && detail.doc && !detail.deleted) {
    applySchemeDiscountsDoc(
      { ...detail.doc, ...(detail.updatedAtMs ? { _syncUpdatedAtMs: detail.updatedAtMs } : {}) },
      false
    );
    return;
  }

  const entry = channelRegistry[col];
  if (!entry) return;
  const { channel, finalize } = entry;

  if (detail.deleted || isRecordDeleted(detail.doc)) {
    channel.secIds.delete(id);
    channel.archivedIds.add(id);
    channel.docMap.delete(id);
  } else if (detail.doc && typeof detail.doc === 'object') {
    const existing = channel.docMap.get(id);
    const mergedDoc =
      col === 'travel_sheets' && existing && Array.isArray(existing.rows) && Array.isArray(detail.doc.rows)
        ? mergeTravelSheetDocs(existing, { ...detail.doc, id })
        : detail.merge !== false && existing
          ? { ...existing, ...detail.doc, id }
          : { ...detail.doc, id };
    if (detail.updatedAtMs && !mergedDoc._syncUpdatedAtMs) {
      mergedDoc._syncUpdatedAtMs = detail.updatedAtMs;
    }
    channel.archivedIds.delete(id);
    channel.docMap.set(id, mergedDoc);
  }

  const next = finalize(Array.from(channel.docMap.values()), channel.archivedIds, false);
  notifyChannel(channel, next, channel.loaded || next.length > 0);
}

let globalResyncAttached = false;
let lastGlobalPullAt = 0;
let needsReadRecoveryProbe = false;
let isProbingReadRecovery = false;
let lastReadProbeAtMs = 0;

async function probeAndReattachListeners(forceProbe = false) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (isQuotaBlocked()) return;

  if (needsReadRecoveryProbe) {
    const now = Date.now();
    if (isProbingReadRecovery) return;
    if (!forceProbe && now - lastReadProbeAtMs < 30000) return;
    isProbingReadRecovery = true;
    lastReadProbeAtMs = now;
    try {
      await getDocFromServer(doc(db, 'test', 'connection'));
      trackFirestoreUsage('read', 1);
      needsReadRecoveryProbe = false;
      resetReadQuotaBackoff();
    } catch (err: any) {
      if (isQuotaError(err)) {
        setQuotaBlocked(2 * 60 * 1000);
        return;
      }
      // Non-quota error (e.g. offline/network): wait before retrying full reattach
      return;
    } finally {
      isProbingReadRecovery = false;
    }
  }

  reattachAllActiveListeners();
}

export async function hydrateAllChannelsFromSecondary(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastGlobalPullAt < 2500) return;
  lastGlobalPullAt = now;

  const shouldPull = (ch: StoreChannel<any>) =>
    force || ch.subscribers.size > 0 || ch.secPulledOnce || ch.lastSecPullAtMs > 0;

  const jobs: Promise<any>[] = [];
  if (shouldPull(usersChannel)) {
    jobs.push(pullSecondaryIntoChannel(usersChannel, 'users', finalizeUsersList));
  }
  if (shouldPull(dealersChannel)) {
    jobs.push(pullSecondaryIntoChannel(dealersChannel, 'dealers_application', finalizeDealersList));
  }
  if (shouldPull(ordersChannel)) {
    jobs.push(pullSecondaryIntoChannel(ordersChannel, 'orders', finalizeOrdersList));
  }
  if (shouldPull(collectionsChannel)) {
    jobs.push(pullSecondaryIntoChannel(collectionsChannel, 'collection_entries', finalizeCollectionsList));
  }
  if (shouldPull(yearlyTargetsChannel)) {
    jobs.push(pullSecondaryIntoChannel(yearlyTargetsChannel, 'yearly_targets', finalizeYearlyTargetsList));
  }
  if (shouldPull(targetsChannel)) {
    jobs.push(pullSecondaryIntoChannel(targetsChannel, 'targets', finalizeTargetsList));
  }
  if (shouldPull(travelSheetsChannel)) {
    jobs.push(pullSecondaryIntoChannel(travelSheetsChannel, 'travel_sheets', finalizeTravelSheetsList));
  }
  if (shouldPull(outstandingChannel)) {
    jobs.push(pullSecondaryIntoChannel(outstandingChannel, 'outstanding_records', finalizeOutstandingList));
  }
  if (shouldPull(locationVillagesChannel)) {
    jobs.push(pullSecondaryIntoChannel(locationVillagesChannel, 'location_villages', finalizeLocationVillagesList));
  }
  if (shouldPull(locationTalukasChannel)) {
    jobs.push(pullSecondaryIntoChannel(locationTalukasChannel, 'location_talukas', finalizeLocationTalukasList));
  }
  if (shouldPull(officeStaffChannel)) {
    jobs.push(pullSecondaryIntoChannel(officeStaffChannel, 'office_staff_members', finalizeOfficeStaffList));
  }
  if (shouldPull(officeAttendanceChannel)) {
    jobs.push(pullSecondaryIntoChannel(officeAttendanceChannel, 'office_staff_attendance', finalizeOfficeAttendanceList));
  }
  if (shouldPull(masterPricelistChannel)) {
    pullMasterPricelistFromSecondary();
  }
  if (shouldPull(schemeDiscountsChannel)) {
    pullSchemeDiscountsFromSecondary();
  }
  await Promise.all(jobs);
}

function reattachAllActiveListeners() {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (isQuotaBlocked()) return;
  if (usersChannel.subscribers.size > 0 && !usersChannel.unsub) startUsersListener();
  if (dealersChannel.subscribers.size > 0 && !dealersChannel.unsub) startDealersListener();
  if (ordersChannel.subscribers.size > 0 && !ordersChannel.unsub) startOrdersListener();
  if (collectionsChannel.subscribers.size > 0 && !collectionsChannel.unsub) startCollectionsListener();
  if (yearlyTargetsChannel.subscribers.size > 0 && !yearlyTargetsChannel.unsub) startYearlyTargetsListener();
  if (targetsChannel.subscribers.size > 0 && !targetsChannel.unsub) startTargetsListener();
  if (travelSheetsChannel.subscribers.size > 0 && !travelSheetsChannel.unsub) startTravelSheetsListener();
  if (masterPricelistChannel.subscribers.size > 0 && !masterPricelistChannel.unsub) startMasterPricelistListener();
  if (outstandingChannel.subscribers.size > 0 && !outstandingChannel.unsub) startOutstandingListener();
  if (schemeDiscountsChannel.subscribers.size > 0 && !schemeDiscountsChannel.unsub) startSchemeDiscountsListener();
  if (locationVillagesChannel.subscribers.size > 0 && !locationVillagesChannel.unsub) startLocationVillagesListener();
  if (locationTalukasChannel.subscribers.size > 0 && !locationTalukasChannel.unsub) startLocationTalukasListener();
  if (officeStaffChannel.subscribers.size > 0 && !officeStaffChannel.unsub) startOfficeStaffListener();
  if (officeAttendanceChannel.subscribers.size > 0 && !officeAttendanceChannel.unsub) startOfficeAttendanceListener();
}

function ensureGlobalResyncListeners() {
  if (typeof window === 'undefined' || globalResyncAttached) return;
  globalResyncAttached = true;

  window.addEventListener('blackworm_local_record_mutation', (e: any) => {
    handleLocalRecordMutation(e?.detail || {});
  });
  window.addEventListener('blackworm_quota_blocked', () => {
    needsReadRecoveryProbe = true;
    void hydrateAllChannelsFromSecondary(true);
  });
  window.addEventListener('blackworm_data_refresh', () => {
    void probeAndReattachListeners(true);
    void hydrateAllChannelsFromSecondary(true);
  });
  window.addEventListener('blackworm_secondary_resync', (e: any) => {
    const reason = e?.detail?.reason || '';
    const isUrgent =
      reason === 'epoch_changed' ||
      reason === 'rev_regressed' ||
      reason === 'rev_zero' ||
      reason === 'packet_import' ||
      reason === 'force_sync';
    void hydrateAllChannelsFromSecondary(isUrgent);
  });
  window.addEventListener('blackworm_quota_cleared', () => {
    void probeAndReattachListeners(true);
  });
  window.addEventListener('online', () => {
    void probeAndReattachListeners(false);
  });
  window.addEventListener('focus', () => {
    void probeAndReattachListeners(false);
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void probeAndReattachListeners(false);
      }
    });
  }
  // Auto-recovery heartbeat: if any active channel lost its onSnapshot listener, re-attach safely
  setInterval(() => {
    void probeAndReattachListeners(false);
  }, 20000);
}

if (typeof window !== 'undefined') {
  ensureGlobalResyncListeners();
}
