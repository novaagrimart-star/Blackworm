import { loadCollectionFromVault, saveCollectionToVault } from './localVault';
import { resolveApiUrl, triggerVersionCheckFromSse } from './appVersion';
import { isRecordDeleted, mergeTravelSheetDocs } from './travelMerge';

export interface SecondaryDeltaEvent {
  collection: string;
  id: string;
  doc: Record<string, any> | null;
  deleted: boolean;
  updatedAtMs: number;
  revision: number;
}

export interface SecondaryUpsertPayload {
  collection: string;
  id: string;
  doc: Record<string, any>;
  updatedAtMs?: number;
  deleted?: boolean;
  merge?: boolean;
  isBootstrap?: boolean;
}

export interface SecondarySyncStatus {
  healthy: boolean;
  transport: 'sse' | 'polling' | 'offline';
  latestRevision: number;
  serverEpoch?: string;
  lastSyncAtMs: number;
  totalRecords?: number;
}

export interface SecondarySummary {
  ok: boolean;
  engine?: string;
  serverEpoch?: string;
  totalRecords?: number;
  latestRevision?: number;
  connectedClients?: number;
  collections?: Record<string, number>;
}

const REV_STORAGE_KEY = 'blackworm_secondary_rev';
const EPOCH_STORAGE_KEY = 'blackworm_secondary_epoch';
const BC_CHANNEL_NAME = 'blackworm_sync_bc_v1';

const listenersByCollection = new Map<string, Set<(events: SecondaryDeltaEvent[]) => void>>();
const bootstrapDocSigMap = new Map<string, Map<string, string>>();

const CORE_COLLECTIONS_TO_HYDRATE = [
  'users',
  'orders',
  'dealers_application',
  'collection_entries',
  'yearly_targets',
  'travel_sheets',
  'outstanding_records',
  'location_villages',
  'location_talukas',
  'office_staff_members',
  'office_staff_attendance',
  'config',
  'products_pricelist_v2',
  'targets',
  'user_approval_requests',
];

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let deltaPollTimer: ReturnType<typeof setInterval> | null = null;
let visibilityHooksAttached = false;
let broadcastChannel: BroadcastChannel | null = null;
let reconnectDelayMs = 2000;
let secondaryDownUntil = 0;
let currentTransport: 'sse' | 'polling' | 'offline' = 'polling';
let lastSyncAtMs = 0;
let lastSseDeltaAtMs = 0;
let lastSseConnectedAtMs = 0;
let isPullingChanges = false;
let hasHydratedServerOnce = false;
let zeroResyncDispatchedOnce = false;
let lastSummaryCache: SecondarySummary | null = null;

function getStoredRevision(): number {
  try {
    if (typeof window === 'undefined') return 0;
    const raw = localStorage.getItem(REV_STORAGE_KEY);
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : 0;
  } catch {
    return 0;
  }
}

function setStoredRevision(rev: number, allowDecrease = false) {
  try {
    if (typeof window === 'undefined' || !Number.isFinite(rev) || rev < 0) return;
    if (allowDecrease) {
      localStorage.setItem(REV_STORAGE_KEY, String(rev));
      return;
    }
    if (rev <= 0) return;
    const cur = getStoredRevision();
    if (rev > cur) {
      localStorage.setItem(REV_STORAGE_KEY, String(rev));
    }
  } catch {}
}

function getStoredEpoch(): string {
  try {
    if (typeof window === 'undefined') return '';
    return String(localStorage.getItem(EPOCH_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

function setStoredEpoch(epoch: string) {
  try {
    if (typeof window === 'undefined' || !epoch) return;
    localStorage.setItem(EPOCH_STORAGE_KEY, epoch);
  } catch {}
}

/**
 * Detects if the backend SQLite container restarted or reset to a new epoch / lower revision.
 * Prevents the client from staying stuck on an old high revision cursor forever.
 */
function reconcileServerEpochAndRev(serverEpoch?: string, serverLatestRev?: number): boolean {
  if (typeof window === 'undefined') return false;
  const cleanEpoch = String(serverEpoch || '').trim();
  const prevEpoch = getStoredEpoch();
  const curRev = getStoredRevision();
  const revNum = Number(serverLatestRev);

  const epochChanged = Boolean(cleanEpoch && prevEpoch && cleanEpoch !== prevEpoch);
  const revRegressed = Number.isFinite(revNum) && curRev > 0 && revNum < curRev;

  if (cleanEpoch && !prevEpoch) {
    setStoredEpoch(cleanEpoch);
  }

  if (epochChanged || revRegressed) {
    if (cleanEpoch) setStoredEpoch(cleanEpoch);
    setStoredRevision(0, true);
    hasHydratedServerOnce = false;
    zeroResyncDispatchedOnce = false;

    // Recycle SSE so its sinceRevision resets to 0 cleanly
    if (eventSource) {
      try {
        eventSource.close();
      } catch {}
      eventSource = null;
    }

    try {
      window.dispatchEvent(
        new CustomEvent('blackworm_secondary_resync', {
          detail: { reason: epochChanged ? 'epoch_changed' : 'rev_regressed', serverEpoch: cleanEpoch },
        })
      );
    } catch {}
    // Re-hydrate cold server from this device's local cache without blocking UI
    void autoHydrateServerFromLocalCache(false);
    // Reconnect live SSE with clean sinceRevision=0 after epoch/revision reset
    setTimeout(() => {
      if (listenersByCollection.size > 0 && !eventSource) {
        initSecondaryStream();
      }
    }, 300);
    return true;
  }

  return false;
}

export function isSecondaryBlocked(): boolean {
  if (secondaryDownUntil <= 0) return false;
  if (Date.now() >= secondaryDownUntil) {
    secondaryDownUntil = 0;
    return false;
  }
  return true;
}

function markSecondaryDown(ms = 8000) {
  secondaryDownUntil = Date.now() + ms;
  currentTransport = 'offline';
}

function markSecondaryHealthy(mode?: 'sse' | 'polling') {
  secondaryDownUntil = 0;
  lastSyncAtMs = Date.now();
  if (mode) currentTransport = mode;
}

export function getSecondarySyncStatus(): SecondarySyncStatus {
  return {
    healthy: !isSecondaryBlocked() && (typeof navigator === 'undefined' || navigator.onLine),
    transport: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : currentTransport,
    latestRevision: getStoredRevision(),
    serverEpoch: getStoredEpoch() || lastSummaryCache?.serverEpoch,
    lastSyncAtMs,
    totalRecords: lastSummaryCache?.totalRecords,
  };
}

function parseSyncTs(obj: any): number {
  if (!obj || typeof obj !== 'object') return 0;
  if (typeof obj._syncUpdatedAtMs === 'number' && Number.isFinite(obj._syncUpdatedAtMs)) {
    return obj._syncUpdatedAtMs;
  }
  const str = obj.updatedAt || obj.markedAt || obj.createdAt;
  if (typeof str === 'string' && str) {
    const p = Date.parse(str);
    if (Number.isFinite(p)) return p;
  }
  return 0;
}

function persistDeltasBatchToLocalCache(colName: string, events: SecondaryDeltaEvent[]) {
  try {
    if (typeof window === 'undefined' || !colName || events.length === 0) return;
    const storageKey = `blackworm_local_${colName}`;
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    const map: Record<string, any> = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    let mutated = false;

    const pendingLocalTs = new Map<string, { ts: number; needsSecondary: boolean }>();
    try {
      const pRaw = localStorage.getItem('blackworm_pending_sync');
      if (pRaw) {
        const pQueue = JSON.parse(pRaw);
        if (Array.isArray(pQueue)) {
          for (const pq of pQueue) {
            if (pq && pq.collection === colName && pq.id && pq.needsSecondary !== false) {
              pendingLocalTs.set(String(pq.id), {
                ts: Number(pq.timestamp) || Number(pq.data?._syncUpdatedAtMs) || 0,
                needsSecondary: true,
              });
            }
          }
        }
      }
    } catch {}

    for (const evt of events) {
      if (!evt?.id) continue;
      const pendingInfo = pendingLocalTs.get(evt.id);
      const evtTs = Number(evt.updatedAtMs) || 0;
      if (pendingInfo && pendingInfo.needsSecondary && pendingInfo.ts > evtTs) {
        continue;
      }
      if (evt.deleted || isRecordDeleted(evt.doc)) {
        if (evt.id in map) {
          delete map[evt.id];
          mutated = true;
        }
        continue;
      }
      if (evt.doc && typeof evt.doc === 'object') {
        const incoming: Record<string, any> = {
          ...evt.doc,
          id: evt.id,
          ...(evt.updatedAtMs ? { _syncUpdatedAtMs: evt.updatedAtMs } : {}),
        };
        const prev = map[evt.id];
        const prevTs = parseSyncTs(prev);
        const nextTs = Math.max(evtTs, parseSyncTs(incoming));
        if (colName === 'travel_sheets' && prev && Array.isArray(prev.rows) && Array.isArray(incoming.rows)) {
          const mergedTravel = mergeTravelSheetDocs(prev, incoming);
          delete mergedTravel._localSavedAt;
          if (JSON.stringify(prev) !== JSON.stringify(mergedTravel)) {
            map[evt.id] = mergedTravel;
            mutated = true;
          }
          if (mergedTravel.userId && mergedTravel.yearNumber && mergedTravel.monthName) {
            try {
              const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
              const mIdx = typeof mergedTravel.monthIndex === 'number'
                ? mergedTravel.monthIndex
                : monthNames.findIndex((m) => m.toLowerCase() === String(mergedTravel.monthName || '').toLowerCase());
              const mm = mIdx >= 0 ? String(mIdx + 1).padStart(2, '0') : '';
              const sheetCacheKey = mm ? `travel_sheet_${mergedTravel.userId}_${mergedTravel.yearNumber}_${mm}` : '';
              if (sheetCacheKey) {
                const rawDraft = localStorage.getItem(sheetCacheKey);
                if (rawDraft) {
                  const parsedDraft = JSON.parse(rawDraft);
                  const draftMerged = mergeTravelSheetDocs(parsedDraft, mergedTravel);
                  localStorage.setItem(sheetCacheKey, JSON.stringify(draftMerged));
                } else {
                  localStorage.setItem(sheetCacheKey, JSON.stringify(mergedTravel));
                }
              }
            } catch {}
          }
        } else if (!prev || nextTs > prevTs) {
          const cleanDoc: Record<string, any> = prev
            ? {
                ...(prev.createdAt && !incoming.createdAt ? { createdAt: prev.createdAt } : {}),
                ...incoming,
              }
            : incoming;
          delete cleanDoc._localSavedAt;
          map[evt.id] = cleanDoc;
          mutated = true;

          // Keep TravelView/ReportView per-sheet localStorage mirrors in sync when a newer remote travel_sheet arrives
          if (colName === 'travel_sheets' && cleanDoc.userId && cleanDoc.yearNumber && cleanDoc.monthName) {
            try {
              const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
              const mIdx = typeof cleanDoc.monthIndex === 'number'
                ? cleanDoc.monthIndex
                : monthNames.findIndex((m) => m.toLowerCase() === String(cleanDoc.monthName || '').toLowerCase());
              const mm = mIdx >= 0 ? String(mIdx + 1).padStart(2, '0') : '';
              const sheetCacheKey = mm ? `travel_sheet_${cleanDoc.userId}_${cleanDoc.yearNumber}_${mm}` : '';
              if (sheetCacheKey) {
                const rawDraft = localStorage.getItem(sheetCacheKey);
                if (rawDraft) {
                  const parsedDraft = JSON.parse(rawDraft);
                  const draftMerged = mergeTravelSheetDocs(parsedDraft, cleanDoc);
                  localStorage.setItem(sheetCacheKey, JSON.stringify(draftMerged));
                } else {
                  localStorage.setItem(sheetCacheKey, JSON.stringify(cleanDoc));
                }
              }
            } catch {}
          }
        }
      }
    }

    if (mutated) {
      void saveCollectionToVault(colName, map);
      try {
        localStorage.setItem(storageKey, JSON.stringify(map));
      } catch {
        try {
          localStorage.removeItem('blackworm_report_static_cache_v4');
          localStorage.removeItem('blackworm_all_dealers');
          localStorage.setItem(storageKey, JSON.stringify(map));
        } catch {}
      }
    }
  } catch {}
}

function initBroadcastChannel() {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined' || broadcastChannel) return;
  try {
    broadcastChannel = new BroadcastChannel(BC_CHANNEL_NAME);
    broadcastChannel.onmessage = (msg) => {
      const payload = msg?.data;
      if (payload?.type === 'deltas' && Array.isArray(payload.events)) {
        dispatchDeltaBatch(payload.events as SecondaryDeltaEvent[], false);
      } else if (payload?.type === 'local_mutation' && payload.detail?.collection && payload.detail?.id) {
        const d = payload.detail;
        const deltaEvt: SecondaryDeltaEvent = {
          collection: String(d.collection),
          id: String(d.id),
          doc: d.doc && typeof d.doc === 'object' ? d.doc : null,
          deleted: Boolean(d.deleted),
          updatedAtMs: Number(d.updatedAtMs) || Date.now(),
          revision: 0,
        };
        persistDeltasBatchToLocalCache(deltaEvt.collection, [deltaEvt]);
        const set = listenersByCollection.get(deltaEvt.collection);
        if (set && set.size > 0) {
          set.forEach((cb) => {
            try {
              cb([deltaEvt]);
            } catch {}
          });
        }
        try {
          window.dispatchEvent(
            new CustomEvent('blackworm_local_record_mutation', {
              detail: { ...d, fromRemote: true },
            })
          );
        } catch {}
      }
    };
  } catch {}
}

export function broadcastLocalMutation(detail: {
  collection: string;
  id: string;
  doc?: Record<string, any> | null;
  merge?: boolean;
  deleted?: boolean;
  updatedAtMs?: number;
}) {
  if (typeof window === 'undefined' || !detail?.collection || !detail?.id) return;
  initBroadcastChannel();
  try {
    broadcastChannel?.postMessage({ type: 'local_mutation', detail });
  } catch {}
}

function broadcastToTabs(events: SecondaryDeltaEvent[]) {
  if (!events.length) return;
  initBroadcastChannel();
  try {
    broadcastChannel?.postMessage({ type: 'deltas', events });
  } catch {}
}

function dispatchDeltaBatch(events: SecondaryDeltaEvent[], relayToOtherTabs = true) {
  if (!Array.isArray(events) || events.length === 0) return;

  const validEvents: SecondaryDeltaEvent[] = [];
  const byCol = new Map<string, SecondaryDeltaEvent[]>();
  let maxRev = 0;

  for (const evt of events) {
    if (!evt || !evt.collection || !evt.id) continue;
    validEvents.push(evt);
    if (evt.revision && evt.revision > maxRev) maxRev = evt.revision;
    const list = byCol.get(evt.collection);
    if (list) list.push(evt);
    else byCol.set(evt.collection, [evt]);
  }

  if (maxRev > 0) {
    setStoredRevision(maxRev);
  }

  byCol.forEach((colEvents, colName) => {
    persistDeltasBatchToLocalCache(colName, colEvents);
    const set = listenersByCollection.get(colName);
    if (set && set.size > 0) {
      set.forEach((cb) => {
        try {
          cb(colEvents);
        } catch (e) {
          console.warn('Secondary subscriber callback notice:', e);
        }
      });
    }
  });

  if (relayToOtherTabs && validEvents.length > 0) {
    broadcastToTabs(validEvents);
  }
  try {
    if (typeof window !== 'undefined' && validEvents.length > 0) {
      for (const evt of validEvents) {
        window.dispatchEvent(
          new CustomEvent('blackworm_local_record_mutation', {
            detail: {
              collection: evt.collection,
              id: evt.id,
              doc: evt.doc,
              merge: true,
              deleted: Boolean(evt.deleted || isRecordDeleted(evt.doc)),
              updatedAtMs: evt.updatedAtMs,
              fromRemote: true,
            },
          })
        );
      }
      window.dispatchEvent(new CustomEvent('blackworm_secondary_delta', { detail: validEvents[validEvents.length - 1] }));
    }
  } catch {}
}

function dispatchDelta(evt: SecondaryDeltaEvent, relayToOtherTabs = true) {
  dispatchDeltaBatch([evt], relayToOtherTabs);
}

/**
 * HTTP Delta Polling catchup (Option 2B failover when SSE is blocked/paused on mobile proxies)
 */
export async function pullSecondaryChanges(forceFullResyncIfZero = false): Promise<number> {
  if (typeof window === 'undefined') return 0;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0;
  if (isPullingChanges) return 0;

  isPullingChanges = true;
  let totalPulled = 0;
  const PAGE_LIMIT = 2000;
  try {
    for (let page = 0; page < 6; page++) {
      let rev = getStoredRevision();
      const epoch = getStoredEpoch();

      if (page === 0 && rev === 0 && (forceFullResyncIfZero || !zeroResyncDispatchedOnce)) {
        zeroResyncDispatchedOnce = true;
        window.dispatchEvent(new CustomEvent('blackworm_secondary_resync', { detail: { reason: 'rev_zero' } }));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        resolveApiUrl(`/api/sync/changes?since=${encodeURIComponent(String(rev))}&epoch=${encodeURIComponent(epoch)}&limit=${PAGE_LIMIT}`),
        { signal: controller.signal }
      );
      clearTimeout(timer);

      if (!res.ok) break;
      const json = await res.json();

      const wasReset =
        rev > 0 &&
        (Boolean(json?.resetRequired) || reconcileServerEpochAndRev(json?.serverEpoch, json?.latestRevision));

      if (json?.serverEpoch) {
        setStoredEpoch(String(json.serverEpoch));
      }

      const events: SecondaryDeltaEvent[] = Array.isArray(json?.events) ? json.events : [];
      if (events.length > 0) {
        totalPulled += events.length;
        dispatchDeltaBatch(events);
        if (rev > 0 && !wasReset && eventSource && Date.now() - Math.max(lastSseDeltaAtMs, lastSseConnectedAtMs) > 8000) {
          try {
            eventSource.close();
          } catch {}
          eventSource = null;
          setTimeout(() => initSecondaryStream(), 500);
        }
        const lastEvtRev = Number(events[events.length - 1].revision) || 0;
        if (lastEvtRev > 0) {
          setStoredRevision(lastEvtRev, wasReset);
        }
      } else if (json?.latestRevision) {
        setStoredRevision(Number(json.latestRevision), wasReset);
      }

      markSecondaryHealthy(eventSource && eventSource.readyState === 1 ? 'sse' : 'polling');
      if (events.length < PAGE_LIMIT) break;
    }
    return totalPulled;
  } catch {
    return totalPulled;
  } finally {
    isPullingChanges = false;
  }
}

function attachVisibilityAndPollingHooks() {
  if (typeof window === 'undefined' || visibilityHooksAttached) return;
  visibilityHooksAttached = true;
  initBroadcastChannel();

  const triggerWakeCatchup = () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (!eventSource) initSecondaryStream();
    void pullSecondaryChanges(false);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blackworm_secondary_resync', { detail: { reason: 'wake' } }));
    }
  };

  window.addEventListener('focus', triggerWakeCatchup);
  window.addEventListener('online', triggerWakeCatchup);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        triggerWakeCatchup();
      }
    });
  }

  // Reliable 4s active-tab HTTP delta heartbeat (works even when mobile carrier/proxy silently drops SSE)
  deltaPollTimer = setInterval(() => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void pullSecondaryChanges(false);
  }, 4000);
}

export function initSecondaryStream(): void {
  if (typeof window === 'undefined') return;
  attachVisibilityAndPollingHooks();
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (typeof EventSource === 'undefined') {
    currentTransport = 'polling';
    void pullSecondaryChanges(true);
    return;
  }
  if (eventSource) return;

  try {
    const rev = getStoredRevision();
    const epoch = getStoredEpoch();
    const url = resolveApiUrl(`/api/sync/stream?sinceRevision=${encodeURIComponent(String(rev))}&epoch=${encodeURIComponent(epoch)}`);
    const es = new EventSource(url);
    eventSource = es;

    es.addEventListener('connected', (e: MessageEvent) => {
      lastSseConnectedAtMs = Date.now();
      markSecondaryHealthy('sse');
      reconnectDelayMs = 2000;
      try {
        const parsed = JSON.parse(e.data);
        if (parsed?.buildId) {
          triggerVersionCheckFromSse(String(parsed.buildId));
        }
        const latestRev = Number(parsed?.latestRevision) || 0;
        const srvEpoch = String(parsed?.serverEpoch || '').trim();
        const didReset = reconcileServerEpochAndRev(srvEpoch, latestRev);
        if (didReset) return;

        if (srvEpoch) setStoredEpoch(srvEpoch);
        if (rev === 0 && latestRev > 0) {
          zeroResyncDispatchedOnce = true;
          window.dispatchEvent(new CustomEvent('blackworm_secondary_resync', { detail: { reason: 'initial_connect' } }));
          // Pull deltas immediately on initial connect
          void pullSecondaryChanges(false);
        } else if (latestRev > rev) {
          void pullSecondaryChanges(false);
        }
      } catch {}
    });

    es.addEventListener('build_update', (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data);
        if (parsed?.buildId) {
          triggerVersionCheckFromSse(String(parsed.buildId));
        }
      } catch {}
    });

    es.addEventListener('delta', (e: MessageEvent) => {
      lastSseDeltaAtMs = Date.now();
      markSecondaryHealthy('sse');
      try {
        const evt = JSON.parse(e.data) as SecondaryDeltaEvent;
        if (evt && evt.collection && evt.id) {
          dispatchDelta(evt);
        }
      } catch {}
    });

    es.onerror = () => {
      currentTransport = 'polling';
      try {
        es.close();
      } catch {}
      if (eventSource === es) {
        eventSource = null;
      }
      // Immediately run HTTP delta catchup when SSE drops
      void pullSecondaryChanges(false);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(25000, Math.round(reconnectDelayMs * 1.5));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (listenersByCollection.size > 0) {
          initSecondaryStream();
        }
      }, delay);
    };
  } catch {
    eventSource = null;
    currentTransport = 'polling';
  }
}

export function subscribeSecondaryCollection(
  colName: string,
  cb: (events: SecondaryDeltaEvent[]) => void
): () => void {
  let set = listenersByCollection.get(colName);
  if (!set) {
    set = new Set();
    listenersByCollection.set(colName, set);
  }
  set.add(cb);
  initSecondaryStream();

  return () => {
    const curSet = listenersByCollection.get(colName);
    if (!curSet) return;
    curSet.delete(cb);
    if (curSet.size === 0) {
      listenersByCollection.delete(colName);
    }
  };
}

export async function pushToSecondary(
  payload: SecondaryUpsertPayload
): Promise<{ ok: boolean; error?: string }> {
  if (typeof window === 'undefined') return { ok: false, error: 'SSR environment' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: false, error: 'Offline' };
  }
  if (isSecondaryBlocked()) {
    return { ok: false, error: 'Secondary cooldown active' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(resolveApiUrl('/api/sync/upsert'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status >= 500) markSecondaryDown(8000);
      return { ok: false, error: text || `HTTP ${res.status}` };
    }
    const json = await res.json().catch(() => ({ ok: true }));
    if (json?.serverEpoch) {
      reconcileServerEpochAndRev(String(json.serverEpoch), Number(json?.stored?.revision));
      setStoredEpoch(String(json.serverEpoch));
    }
    if (json?.stored) {
      const storedRev = Number(json.stored.revision) || 0;
      const curRev = getStoredRevision();
      // Advance cursor only when strictly contiguous so intervening deltas from other devices are never skipped
      if (storedRev > 0 && storedRev === curRev + 1) {
        setStoredRevision(storedRev);
      } else if (storedRev > curRev + 1) {
        void pullSecondaryChanges(false);
      }
      // Share immediately across same-browser tabs
      broadcastToTabs([json.stored as SecondaryDeltaEvent]);
    }
    markSecondaryHealthy(eventSource && eventSource.readyState === 1 ? 'sse' : 'polling');
    return { ok: true };
  } catch (err: any) {
    markSecondaryDown(8000);
    return { ok: false, error: err?.message || 'Network error' };
  }
}

export async function pushBatchToSecondary(
  items: SecondaryUpsertPayload[]
): Promise<{ ok: boolean; count?: number; error?: string }> {
  if (typeof window === 'undefined' || !Array.isArray(items) || items.length === 0) {
    return { ok: true, count: 0 };
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: false, error: 'Offline' };
  }

  try {
    let totalCount = 0;
    const CHUNK = 200;
    let maxServerRev = 0;
    for (let i = 0; i < items.length; i += CHUNK) {
      const slice = items.slice(i, i + CHUNK);
      const res = await fetch(resolveApiUrl('/api/sync/batch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: slice }),
      });
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const json = await res.json().catch(() => ({}));
      totalCount += Number(json?.count) || 0;
      if (json?.serverEpoch) {
        setStoredEpoch(String(json.serverEpoch));
      }
      if (json?.latestRevision) {
        maxServerRev = Math.max(maxServerRev, Number(json.latestRevision) || 0);
      }
      const nonBootstrapEvents: SecondaryDeltaEvent[] = [];
      const fallbackNow = Date.now();
      slice.forEach((it) => {
        if (!it.isBootstrap && it.collection && it.id) {
          nonBootstrapEvents.push({
            collection: it.collection,
            id: it.id,
            doc: it.doc || null,
            deleted: Boolean(it.deleted),
            updatedAtMs: Number(it.updatedAtMs) || fallbackNow,
            revision: 0,
          });
        }
      });
      if (nonBootstrapEvents.length > 0) {
        broadcastToTabs(nonBootstrapEvents);
      }
    }
    if (maxServerRev > getStoredRevision()) {
      void pullSecondaryChanges(false);
    }
    markSecondaryHealthy(eventSource && eventSource.readyState === 1 ? 'sse' : 'polling');
    return { ok: true, count: totalCount };
  } catch (err: any) {
    markSecondaryDown(8000);
    return { ok: false, error: err?.message || 'Batch sync network error' };
  }
}

export async function fetchSecondaryCollection(
  colName: string,
  options: { sinceMs?: number; limit?: number; offset?: number; includeDeleted?: boolean } = {}
): Promise<{ ok: boolean; items: any[]; archivedIds: string[]; revision: number; serverEpoch?: string }> {
  if (typeof window === 'undefined') {
    return { ok: false, items: [], archivedIds: [], revision: 0 };
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: false, items: [], archivedIds: [], revision: 0 };
  }

  try {
    const params = new URLSearchParams();
    if (options.sinceMs) params.set('since', String(options.sinceMs));
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    if (options.includeDeleted) params.set('includeDeleted', '1');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(resolveApiUrl(`/api/sync/collection/${encodeURIComponent(colName)}?${params.toString()}`), {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, items: [], archivedIds: [], revision: 0 };
    }
    const json = await res.json();
    if (json?.serverEpoch) {
      reconcileServerEpochAndRev(String(json.serverEpoch), Number(json?.revision));
      setStoredEpoch(String(json.serverEpoch));
    }
    // Never advance the global delta stream cursor from a single-collection query
    // (that would skip pending changes on all other collections).
    markSecondaryHealthy(eventSource && eventSource.readyState === 1 ? 'sse' : 'polling');
    return {
      ok: true,
      items: Array.isArray(json?.items) ? json.items : [],
      archivedIds: Array.isArray(json?.archivedIds) ? json.archivedIds : [],
      revision: Number(json?.revision) || 0,
      serverEpoch: json?.serverEpoch ? String(json.serverEpoch) : undefined,
    };
  } catch {
    return { ok: false, items: [], archivedIds: [], revision: 0 };
  }
}

export async function fetchSecondarySummary(): Promise<SecondarySummary | null> {
  if (typeof window === 'undefined') return null;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(resolveApiUrl('/api/sync/summary'), { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as SecondarySummary;
    if (json?.ok) {
      lastSummaryCache = json;
      if (json.serverEpoch) {
        reconcileServerEpochAndRev(json.serverEpoch, json.latestRevision);
      }
      markSecondaryHealthy(eventSource && eventSource.readyState === 1 ? 'sse' : 'polling');
      return json;
    }
    return null;
  } catch {
    return null;
  }
}

export async function checkSecondaryHealth(): Promise<boolean> {
  const sum = await fetchSecondarySummary();
  return Boolean(sum?.ok);
}

/**
 * Cold-server Self-Healing Hydration:
 * If the Secondary DB is missing any collection that this device already holds in LocalStorage/IndexedDB
 * (for example after container restart when Firebase credits are exhausted), automatically mirror local
 * records upward using server Last-Write-Wins timestamp safety so newer server records are never overwritten.
 */
export async function autoHydrateServerFromLocalCache(force = false): Promise<number> {
  if (typeof window === 'undefined') return 0;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0;
  if (hasHydratedServerOnce && !force) return 0;
  hasHydratedServerOnce = true;

  try {
    const summary = await fetchSecondarySummary();
    if (!summary?.ok) {
      hasHydratedServerOnce = false;
      return 0;
    }
    const serverCounts = summary.collections || {};
    const batchPayloads: SecondaryUpsertPayload[] = [];

    for (const colName of CORE_COLLECTIONS_TO_HYDRATE) {
      const serverCount = Number(serverCounts[colName]) || 0;
      let localMap: Record<string, any> | null = null;
      try {
        const raw = localStorage.getItem(`blackworm_local_${colName}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            localMap = parsed;
          }
        }
      } catch {}

      if (!localMap || Object.keys(localMap).length === 0) {
        try {
          localMap = await loadCollectionFromVault(colName);
        } catch {}
      }

      if (!localMap) continue;
      const localItems = Object.values(localMap).filter(
        (it: any) => it && it.id && !String(it.id).startsWith('temp_')
      );
      if (localItems.length === 0) continue;

      if (serverCount === 0 || force) {
        localItems.forEach((it: any) => {
          batchPayloads.push({
            collection: colName,
            id: String(it.id),
            doc: it,
            deleted: isRecordDeleted(it),
            merge: true,
            isBootstrap: true,
          });
        });
      }
    }

    if (batchPayloads.length > 0) {
      const res = await pushBatchToSecondary(batchPayloads);
      return Number(res.count) || 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Passively mirrors Firebase-hydrated docs into the Secondary Database on initial load
 * AND whenever any document's timestamp or archive state changes so edits from Firestore
 * are always propagated into SQLite + SSE.
 */
export function bootstrapCollectionToSecondary(colName: string, items: any[]): void {
  if (typeof window === 'undefined' || !Array.isArray(items) || items.length === 0) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (isSecondaryBlocked()) return;

  let sigMap = bootstrapDocSigMap.get(colName);
  if (!sigMap) {
    sigMap = new Map<string, string>();
    bootstrapDocSigMap.set(colName, sigMap);
  }

  const payloads: SecondaryUpsertPayload[] = [];
  for (const it of items) {
    if (!it || !it.id) continue;
    const id = String(it.id);
    if (id.startsWith('temp_')) continue;
    const ts = parseSyncTs(it);
    const del = isRecordDeleted(it);
    const sig = `${ts}:${del ? 1 : 0}`;
    if (sigMap.get(id) === sig) continue;
    sigMap.set(id, sig);
    payloads.push({
      collection: colName,
      id,
      doc: it,
      deleted: del,
      merge: true,
      isBootstrap: true,
    });
  }

  if (payloads.length > 0) {
    void pushBatchToSecondary(payloads);
  }
}

export async function exportAllRowsFromSecondary(sinceMs = 0): Promise<{
  ok: boolean;
  rows: Array<{ collection: string; id: string; doc: Record<string, any>; updatedAtMs: number; deleted: boolean }>;
}> {
  try {
    const res = await fetch(resolveApiUrl(`/api/sync/export-all?sinceMs=${Math.max(0, Number(sinceMs) || 0)}`));
    if (!res.ok) return { ok: false, rows: [] };
    const json = await res.json();
    return { ok: Boolean(json?.ok), rows: Array.isArray(json?.rows) ? json.rows : [] };
  } catch {
    return { ok: false, rows: [] };
  }
}

export function forceResetSecondaryCursor(): void {
  setStoredRevision(0, true);
  zeroResyncDispatchedOnce = false;
  hasHydratedServerOnce = false;
}
