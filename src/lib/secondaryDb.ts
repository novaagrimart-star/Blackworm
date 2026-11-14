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

const REV_STORAGE_KEY = 'blackworm_secondary_rev';
const listenersByCollection = new Map<string, Set<(events: SecondaryDeltaEvent[]) => void>>();
const bootstrappedCollections = new Set<string>();
const lastBootstrapCount = new Map<string, number>();

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 2000;
let secondaryDownUntil = 0;

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

function setStoredRevision(rev: number) {
  try {
    if (typeof window === 'undefined' || !Number.isFinite(rev) || rev <= 0) return;
    const cur = getStoredRevision();
    if (rev > cur) {
      localStorage.setItem(REV_STORAGE_KEY, String(rev));
    }
  } catch {}
}

export function isSecondaryBlocked(): boolean {
  if (secondaryDownUntil <= 0) return false;
  if (Date.now() >= secondaryDownUntil) {
    secondaryDownUntil = 0;
    return false;
  }
  return true;
}

function markSecondaryDown(ms = 15000) {
  secondaryDownUntil = Date.now() + ms;
}

function markSecondaryHealthy() {
  secondaryDownUntil = 0;
}

function dispatchDelta(evt: SecondaryDeltaEvent) {
  if (evt.revision) {
    setStoredRevision(evt.revision);
  }
  const set = listenersByCollection.get(evt.collection);
  if (set && set.size > 0) {
    set.forEach((cb) => {
      try {
        cb([evt]);
      } catch (e) {
        console.warn('Secondary subscriber callback notice:', e);
      }
    });
  }
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blackworm_secondary_delta', { detail: evt }));
    }
  } catch {}
}

export function initSecondaryStream(): void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (eventSource) return;

  try {
    const rev = getStoredRevision();
    const url = `/api/sync/stream?sinceRevision=${encodeURIComponent(String(rev))}`;
    const es = new EventSource(url);
    eventSource = es;

    es.addEventListener('connected', (e: MessageEvent) => {
      markSecondaryHealthy();
      reconnectDelayMs = 2000;
      try {
        const parsed = JSON.parse(e.data);
        if (parsed?.latestRevision && rev === 0) {
          setStoredRevision(Number(parsed.latestRevision) || 0);
        }
      } catch {}
    });

    es.addEventListener('delta', (e: MessageEvent) => {
      markSecondaryHealthy();
      try {
        const evt = JSON.parse(e.data) as SecondaryDeltaEvent;
        if (evt && evt.collection && evt.id) {
          dispatchDelta(evt);
        }
      } catch {}
    });

    es.onerror = () => {
      try {
        es.close();
      } catch {}
      if (eventSource === es) {
        eventSource = null;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(30000, reconnectDelayMs * 1.5);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (listenersByCollection.size > 0) {
          initSecondaryStream();
        }
      }, delay);
    };
  } catch {
    eventSource = null;
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
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('/api/sync/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status >= 500) markSecondaryDown(15000);
      return { ok: false, error: text || `HTTP ${res.status}` };
    }
    const json = await res.json().catch(() => ({ ok: true }));
    if (json?.stored?.revision) {
      setStoredRevision(Number(json.stored.revision));
    }
    markSecondaryHealthy();
    return { ok: true };
  } catch (err: any) {
    markSecondaryDown(10000);
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
      if (json?.latestRevision) {
        setStoredRevision(Number(json.latestRevision));
      }
    }
    markSecondaryHealthy();
    return { ok: true, count: totalCount };
  } catch (err: any) {
    markSecondaryDown(10000);
    return { ok: false, error: err?.message || 'Batch sync network error' };
  }
}

export async function fetchSecondaryCollection(
  colName: string,
  options: { sinceMs?: number; limit?: number; offset?: number; includeDeleted?: boolean } = {}
): Promise<{ ok: boolean; items: any[]; archivedIds: string[]; revision: number }> {
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
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`/api/sync/collection/${encodeURIComponent(colName)}?${params.toString()}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, items: [], archivedIds: [], revision: 0 };
    }
    const json = await res.json();
    if (json?.revision) {
      setStoredRevision(Number(json.revision));
    }
    markSecondaryHealthy();
    return {
      ok: true,
      items: Array.isArray(json?.items) ? json.items : [],
      archivedIds: Array.isArray(json?.archivedIds) ? json.archivedIds : [],
      revision: Number(json?.revision) || 0,
    };
  } catch {
    return { ok: false, items: [], archivedIds: [], revision: 0 };
  }
}

export async function checkSecondaryHealth(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('/api/sync/health', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const json = await res.json().catch(() => ({ ok: false }));
    if (json?.ok) {
      markSecondaryHealthy();
      return true;
    }
    return false;
  } catch {
    return false;
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
