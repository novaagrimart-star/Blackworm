import { loadCollectionFromVault, saveCollectionToVault } from './localVault';

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
}

export type CloudMirrorType = 'none' | 'supabase' | 'relay' | 'peer';

export interface CloudMirrorPublicConfig {
  configured: boolean;
  type: CloudMirrorType;
  url: string;
  hasKey: boolean;
  lastCloudSyncAtMs?: number;
  lastCloudError?: string;
  cloudMirroredCount?: number;
}

export interface SecondarySyncStatus {
  healthy: boolean;
  transport: 'sse' | 'polling' | 'offline';
  latestRevision: number;
  serverEpoch?: string;
  lastSyncAtMs: number;
  cloudMirrorConfigured?: boolean;
  cloudMirrorType?: CloudMirrorType;
  lastCloudSyncAtMs?: number;
  lastCloudError?: string;
  totalRecords?: number;
}

export interface SecondarySummary {
  ok: boolean;
  engine?: string;
  serverEpoch?: string;
  supabaseMirror?: boolean;
  cloudMirrorConfigured?: boolean;
  cloudMirrorType?: CloudMirrorType;
  lastCloudSyncAtMs?: number;
  lastCloudError?: string;
  cloudMirroredCount?: number;
  totalRecords?: number;
  latestRevision?: number;
  connectedClients?: number;
  collections?: Record<string, number>;
}

const REV_STORAGE_KEY = 'blackworm_secondary_rev';
const EPOCH_STORAGE_KEY = 'blackworm_secondary_epoch';
const BC_CHANNEL_NAME = 'blackworm_sync_bc_v1';

const listenersByCollection = new Map<string, Set<(events: SecondaryDeltaEvent[]) => void>>();
const bootstrappedCollections = new Set<string>();
const lastBootstrapCount = new Map<string, number>();

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
    cloudMirrorConfigured: lastSummaryCache?.cloudMirrorConfigured,
    cloudMirrorType: lastSummaryCache?.cloudMirrorType || 'none',
    lastCloudSyncAtMs: lastSummaryCache?.lastCloudSyncAtMs,
    lastCloudError: lastSummaryCache?.lastCloudError,
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

    for (const evt of events) {
      if (!evt?.id) continue;
      if (evt.deleted || evt.doc?.isArchived) {
        if (evt.id in map) {
          delete map[evt.id];
          mutated = true;
        }
        continue;
      }
      if (evt.doc && typeof evt.doc === 'object') {
        const incoming = {
          ...evt.doc,
          id: evt.id,
          ...(evt.updatedAtMs ? { _syncUpdatedAtMs: evt.updatedAtMs } : {}),
        };
        const prev = map[evt.id];
        const prevTs = parseSyncTs(prev);
        const nextTs = Math.max(Number(evt.updatedAtMs) || 0, parseSyncTs(incoming));
        if (!prev || nextTs >= prevTs) {
          const merged = prev ? { ...prev, ...incoming } : incoming;
          delete merged._localSavedAt;
          map[evt.id] = merged;
          mutated = true;
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
      }
    };
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
  try {
    let rev = getStoredRevision();
    const epoch = getStoredEpoch();

    if (rev === 0) {
      if (forceFullResyncIfZero || !zeroResyncDispatchedOnce) {
        zeroResyncDispatchedOnce = true;
        window.dispatchEvent(new CustomEvent('blackworm_secondary_resync', { detail: { reason: 'rev_zero' } }));
      }
      // Also pull changes since 0 cleanly so collections/configs get updated without waiting
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(`/api/sync/changes?since=0&epoch=${encodeURIComponent(epoch)}&limit=1000`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return 0;
      const json = await res.json();
      if (json?.serverEpoch) setStoredEpoch(String(json.serverEpoch));
      const events: SecondaryDeltaEvent[] = Array.isArray(json?.events) ? json.events : [];
      dispatchDeltaBatch(events);
      // Advance revision cursor only up to the last event returned (so if >1000 exist, next poll picks up the rest!)
      if (events.length > 0) {
        const lastEvtRev = Number(events[events.length - 1].revision) || 0;
        if (lastEvtRev > 0) setStoredRevision(lastEvtRev);
      } else if (json?.latestRevision) {
        setStoredRevision(Number(json.latestRevision));
      }
      markSecondaryHealthy(eventSource && eventSource.readyState === 1 ? 'sse' : 'polling');
      return events.length;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(
      `/api/sync/changes?since=${encodeURIComponent(String(rev))}&epoch=${encodeURIComponent(epoch)}&limit=1000`,
      { signal: controller.signal }
    );
    clearTimeout(timer);

    if (!res.ok) return 0;
    const json = await res.json();

    const wasReset =
      Boolean(json?.resetRequired) ||
      reconcileServerEpochAndRev(json?.serverEpoch, json?.latestRevision);

    if (json?.serverEpoch) {
      setStoredEpoch(String(json.serverEpoch));
    }

    const events: SecondaryDeltaEvent[] = Array.isArray(json?.events) ? json.events : [];
    if (events.length > 0) {
      dispatchDeltaBatch(events);
      // If SSE was supposedly OPEN yet missed events for >8s since connect/last delta, recycle stale SSE connection
      if (!wasReset && eventSource && Date.now() - Math.max(lastSseDeltaAtMs, lastSseConnectedAtMs) > 8000) {
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
    return events.length;
  } catch {
    return 0;
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

  // Reliable 6s active-tab HTTP delta heartbeat (works even when mobile carrier/proxy silently drops SSE)
  deltaPollTimer = setInterval(() => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void pullSecondaryChanges(false);
  }, 6000);
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
    const url = `/api/sync/stream?sinceRevision=${encodeURIComponent(String(rev))}&epoch=${encodeURIComponent(epoch)}`;
    const es = new EventSource(url);
    eventSource = es;

    es.addEventListener('connected', (e: MessageEvent) => {
      lastSseConnectedAtMs = Date.now();
      markSecondaryHealthy('sse');
      reconnectDelayMs = 2000;
      try {
        const parsed = JSON.parse(e.data);
        const latestRev = Number(parsed?.latestRevision) || 0;
        const srvEpoch = String(parsed?.serverEpoch || '').trim();
        const didReset = reconcileServerEpochAndRev(srvEpoch, latestRev);
        if (didReset) return;

        if (srvEpoch) setStoredEpoch(srvEpoch);
        if (rev === 0 && latestRev > 0) {
          zeroResyncDispatchedOnce = true;
          window.dispatchEvent(new CustomEvent('blackworm_secondary_resync', { detail: { reason: 'initial_connect' } }));
          // Pull deltas cleanly via HTTP after initial resync trigger
          setTimeout(() => {
            void pullSecondaryChanges(false);
          }, 1500);
        } else if (latestRev > rev) {
          void pullSecondaryChanges(false);
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
    const res = await fetch('/api/sync/upsert', {
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
      if (json.stored.revision) {
        setStoredRevision(Number(json.stored.revision));
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
    for (let i = 0; i < items.length; i += CHUNK) {
      const slice = items.slice(i, i + CHUNK);
      const res = await fetch('/api/sync/batch', {
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
        setStoredRevision(Number(json.latestRevision));
      }
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
    const res = await fetch(`/api/sync/collection/${encodeURIComponent(colName)}?${params.toString()}`, {
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
    // Only advance stored revision if we already pulled past 0 or after full resync
    if (json?.revision && getStoredRevision() > 0) {
      setStoredRevision(Number(json.revision));
    }
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
    const res = await fetch('/api/sync/summary', { signal: controller.signal });
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

      if (serverCount === 0 || (force && localItems.length > serverCount)) {
        localItems.forEach((it: any) => {
          batchPayloads.push({
            collection: colName,
            id: String(it.id),
            doc: it,
            deleted: Boolean(it.isArchived),
            merge: true,
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
 * Passively mirrors Firebase-hydrated docs into the Secondary Database once per session
 * (or when item count increases) so the Secondary DB stays warm and complete for failover.
 */
export function bootstrapCollectionToSecondary(colName: string, items: any[]): void {
  if (typeof window === 'undefined' || !Array.isArray(items) || items.length === 0) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (isSecondaryBlocked()) return;

  const prevCount = lastBootstrapCount.get(colName) || 0;
  if (bootstrappedCollections.has(colName) && items.length <= prevCount) {
    return;
  }
  bootstrappedCollections.add(colName);
  lastBootstrapCount.set(colName, items.length);

  const payloads: SecondaryUpsertPayload[] = items
    .filter((it) => it && it.id && !String(it.id).startsWith('temp_'))
    .map((it) => ({
      collection: colName,
      id: String(it.id),
      doc: it,
      deleted: Boolean(it.isArchived),
      merge: true,
    }));

  if (payloads.length > 0) {
    void pushBatchToSecondary(payloads);
  }
}

// ---------------------------------------------------------------------------
// PATH 3 HELPERS: Cloud Mirror Config (Supabase / Apps Script Relay / Peer)
// ---------------------------------------------------------------------------
export async function getCloudMirrorConfig(): Promise<CloudMirrorPublicConfig | null> {
  if (typeof window === 'undefined') return null;
  try {
    const res = await fetch('/api/sync/cloud-config');
    if (!res.ok) return null;
    return (await res.json()) as CloudMirrorPublicConfig;
  } catch {
    return null;
  }
}

export async function saveCloudMirrorConfig(cfg: {
  type: CloudMirrorType;
  url: string;
  apiKey?: string;
}): Promise<{ ok: boolean; restored?: number; pushed?: number; error?: string; config?: CloudMirrorPublicConfig }> {
  try {
    const res = await fetch('/api/sync/cloud-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const json = await res.json();
    if (json?.ok) {
      window.dispatchEvent(new CustomEvent('blackworm_secondary_resync', { detail: { reason: 'cloud_config' } }));
    }
    return json;
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to save cloud mirror config' };
  }
}

export async function triggerCloudMirrorSync(): Promise<{
  ok: boolean;
  pushed?: number;
  restored?: number;
  error?: string;
}> {
  try {
    const res = await fetch('/api/sync/force-cloud-sync', { method: 'POST' });
    const json = await res.json();
    if (json?.ok) {
      window.dispatchEvent(new CustomEvent('blackworm_secondary_resync', { detail: { reason: 'cloud_sync' } }));
    }
    return json;
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Cloud sync failed' };
  }
}

export async function exportAllRowsFromSecondary(sinceMs = 0): Promise<{
  ok: boolean;
  rows: Array<{ collection: string; id: string; doc: Record<string, any>; updatedAtMs: number; deleted: boolean }>;
}> {
  try {
    const res = await fetch(`/api/sync/export-all?sinceMs=${Math.max(0, Number(sinceMs) || 0)}`);
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
