import { useEffect, useState } from 'react';
import { doc, getDocFromServer, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { isQuotaBlocked, safeFirestoreSet, setQuotaBlocked, trackFirestoreUsage } from './dataService';
import { fetchSecondaryCollection, pushToSecondary, subscribeSecondaryCollection } from './secondaryDb';
import {
  MODULE_SEEN_EVENT,
  ModuleSeenMap,
  areModuleSeenMapsEqual,
  getSeenCloudDocId,
  loadModuleSeenMap,
  mergeModuleSeenMaps,
  notifyModuleSeenUpdated,
  sanitizeModuleSeenMap,
  saveModuleSeenMap,
} from './moduleUpdates';

export const BLACKWORM_BDAY_SEEN_EVENT = 'blackworm_bday_seen_updated';

type BdaySeenMap = Record<string, string[]>;

function getBdayStorageKey(uid: string, dateKey: string): string {
  return `blackworm_bday_seen_${uid}_${dateKey}`;
}

function sanitizeBdaySeenMap(raw: any): BdaySeenMap {
  const out: BdaySeenMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const dateKeys = Object.keys(raw)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort()
    .slice(-14);
  for (const dk of dateKeys) {
    const val = raw[dk];
    if (!Array.isArray(val)) continue;
    const clean = Array.from(new Set(val.map((x) => String(x || '').trim()).filter(Boolean))).sort();
    if (clean.length > 0) out[dk] = clean;
  }
  return out;
}

function mergeBdaySeenMaps(aRaw: any, bRaw: any): BdaySeenMap {
  const a = sanitizeBdaySeenMap(aRaw);
  const b = sanitizeBdaySeenMap(bRaw);
  const allKeys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))
    .sort()
    .slice(-14);
  const out: BdaySeenMap = {};
  for (const dk of allKeys) {
    const merged = Array.from(new Set([...(a[dk] || []), ...(b[dk] || [])])).sort();
    if (merged.length > 0) out[dk] = merged;
  }
  return out;
}

function areBdaySeenMapsEqual(aRaw: BdaySeenMap, bRaw: BdaySeenMap): boolean {
  const a = sanitizeBdaySeenMap(aRaw);
  const b = sanitizeBdaySeenMap(bRaw);
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i += 1) {
    const k = ak[i];
    if (k !== bk[i]) return false;
    const av = a[k];
    const bv = b[k];
    if (av.length !== bv.length) return false;
    for (let j = 0; j < av.length; j += 1) {
      if (av[j] !== bv[j]) return false;
    }
  }
  return true;
}

function loadLocalBdaySeenMap(uid: string): BdaySeenMap {
  if (typeof window === 'undefined' || !uid) return {};
  const prefix = `blackworm_bday_seen_${uid}_`;
  const rawMap: BdaySeenMap = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const dateKey = key.slice(prefix.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
      const parsed = JSON.parse(localStorage.getItem(key) || '[]');
      if (Array.isArray(parsed)) {
        rawMap[dateKey] = parsed.map(String);
      }
    }
  } catch {}
  return sanitizeBdaySeenMap(rawMap);
}

function saveLocalBdaySeenMap(uid: string, map: BdaySeenMap): void {
  if (typeof window === 'undefined' || !uid) return;
  try {
    for (const [dateKey, ids] of Object.entries(map)) {
      localStorage.setItem(getBdayStorageKey(uid, dateKey), JSON.stringify(ids));
    }
  } catch {}
}

export function loadSyncedBirthdaySeenIds(uid: string | undefined | null, dateKey: string): string[] {
  if (typeof window === 'undefined' || !uid || !dateKey) return [];
  try {
    const raw = localStorage.getItem(getBdayStorageKey(uid, dateKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function markBirthdaySeenSynced(
  uid: string | undefined | null,
  dateKey: string,
  ids: string[]
): void {
  if (typeof window === 'undefined' || !uid || !dateKey || !Array.isArray(ids) || ids.length === 0) return;
  try {
    const existing = loadSyncedBirthdaySeenIds(uid, dateKey);
    const merged = Array.from(new Set([...existing, ...ids.map(String)])).filter(Boolean).sort();
    localStorage.setItem(getBdayStorageKey(uid, dateKey), JSON.stringify(merged));
    window.dispatchEvent(
      new CustomEvent(BLACKWORM_BDAY_SEEN_EVENT, {
        detail: { uid, dateKey, ids: merged, source: 'local' },
      })
    );
  } catch {}
}

interface SyncController {
  uid: string;
  docId: string;
  hydrated: boolean;
  subscribers: Set<(hydrated: boolean) => void>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  hydrateTimeout: ReturnType<typeof setTimeout> | null;
  unsubSec: (() => void) | null;
  unsubFb: (() => void) | null;
  lastCloudSeenMap: ModuleSeenMap;
  lastCloudBdayMap: BdaySeenMap;
  hasRemoteSnapshot: boolean;
  pendingDirtyFlush: boolean;
  onSeenEvent: ((e: Event) => void) | null;
  onBdayEvent: ((e: Event) => void) | null;
  onVisibility: (() => void) | null;
  onQuotaCleared: (() => void) | null;
  onResync: (() => void) | null;
}

const controllersByUid = new Map<string, SyncController>();

function notifyHydrated(ctrl: SyncController) {
  if (ctrl.hydrated) return;
  ctrl.hydrated = true;
  if (ctrl.hydrateTimeout) {
    clearTimeout(ctrl.hydrateTimeout);
    ctrl.hydrateTimeout = null;
  }
  ctrl.subscribers.forEach((cb) => {
    try {
      cb(true);
    } catch {}
  });
}

async function flushControllerToCloud(ctrl: SyncController) {
  if (ctrl.flushTimer) {
    clearTimeout(ctrl.flushTimer);
    ctrl.flushTimer = null;
  }
  ctrl.pendingDirtyFlush = false;

  const localSeen = loadModuleSeenMap(ctrl.uid);
  const mergedSeen = mergeModuleSeenMaps(localSeen, ctrl.lastCloudSeenMap);
  if (!areModuleSeenMapsEqual(localSeen, mergedSeen)) {
    saveModuleSeenMap(ctrl.uid, mergedSeen);
    notifyModuleSeenUpdated(ctrl.uid, '*', 'remote');
  }

  const localBday = loadLocalBdaySeenMap(ctrl.uid);
  const mergedBday = mergeBdaySeenMaps(localBday, ctrl.lastCloudBdayMap);
  if (!areBdaySeenMapsEqual(localBday, mergedBday)) {
    saveLocalBdaySeenMap(ctrl.uid, mergedBday);
  }

  const seenChanged = !areModuleSeenMapsEqual(mergedSeen, ctrl.lastCloudSeenMap);
  const bdayChanged = !areBdaySeenMapsEqual(mergedBday, ctrl.lastCloudBdayMap);
  if (!seenChanged && !bdayChanged) return;
  if (Object.keys(mergedSeen).length === 0 && Object.keys(mergedBday).length === 0) return;

  ctrl.lastCloudSeenMap = mergedSeen;
  ctrl.lastCloudBdayMap = mergedBday;

  const payload = {
    id: ctrl.docId,
    uid: ctrl.uid,
    seenMap: mergedSeen,
    bdaySeen: mergedBday,
    isArchived: false,
    updatedAt: new Date().toISOString(),
  };

  try {
    await safeFirestoreSet('config', ctrl.docId, payload, { merge: true });
  } catch {}
}

function scheduleFlush(ctrl: SyncController, immediate = false) {
  ctrl.pendingDirtyFlush = true;
  if (ctrl.flushTimer) {
    clearTimeout(ctrl.flushTimer);
    ctrl.flushTimer = null;
  }
  if (immediate) {
    void flushControllerToCloud(ctrl);
    return;
  }
  ctrl.flushTimer = setTimeout(() => {
    ctrl.flushTimer = null;
    void flushControllerToCloud(ctrl);
  }, 120);
}

function applyRemoteSeenDoc(ctrl: SyncController, remoteDoc: any) {
  if (!remoteDoc || typeof remoteDoc !== 'object' || remoteDoc.isArchived) return;
  ctrl.hasRemoteSnapshot = true;

  const remoteSeen = sanitizeModuleSeenMap(remoteDoc.seenMap);
  const remoteBday = sanitizeBdaySeenMap(remoteDoc.bdaySeen);
  ctrl.lastCloudSeenMap = mergeModuleSeenMaps(ctrl.lastCloudSeenMap, remoteSeen);
  ctrl.lastCloudBdayMap = mergeBdaySeenMaps(ctrl.lastCloudBdayMap, remoteBday);

  const localSeen = loadModuleSeenMap(ctrl.uid);
  const mergedSeen = mergeModuleSeenMaps(localSeen, remoteSeen);

  if (!areModuleSeenMapsEqual(localSeen, mergedSeen)) {
    saveModuleSeenMap(ctrl.uid, mergedSeen);
    notifyModuleSeenUpdated(ctrl.uid, '*', 'remote');
  }

  const localBday = loadLocalBdaySeenMap(ctrl.uid);
  const mergedBday = mergeBdaySeenMaps(localBday, remoteBday);
  if (!areBdaySeenMapsEqual(localBday, mergedBday)) {
    saveLocalBdaySeenMap(ctrl.uid, mergedBday);
    try {
      window.dispatchEvent(
        new CustomEvent(BLACKWORM_BDAY_SEEN_EVENT, {
          detail: { uid: ctrl.uid, source: 'remote' },
        })
      );
    } catch {}
  }

  // If this device had local seen markers not yet stored in remote cloud doc, sync them up
  if (
    !areModuleSeenMapsEqual(mergedSeen, remoteSeen) ||
    !areBdaySeenMapsEqual(mergedBday, remoteBday)
  ) {
    scheduleFlush(ctrl);
  }
}

function startFirestoreListener(ctrl: SyncController) {
  if (ctrl.unsubFb || isQuotaBlocked()) return;
  try {
    ctrl.unsubFb = onSnapshot(
      doc(db, 'config', ctrl.docId),
      (snap) => {
        trackFirestoreUsage('read', 1);
        if (snap.exists()) {
          const data = snap.data();
          applyRemoteSeenDoc(ctrl, { ...data, id: ctrl.docId });
          if (!snap.metadata?.fromCache) {
            void pushToSecondary({
              collection: 'config',
              id: ctrl.docId,
              doc: { ...data, id: ctrl.docId },
              merge: true,
              isBootstrap: true,
            });
          }
        }
        if (!snap.metadata?.fromCache || snap.exists()) {
          notifyHydrated(ctrl);
        }
      },
      (err) => {
        if (ctrl.unsubFb) {
          try {
            ctrl.unsubFb();
          } catch {}
          ctrl.unsubFb = null;
        }
        const msg = String(err?.message || '').toLowerCase();
        if (msg.includes('quota') || msg.includes('resource_exhausted')) {
          setQuotaBlocked(2 * 60 * 1000);
        }
        notifyHydrated(ctrl);
      }
    );
  } catch {
    ctrl.unsubFb = null;
  }
}

function ensureController(uid: string): SyncController {
  const existing = controllersByUid.get(uid);
  if (existing) return existing;

  const ctrl: SyncController = {
    uid,
    docId: getSeenCloudDocId(uid),
    hydrated: false,
    subscribers: new Set(),
    flushTimer: null,
    hydrateTimeout: null,
    unsubSec: null,
    unsubFb: null,
    lastCloudSeenMap: {},
    lastCloudBdayMap: {},
    hasRemoteSnapshot: false,
    pendingDirtyFlush: false,
    onSeenEvent: null,
    onBdayEvent: null,
    onVisibility: null,
    onQuotaCleared: null,
    onResync: null,
  };
  controllersByUid.set(uid, ctrl);

  if (typeof window === 'undefined') {
    ctrl.hydrated = true;
    return ctrl;
  }

  let secDone = false;
  let fbDone = isQuotaBlocked() || (typeof navigator !== 'undefined' && !navigator.onLine);
  const maybeMarkHydrated = () => {
    if (ctrl.hasRemoteSnapshot || (secDone && fbDone)) {
      // If neither remote had data yet, migrate any pre-existing local seen state upward
      const localSeen = loadModuleSeenMap(ctrl.uid);
      const localBday = loadLocalBdaySeenMap(ctrl.uid);
      if (
        (!areModuleSeenMapsEqual(localSeen, ctrl.lastCloudSeenMap) ||
          !areBdaySeenMapsEqual(localBday, ctrl.lastCloudBdayMap)) &&
        (Object.keys(localSeen).length > 0 || Object.keys(localBday).length > 0)
      ) {
        scheduleFlush(ctrl);
      }
      notifyHydrated(ctrl);
    }
  };

  ctrl.hydrateTimeout = setTimeout(() => {
    secDone = true;
    fbDone = true;
    maybeMarkHydrated();
  }, 1500);

  const pullSecondarySeen = async () => {
    try {
      const res = await fetchSecondaryCollection('config', { limit: 1000 });
      if (res.ok) {
        const match = res.items.find((it) => it?.id === ctrl.docId);
        if (match) {
          applyRemoteSeenDoc(ctrl, match);
        }
      }
    } finally {
      secDone = true;
      maybeMarkHydrated();
    }
  };

  ctrl.unsubSec = subscribeSecondaryCollection('config', (events) => {
    events.forEach((evt) => {
      if (evt.id === ctrl.docId && evt.doc && !evt.deleted) {
        applyRemoteSeenDoc(ctrl, {
          ...evt.doc,
          ...(evt.updatedAtMs ? { _syncUpdatedAtMs: evt.updatedAtMs } : {}),
        });
        notifyHydrated(ctrl);
      }
    });
  });

  void pullSecondarySeen();

  if (!fbDone) {
    void getDocFromServer(doc(db, 'config', ctrl.docId))
      .then((snap) => {
        trackFirestoreUsage('read', 1);
        if (snap.exists()) {
          const data = snap.data();
          applyRemoteSeenDoc(ctrl, { ...data, id: ctrl.docId });
          void pushToSecondary({
            collection: 'config',
            id: ctrl.docId,
            doc: { ...data, id: ctrl.docId },
            merge: true,
            isBootstrap: true,
          });
        }
      })
      .catch((err) => {
        const msg = String(err?.message || '').toLowerCase();
        if (msg.includes('quota') || msg.includes('resource_exhausted')) {
          setQuotaBlocked(2 * 60 * 1000);
        }
      })
      .finally(() => {
        fbDone = true;
        maybeMarkHydrated();
      });
  }

  startFirestoreListener(ctrl);

  ctrl.onSeenEvent = (e: Event) => {
    const detail = (e as CustomEvent)?.detail;
    if (!detail || detail.uid !== ctrl.uid) return;
    if (detail.source === 'remote') return;
    scheduleFlush(ctrl);
  };
  ctrl.onBdayEvent = (e: Event) => {
    const detail = (e as CustomEvent)?.detail;
    if (!detail || detail.uid !== ctrl.uid) return;
    if (detail.source === 'remote') return;
    scheduleFlush(ctrl);
  };
  ctrl.onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && ctrl.pendingDirtyFlush) {
      void flushControllerToCloud(ctrl);
    }
  };
  ctrl.onQuotaCleared = () => {
    startFirestoreListener(ctrl);
  };
  ctrl.onResync = () => {
    void pullSecondarySeen();
  };

  window.addEventListener(MODULE_SEEN_EVENT, ctrl.onSeenEvent);
  window.addEventListener(BLACKWORM_BDAY_SEEN_EVENT, ctrl.onBdayEvent);
  document.addEventListener('visibilitychange', ctrl.onVisibility);
  window.addEventListener('blackworm_quota_cleared', ctrl.onQuotaCleared);
  window.addEventListener('blackworm_secondary_resync', ctrl.onResync);

  return ctrl;
}

function cleanupControllerIfIdle(uid: string) {
  const ctrl = controllersByUid.get(uid);
  if (!ctrl || ctrl.subscribers.size > 0) return;

  if (ctrl.pendingDirtyFlush) {
    void flushControllerToCloud(ctrl);
  }
  if (ctrl.flushTimer) clearTimeout(ctrl.flushTimer);
  if (ctrl.hydrateTimeout) clearTimeout(ctrl.hydrateTimeout);
  if (ctrl.unsubSec) {
    try {
      ctrl.unsubSec();
    } catch {}
  }
  if (ctrl.unsubFb) {
    try {
      ctrl.unsubFb();
    } catch {}
  }
  if (typeof window !== 'undefined') {
    if (ctrl.onSeenEvent) window.removeEventListener(MODULE_SEEN_EVENT, ctrl.onSeenEvent);
    if (ctrl.onBdayEvent) window.removeEventListener(BLACKWORM_BDAY_SEEN_EVENT, ctrl.onBdayEvent);
    if (ctrl.onVisibility) document.removeEventListener('visibilitychange', ctrl.onVisibility);
    if (ctrl.onQuotaCleared) window.removeEventListener('blackworm_quota_cleared', ctrl.onQuotaCleared);
    if (ctrl.onResync) window.removeEventListener('blackworm_secondary_resync', ctrl.onResync);
  }
  controllersByUid.delete(uid);
}

/**
 * Real-time per-user read/seen & birthday-ack sync hook.
 * Synchronizes `config/user_seen_<safeUid>` across Primary Firestore and Secondary SQLite + SSE.
 */
export function useModuleSeenCloudSync(uid?: string | null): { cloudHydrated: boolean } {
  const cleanUid = String(uid || '').trim();
  const [cloudHydrated, setCloudHydrated] = useState<boolean>(() => {
    if (!cleanUid || typeof window === 'undefined') return true;
    return controllersByUid.get(cleanUid)?.hydrated ?? false;
  });

  useEffect(() => {
    if (!cleanUid || cleanUid === 'user' || typeof window === 'undefined') {
      setCloudHydrated(true);
      return;
    }
    const ctrl = ensureController(cleanUid);
    setCloudHydrated(ctrl.hydrated);
    const cb = (val: boolean) => setCloudHydrated(val);
    ctrl.subscribers.add(cb);

    return () => {
      ctrl.subscribers.delete(cb);
      cleanupControllerIfIdle(cleanUid);
    };
  }, [cleanUid]);

  return { cloudHydrated };
}
