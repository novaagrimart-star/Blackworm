import { useState, useEffect } from 'react';
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
  safeLocalStorageSet,
} from './dataService';
import { loadCollectionFromVault } from './localVault';
import {
  subscribeSecondaryCollection,
  fetchSecondaryCollection,
  bootstrapCollectionToSecondary,
  pushToSecondary,
  SecondaryDeltaEvent,
} from './secondaryDb';

const LINGER_UNSUB_MS = 60000; // Keep shared listeners warm for 60s across tab navigation (0 re-reads!)

interface StoreChannel<T> {
  data: T;
  loaded: boolean;
  subscribers: Set<(val: T, loaded: boolean) => void>;
  unsub: (() => void) | null;
  secUnsub: (() => void) | null;
  lingerTimer: ReturnType<typeof setTimeout> | null;
  docMap: Map<string, any>;
  archivedIds: Set<string>;
}

function createChannel<T>(initial: T): StoreChannel<T> {
  return {
    data: initial,
    loaded: false,
    subscribers: new Set(),
    unsub: null,
    secUnsub: null,
    lingerTimer: null,
    docMap: new Map(),
    archivedIds: new Set(),
  };
}

function notifyChannel<T>(ch: StoreChannel<T>, next: T, loaded = true) {
  ch.data = next;
  ch.loaded = loaded;
  ch.subscribers.forEach((cb) => cb(next, loaded));
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
  ch.subscribers.add(onChange);
  starter();
  onChange(ch.data, ch.loaded);

  return () => {
    ch.subscribers.delete(onChange);
    if (ch.subscribers.size === 0 && (ch.unsub || ch.secUnsub)) {
      ch.lingerTimer = setTimeout(() => {
        if (ch.subscribers.size === 0) {
          if (ch.unsub) {
            ch.unsub();
            ch.unsub = null;
          }
          if (ch.secUnsub) {
            ch.secUnsub();
            ch.secUnsub = null;
          }
        }
      }, LINGER_UNSUB_MS);
    }
  };
}

function isQuotaError(err: any): boolean {
  return isQuotaExceededError(err);
}

function applyIncrementalSnapshot(
  ch: StoreChannel<any[]>,
  colName: string,
  snap: any
): { items: any[]; changedCount: number } {
  const changes = typeof snap.docChanges === 'function' ? snap.docChanges() : [];
  let changedCount = changes.length;

  if (ch.docMap.size === 0 && snap.docs) {
    snap.docs.forEach((d: any) => {
      const data = d.data();
      if (data?.isArchived) {
        ch.archivedIds.add(d.id);
        ch.docMap.delete(d.id);
        removeFromCollectionCache(colName, d.id);
      } else {
        ch.archivedIds.delete(d.id);
        ch.docMap.set(d.id, { ...data, id: d.id });
      }
    });
    changedCount = snap.docs.length || 1;
  } else {
    changes.forEach((change: any) => {
      const id = change.doc.id;
      if (change.type === 'removed') {
        ch.docMap.delete(id);
        ch.archivedIds.add(id);
        removeFromCollectionCache(colName, id);
      } else {
        const data = change.doc.data();
        if (data?.isArchived) {
          ch.docMap.delete(id);
          ch.archivedIds.add(id);
          removeFromCollectionCache(colName, id);
        } else {
          ch.archivedIds.delete(id);
          ch.docMap.set(id, { ...data, id });
        }
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
  events.forEach((evt) => {
    if (!evt || evt.collection !== colName || !evt.id) return;
    if (evt.deleted || evt.doc?.isArchived) {
      if (ch.docMap.has(evt.id) || !ch.archivedIds.has(evt.id)) {
        ch.docMap.delete(evt.id);
        ch.archivedIds.add(evt.id);
        removeFromCollectionCache(colName, evt.id);
        mutated = true;
      }
      return;
    }

    if (evt.doc) {
      const incoming: Record<string, any> = { ...evt.doc, id: evt.id };
      const existing = ch.docMap.get(evt.id);
      const existingTs = toTimestampMs(existing?.updatedAt || existing?.createdAt);
      const incomingTs = evt.updatedAtMs || toTimestampMs(incoming.updatedAt || incoming.createdAt);

      if (!existing || incomingTs >= existingTs) {
        ch.archivedIds.delete(evt.id);
        ch.docMap.set(evt.id, existing ? { ...existing, ...incoming } : incoming);
        mutated = true;
      }
    }
  });

  if (!mutated) return null;
  const arr = Array.from(ch.docMap.values());
  updateCollectionCache(colName, arr);
  return arr;
}

async function pullSecondaryIntoChannel(
  ch: StoreChannel<any[]>,
  colName: string,
  transform: (items: any[], archivedIds: Set<string>, authoritative: boolean) => any[]
) {
  try {
    const sec = await fetchSecondaryCollection(colName, { limit: 2000 });
    if (sec.ok && (sec.items.length > 0 || sec.archivedIds.length > 0)) {
      sec.archivedIds.forEach((id) => {
        ch.archivedIds.add(id);
        ch.docMap.delete(id);
        removeFromCollectionCache(colName, id);
      });
      sec.items.forEach((it) => {
        if (!it || !it.id) return;
        const existing = ch.docMap.get(it.id);
        const existingTs = toTimestampMs(existing?.updatedAt || existing?.createdAt);
        const incomingTs = toTimestampMs(it.updatedAt || it.createdAt || it._syncUpdatedAtMs);
        if (!existing || incomingTs >= existingTs) {
          ch.archivedIds.delete(it.id);
          ch.docMap.set(it.id, existing ? { ...existing, ...it } : it);
        }
      });
      const finalList = transform(Array.from(ch.docMap.values()), ch.archivedIds, false);
      notifyChannel(ch, finalList, true);
      return;
    }
  } catch {}

  // Fallback to IndexedDB vault if LocalStorage missed older/large datasets
  try {
    const vaultMap = await loadCollectionFromVault(colName);
    if (vaultMap) {
      const vaultItems = Object.values(vaultMap).filter((it: any) => it && !it.isArchived);
      if (vaultItems.length > 0) {
        const finalList = transform(vaultItems, ch.archivedIds, false);
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
      if (Array.isArray(parsed)) return parsed.filter((u: any) => u && !u.isArchived);
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
  if (!usersChannel.secUnsub) {
    usersChannel.secUnsub = subscribeSecondaryCollection('users', (events) => {
      const updated = applySecondaryDeltas(usersChannel, 'users', events);
      if (updated) {
        notifyChannel(usersChannel, finalizeUsersList(updated, usersChannel.archivedIds, false), true);
      }
    });
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
        const { items } = applyIncrementalSnapshot(usersChannel, 'users', snap);
        const sorted = finalizeUsersList(items, usersChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(usersChannel, sorted, true);
        if (!snap.metadata?.fromCache) {
          bootstrapCollectionToSecondary('users', sorted);
        }
      },
      (err) => {
        console.warn('Shared users sync notice:', err);
        if (isQuotaError(err)) setQuotaBlocked(15 * 60 * 1000);
        void pullSecondaryIntoChannel(usersChannel, 'users', finalizeUsersList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared users listener:', e);
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
      if (u.loginId) usersMap[u.loginId.toLowerCase()] = u.fullName;
      if (u.userCode) usersMap[u.userCode.toLowerCase()] = u.fullName;
    }
  });

  const setUsersOptimistic = (updater: (prev: UserProfile[]) => UserProfile[]) => {
    const next = sortUsers(updater(usersChannel.data));
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
  if (!dealersChannel.secUnsub) {
    dealersChannel.secUnsub = subscribeSecondaryCollection('dealers_application', (events) => {
      const updated = applySecondaryDeltas(dealersChannel, 'dealers_application', events);
      if (updated) {
        notifyChannel(dealersChannel, finalizeDealersList(updated, dealersChannel.archivedIds, false), true);
      }
    });
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
        const { items } = applyIncrementalSnapshot(dealersChannel, 'dealers_application', snap);
        const sorted = finalizeDealersList(items, dealersChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(dealersChannel, sorted, true);
        if (!snap.metadata?.fromCache) {
          bootstrapCollectionToSecondary('dealers_application', sorted);
        }
      },
      (err) => {
        console.warn('Shared dealers sync notice:', err);
        if (isQuotaError(err)) setQuotaBlocked(15 * 60 * 1000);
        void pullSecondaryIntoChannel(dealersChannel, 'dealers_application', finalizeDealersList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared dealers listener:', e);
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

  const updateLocalDealersOptimistic = (updater: (prev: any[]) => any[]) => {
    const next = sortDealers(deduplicateDealers(updater(dealersChannel.data)));
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
  if (!ordersChannel.secUnsub) {
    ordersChannel.secUnsub = subscribeSecondaryCollection('orders', (events) => {
      const updated = applySecondaryDeltas(ordersChannel, 'orders', events);
      if (updated) {
        notifyChannel(ordersChannel, finalizeOrdersList(updated, ordersChannel.archivedIds, false), true);
      }
    });
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
        const { items } = applyIncrementalSnapshot(ordersChannel, 'orders', snap);
        const sorted = finalizeOrdersList(items, ordersChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(ordersChannel, sorted, true);
        if (!snap.metadata?.fromCache) {
          bootstrapCollectionToSecondary('orders', sorted);
        }
      },
      (err) => {
        console.warn('Shared orders sync notice:', err);
        if (isQuotaError(err)) setQuotaBlocked(15 * 60 * 1000);
        void pullSecondaryIntoChannel(ordersChannel, 'orders', finalizeOrdersList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared orders listener:', e);
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

  const setOrdersOptimistic = (updater: (prev: any[]) => any[]) => {
    const next = deduplicateOrders(updater(ordersChannel.data)).sort(
      (a, b) => toTimestampMs(b.createdAt) - toTimestampMs(a.createdAt)
    );
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
  if (!collectionsChannel.secUnsub) {
    collectionsChannel.secUnsub = subscribeSecondaryCollection('collection_entries', (events) => {
      const updated = applySecondaryDeltas(collectionsChannel, 'collection_entries', events);
      if (updated) {
        notifyChannel(collectionsChannel, finalizeCollectionsList(updated, collectionsChannel.archivedIds, false), true);
      }
    });
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
        const { items } = applyIncrementalSnapshot(collectionsChannel, 'collection_entries', snap);
        const sorted = finalizeCollectionsList(items, collectionsChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(collectionsChannel, sorted, true);
        if (!snap.metadata?.fromCache) {
          bootstrapCollectionToSecondary('collection_entries', sorted);
        }
      },
      (err) => {
        console.warn('Shared collections sync notice:', err);
        if (isQuotaError(err)) setQuotaBlocked(15 * 60 * 1000);
        void pullSecondaryIntoChannel(collectionsChannel, 'collection_entries', finalizeCollectionsList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared collections listener:', e);
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

  const setCollectionsOptimistic = (updater: (prev: any[]) => any[]) => {
    const next = deduplicateCollections(updater(collectionsChannel.data)).sort(
      (a, b) => toTimestampMs(b.createdAt || b.date) - toTimestampMs(a.createdAt || a.date)
    );
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
  if (!yearlyTargetsChannel.secUnsub) {
    yearlyTargetsChannel.secUnsub = subscribeSecondaryCollection('yearly_targets', (events) => {
      const updated = applySecondaryDeltas(yearlyTargetsChannel, 'yearly_targets', events);
      if (updated) {
        notifyChannel(yearlyTargetsChannel, finalizeYearlyTargetsList(updated, yearlyTargetsChannel.archivedIds, false), true);
      }
    });
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
        const { items } = applyIncrementalSnapshot(yearlyTargetsChannel, 'yearly_targets', snap);
        const merged = finalizeYearlyTargetsList(items, yearlyTargetsChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(yearlyTargetsChannel, merged, true);
        if (!snap.metadata?.fromCache) {
          bootstrapCollectionToSecondary('yearly_targets', merged);
        }
      },
      (err) => {
        console.warn('Shared yearly_targets sync notice:', err);
        if (isQuotaError(err)) setQuotaBlocked(15 * 60 * 1000);
        void pullSecondaryIntoChannel(yearlyTargetsChannel, 'yearly_targets', finalizeYearlyTargetsList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared yearly_targets listener:', e);
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
    if (!isQuotaBlocked()) {
      try {
        const docSnap = await getDocFromServer(doc(db, 'yearly_targets', docId));
        trackFirestoreUsage('read', 1);
        if (docSnap.exists()) {
          const data = { ...docSnap.data(), id: docSnap.id, _id: docSnap.id };
          yearlyTargetsChannel.docMap.set(docSnap.id, data);
          const merged = finalizeYearlyTargetsList(
            Array.from(yearlyTargetsChannel.docMap.values()),
            yearlyTargetsChannel.archivedIds,
            true
          );
          notifyChannel(yearlyTargetsChannel, merged, true);
          return data;
        }
      } catch (err) {
        if (isQuotaError(err)) setQuotaBlocked(15 * 60 * 1000);
        console.warn('Refresh target doc notice:', err);
      }
    }
    const sec = await fetchSecondaryCollection('yearly_targets', { limit: 500 });
    if (sec.ok) {
      const found = sec.items.find((it) => it.id === docId);
      if (found) {
        const data = { ...found, _id: found.id };
        yearlyTargetsChannel.docMap.set(found.id, data);
        const merged = finalizeYearlyTargetsList(
          Array.from(yearlyTargetsChannel.docMap.values()),
          yearlyTargetsChannel.archivedIds,
          false
        );
        notifyChannel(yearlyTargetsChannel, merged, true);
        return data;
      }
    }
    return null;
  };

  const refreshAllYearlyTargetsFromServer = async () => {
    if (!isQuotaBlocked()) {
      try {
        const snap = await getDocsFromServer(collection(db, 'yearly_targets'));
        trackFirestoreUsage('read', Math.max(1, snap.docs.length));
        snap.docs.forEach((d) => {
          const data = { ...d.data(), id: d.id, _id: d.id };
          yearlyTargetsChannel.docMap.set(d.id, data);
        });
        const merged = finalizeYearlyTargetsList(
          Array.from(yearlyTargetsChannel.docMap.values()),
          yearlyTargetsChannel.archivedIds,
          true
        );
        notifyChannel(yearlyTargetsChannel, merged, true);
        return;
      } catch (err) {
        if (isQuotaError(err)) setQuotaBlocked(15 * 60 * 1000);
        console.warn('Refresh all targets notice:', err);
      }
    }
    await pullSecondaryIntoChannel(yearlyTargetsChannel, 'yearly_targets', finalizeYearlyTargetsList);
  };

  return {
    yearlyTargets,
    loaded,
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
  const uid = (user.uid || '').trim();
  const uidLower = uid.toLowerCase();
  const loginLower = (user.loginId || '').trim().toLowerCase();
  const nameUpper = (user.fullName || '').trim().toUpperCase();

  if (uid) {
    const exactId = `yearly_${uid}_${yearKey}`;
    const byId = sheets.find((s) => s.id === exactId);
    if (byId) return byId;
  }
  if (uidLower) {
    const byUid = sheets.find((s) => (s.userId || '').trim().toLowerCase() === uidLower);
    if (byUid) return byUid;
  }
  if (loginLower) {
    const byLogin = sheets.find(
      (s) =>
        (s.loginId || '').trim().toLowerCase() === loginLower ||
        (s.userId || '').trim().toLowerCase() === loginLower ||
        s.id === `yearly_${loginLower}_${yearKey}`
    );
    if (byLogin) return byLogin;
  }
  if (nameUpper) {
    return sheets.find((s) => (s.fullName || '').trim().toUpperCase() === nameUpper);
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
      if (Array.isArray(parsed)) return parsed;
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
  safeLocalStorageSet('blackworm_cached_travel_sheets', JSON.stringify(merged));
  return merged;
}

function startTravelSheetsListener() {
  if (!travelSheetsChannel.secUnsub) {
    travelSheetsChannel.secUnsub = subscribeSecondaryCollection('travel_sheets', (events) => {
      const updated = applySecondaryDeltas(travelSheetsChannel, 'travel_sheets', events);
      if (updated) {
        notifyChannel(travelSheetsChannel, finalizeTravelSheetsList(updated, travelSheetsChannel.archivedIds, false), true);
      }
    });
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
        const { items } = applyIncrementalSnapshot(travelSheetsChannel, 'travel_sheets', snap);
        const merged = finalizeTravelSheetsList(items, travelSheetsChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(travelSheetsChannel, merged, true);
        if (!snap.metadata?.fromCache) {
          bootstrapCollectionToSecondary('travel_sheets', merged);
        }
      },
      (err) => {
        console.warn('Shared travel_sheets sync notice:', err);
        if (isQuotaError(err)) setQuotaBlocked(15 * 60 * 1000);
        void pullSecondaryIntoChannel(travelSheetsChannel, 'travel_sheets', finalizeTravelSheetsList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared travel_sheets listener:', e);
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

  return { travelSheets, loaded };
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

function applyMasterPricelistDoc(data: any) {
  if (!data || !Array.isArray(data.products) || data.products.length === 0) return;
  const clean = deduplicateProducts(data.products.filter((p: any) => !p.isArchived));
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
  if (!masterPricelistChannel.secUnsub) {
    masterPricelistChannel.secUnsub = subscribeSecondaryCollection('config', (events) => {
      events.forEach((evt) => {
        if (evt.id === 'master_pricelist' && evt.doc && !evt.deleted) {
          applyMasterPricelistDoc(evt.doc);
        }
      });
    });
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
            applyMasterPricelistDoc(data);
            void pushToSecondary({
              collection: 'config',
              id: 'master_pricelist',
              doc: { ...data, id: 'master_pricelist' },
              merge: true,
            });
            return;
          }
        }
        notifyChannel(masterPricelistChannel, masterPricelistChannel.data, true);
      },
      (err) => {
        console.warn('Shared master_pricelist sync notice:', err);
        if (isQuotaError(err)) setQuotaBlocked(15 * 60 * 1000);
        pullMasterPricelistFromSecondary();
      }
    );
  } catch (e) {
    console.warn('Failed to start shared master_pricelist listener:', e);
    pullMasterPricelistFromSecondary();
  }
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

  return { products: state.products, validityDate: state.validityDate, loaded };
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
      if (Array.isArray(parsed)) return parsed.filter((r: any) => r && !r.isArchived);
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
  if (!outstandingChannel.secUnsub) {
    outstandingChannel.secUnsub = subscribeSecondaryCollection('outstanding_records', (events) => {
      const updated = applySecondaryDeltas(outstandingChannel, 'outstanding_records', events);
      if (updated) {
        notifyChannel(outstandingChannel, finalizeOutstandingList(updated, outstandingChannel.archivedIds, false), true);
      }
    });
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
        const { items } = applyIncrementalSnapshot(outstandingChannel, 'outstanding_records', snap);
        const merged = finalizeOutstandingList(items, outstandingChannel.archivedIds, !snap.metadata?.fromCache);
        notifyChannel(outstandingChannel, merged, true);
        if (!snap.metadata?.fromCache && merged.length > 0) {
          bootstrapCollectionToSecondary('outstanding_records', merged);
        }
      },
      (err) => {
        console.warn('Shared outstanding_records sync notice:', err);
        if (isQuotaError(err)) setQuotaBlocked(15 * 60 * 1000);
        void pullSecondaryIntoChannel(outstandingChannel, 'outstanding_records', finalizeOutstandingList);
      }
    );
  } catch (e) {
    console.warn('Failed to start shared outstanding_records listener:', e);
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

  const setOutstandingOptimistic = (updater: (prev: any[]) => any[]) => {
    const next = updater(outstandingChannel.data);
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

function applySchemeDiscountsDoc(data: any) {
  if (data && data.discounts && typeof data.discounts === 'object') {
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
  if (!schemeDiscountsChannel.secUnsub) {
    schemeDiscountsChannel.secUnsub = subscribeSecondaryCollection('config', (events) => {
      events.forEach((evt) => {
        if (evt.id === 'schemes_extra_discounts' && evt.doc && !evt.deleted) {
          applySchemeDiscountsDoc(evt.doc);
        }
      });
    });
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
          applySchemeDiscountsDoc(data);
          void pushToSecondary({
            collection: 'config',
            id: 'schemes_extra_discounts',
            doc: { ...data, id: 'schemes_extra_discounts' },
            merge: true,
          });
        } else {
          notifyChannel(schemeDiscountsChannel, schemeDiscountsChannel.data, true);
        }
      },
      (err) => {
        console.warn('Shared schemes_extra_discounts sync notice:', err);
        if (isQuotaError(err)) setQuotaBlocked(15 * 60 * 1000);
        pullSchemeDiscountsFromSecondary();
      }
    );
  } catch (e) {
    console.warn('Failed to start shared schemes_extra_discounts listener:', e);
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
    const next = updater(schemeDiscountsChannel.data);
    safeLocalStorageSet(SCHEME_DISCOUNTS_KEY, JSON.stringify(next));
    notifyChannel(schemeDiscountsChannel, next, schemeDiscountsChannel.loaded);
  };

  return { discounts, loaded, setDiscountsOptimistic };
}
