import { LGD_DISTRICTS, LGD_STATES, LGD_TALUKAS } from './lgdHierarchyIndex';
import { normalizeLocationKey } from './maharashtraLocations';

export interface OfficialLgdVillage {
  villageCode: string;
  villageName: string;
  talukaCode: string;
  talukaName: string;
  districtCode: string;
  districtName: string;
  stateCode: string;
  stateName: string;
  pinCode: string;
}

interface StateJsonPayload {
  version: string;
  stateCode: string;
  stateName: string;
  districtCount: number;
  talukaCount: number;
  villageCount: number;
  // Tuple: [villageCode, villageName, talukaCode, pinCode]
  villages: Array<[string, string, string, string]>;
}

interface IndexedLgdState {
  version: string;
  stateCode: string;
  stateName: string;
  villageCount: number;
  all: OfficialLgdVillage[];
  byTalukaCode: Map<string, OfficialLgdVillage[]>;
  byDistrictCode: Map<string, OfficialLgdVillage[]>;
  byVillageCode: Map<string, OfficialLgdVillage>;
  byNameKey: Map<string, OfficialLgdVillage>; // `${talukaCode}|${normVillageName}`
}

const EXPECTED_VERSION = '2026-11-15';
const IDB_NAME = 'blackworm_lgd_master_v2';
const IDB_STORE = 'lgd_states';

const talukaLookupByCode = new Map(LGD_TALUKAS.map((t) => [t.code, t]));
const districtLookupByCode = new Map(LGD_DISTRICTS.map((d) => [d.code, d]));
const stateLookupByCode = new Map(LGD_STATES.map((s) => [s.code, s]));

const memoryCache = new Map<string, IndexedLgdState>();
const inflightLoads = new Map<string, Promise<IndexedLgdState | null>>();

let idbPromise: Promise<IDBDatabase | null> | null = null;

function openLgdIdb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'stateCode' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return idbPromise;
}

async function readStateFromIdb(stateCode: string): Promise<StateJsonPayload | null> {
  try {
    const db = await openLgdIdb();
    if (!db) return null;
    return await new Promise<StateJsonPayload | null>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(stateCode);
      req.onsuccess = () => {
        const row = req.result as StateJsonPayload | undefined;
        if (row && row.version === EXPECTED_VERSION && Array.isArray(row.villages) && row.villages.length > 0) {
          resolve(row);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeStateToIdb(payload: StateJsonPayload): Promise<void> {
  try {
    const db = await openLgdIdb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.put(payload);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {}
}

function buildIndexedState(payload: StateJsonPayload): IndexedLgdState {
  const all: OfficialLgdVillage[] = [];
  const byTalukaCode = new Map<string, OfficialLgdVillage[]>();
  const byDistrictCode = new Map<string, OfficialLgdVillage[]>();
  const byVillageCode = new Map<string, OfficialLgdVillage>();
  const byNameKey = new Map<string, OfficialLgdVillage>();

  const stateMeta = stateLookupByCode.get(payload.stateCode);
  const stateName = stateMeta?.name || payload.stateName;

  for (const tuple of payload.villages) {
    if (!Array.isArray(tuple) || tuple.length < 3) continue;
    const villageCode = String(tuple[0] || '').trim();
    const villageName = String(tuple[1] || '').trim();
    const talukaCode = String(tuple[2] || '').trim();
    const pinCode = String(tuple[3] || '').trim();
    if (!villageCode || !villageName || !talukaCode) continue;
    if (byVillageCode.has(villageCode)) continue;

    const tMeta = talukaLookupByCode.get(talukaCode);
    const dMeta = tMeta ? districtLookupByCode.get(tMeta.districtCode) : undefined;
    if (!tMeta || !dMeta) continue;

    const rec: OfficialLgdVillage = {
      villageCode,
      villageName,
      talukaCode,
      talukaName: tMeta.name,
      districtCode: dMeta.code,
      districtName: dMeta.name,
      stateCode: payload.stateCode,
      stateName,
      pinCode,
    };

    all.push(rec);
    byVillageCode.set(villageCode, rec);
    byNameKey.set(`${talukaCode}|${normalizeLocationKey(villageName)}`, rec);

    let tArr = byTalukaCode.get(talukaCode);
    if (!tArr) {
      tArr = [];
      byTalukaCode.set(talukaCode, tArr);
    }
    tArr.push(rec);

    let dArr = byDistrictCode.get(dMeta.code);
    if (!dArr) {
      dArr = [];
      byDistrictCode.set(dMeta.code, dArr);
    }
    dArr.push(rec);
  }

  return {
    version: payload.version,
    stateCode: payload.stateCode,
    stateName,
    villageCount: all.length,
    all,
    byTalukaCode,
    byDistrictCode,
    byVillageCode,
    byNameKey,
  };
}

/**
 * Loads official LGD village master for a state ('27' Maharashtra, '29' Karnataka)
 * using 1) Memory Cache -> 2) IndexedDB Cache -> 3) One-time static JSON fetch.
 */
export async function loadLgdStateVillages(stateCode: string): Promise<IndexedLgdState | null> {
  if (stateCode !== '27' && stateCode !== '29') return null;

  const existingMem = memoryCache.get(stateCode);
  if (existingMem) return existingMem;

  const inflight = inflightLoads.get(stateCode);
  if (inflight) return inflight;

  const task = (async (): Promise<IndexedLgdState | null> => {
    try {
      const fromIdb = await readStateFromIdb(stateCode);
      if (fromIdb) {
        const indexed = buildIndexedState(fromIdb);
        memoryCache.set(stateCode, indexed);
        return indexed;
      }

      if (typeof fetch === 'undefined') return null;
      const resp = await fetch(`/data/lgd_${stateCode}_villages.json`, { cache: 'force-cache' });
      if (!resp.ok) return null;
      const payload = (await resp.json()) as StateJsonPayload;
      if (!payload || !Array.isArray(payload.villages)) return null;

      void writeStateToIdb(payload);
      const indexed = buildIndexedState(payload);
      memoryCache.set(stateCode, indexed);
      return indexed;
    } catch (err) {
      console.warn(`Failed loading LGD cache for state ${stateCode}:`, err);
      return null;
    } finally {
      inflightLoads.delete(stateCode);
    }
  })();

  inflightLoads.set(stateCode, task);
  return task;
}

export function isLgdStateCachedInMemory(stateCode: string): boolean {
  return memoryCache.has(stateCode);
}

export function getCachedLgdCounts(): { mh: number; ka: number } {
  return {
    mh: memoryCache.get('27')?.villageCount || 0,
    ka: memoryCache.get('29')?.villageCount || 0,
  };
}

export function getOfficialVillagesByTalukaSync(
  stateCode: string,
  talukaCode: string
): OfficialLgdVillage[] {
  const idx = memoryCache.get(stateCode);
  if (!idx || !talukaCode) return [];
  return idx.byTalukaCode.get(talukaCode) || [];
}

export function getOfficialDistrictVillageCountSync(
  stateCode: string,
  districtCode: string
): number {
  const idx = memoryCache.get(stateCode);
  if (!idx || !districtCode) return 0;
  return idx.byDistrictCode.get(districtCode)?.length || 0;
}

export function getOfficialTalukaVillageCountSync(
  stateCode: string,
  talukaCode: string
): number {
  const idx = memoryCache.get(stateCode);
  if (!idx || !talukaCode) return 0;
  return idx.byTalukaCode.get(talukaCode)?.length || 0;
}

export function findOfficialLgdVillageSync(params: {
  stateCode?: string;
  talukaCode?: string;
  villageCode?: string;
  villageName?: string;
}): OfficialLgdVillage | undefined {
  const statesToCheck =
    params.stateCode && memoryCache.has(params.stateCode)
      ? [memoryCache.get(params.stateCode)!]
      : Array.from(memoryCache.values());

  if (params.villageCode) {
    const vc = String(params.villageCode).trim();
    for (const st of statesToCheck) {
      const hit = st.byVillageCode.get(vc);
      if (hit) return hit;
    }
  }

  if (params.talukaCode && params.villageName) {
    const key = `${params.talukaCode}|${normalizeLocationKey(params.villageName)}`;
    for (const st of statesToCheck) {
      const hit = st.byNameKey.get(key);
      if (hit) return hit;
    }
  }

  return undefined;
}

export function getOfficialVillagesFilteredSync(options: {
  stateCode?: string; // '27' | '29' | 'all'
  districtCode?: string;
  talukaCode?: string;
  query?: string;
  limit?: number;
}): { items: OfficialLgdVillage[]; totalMatched: number } {
  const stateCodes =
    options.stateCode && options.stateCode !== 'all'
      ? [options.stateCode]
      : ['27', '29'];

  let pool: OfficialLgdVillage[] = [];

  for (const sc of stateCodes) {
    const st = memoryCache.get(sc);
    if (!st) continue;
    if (options.talukaCode && options.talukaCode !== 'all') {
      const tList = st.byTalukaCode.get(options.talukaCode);
      if (tList) pool = pool.concat(tList);
    } else if (options.districtCode && options.districtCode !== 'all') {
      const dList = st.byDistrictCode.get(options.districtCode);
      if (dList) pool = pool.concat(dList);
    } else {
      pool = pool.concat(st.all);
    }
  }

  const q = String(options.query || '').trim().toLowerCase();
  const limit = options.limit ?? 200;

  if (!q) {
    return {
      items: pool.slice(0, limit),
      totalMatched: pool.length,
    };
  }

  const matched: OfficialLgdVillage[] = [];
  for (let i = 0; i < pool.length; i++) {
    const v = pool[i];
    if (
      v.villageName.toLowerCase().includes(q) ||
      v.villageCode.includes(q) ||
      (v.pinCode && v.pinCode.includes(q)) ||
      v.talukaName.toLowerCase().includes(q) ||
      v.districtName.toLowerCase().includes(q)
    ) {
      matched.push(v);
    }
  }

  return {
    items: matched.slice(0, limit),
    totalMatched: matched.length,
  };
}
