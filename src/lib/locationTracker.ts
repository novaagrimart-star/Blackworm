import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile } from './auth';
import {
  isQuotaBlocked,
  safeFirestoreSet,
  safeLocalStorageSet,
  setQuotaBlocked,
  trackFirestoreUsage,
} from './dataService';
import { isQuotaExceededError } from '../firebase';
import { fetchSecondaryCollection, pushToSecondary } from './secondaryDb';

export interface UserLocationRecord {
  id: string;
  uid: string;
  userCode?: string;
  fullName?: string;
  designation?: string;
  center?: string;
  mobileNumber?: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  city?: string;
  region?: string;
  country?: string;
  addressLabel?: string;
  source: 'gps' | 'network' | 'profile';
  updatedAt: string;
  updatedAtMs: number;
}

const CHECKIN_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes silent background cooldown
const FIRESTORE_WRITE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes Firestore write throttle
const FETCH_CACHE_TTL_MS = 60 * 1000; // 60 seconds on-demand fetch cache

const CHECKIN_TS_PREFIX = 'blackworm_silent_loc_ts_';
const LAST_SOURCE_PREFIX = 'blackworm_silent_loc_src_';
const FIRESTORE_TS_PREFIX = 'blackworm_silent_loc_fs_';
const LOCATIONS_CACHE_KEY = 'blackworm_cached_user_locations_v1';

let memoryLocationsCache: UserLocationRecord[] | null = null;
let memoryLocationsFetchedAt = 0;
let inflightLocationsFetch: Promise<UserLocationRecord[]> | null = null;
let lastPingSentAt = 0;

/**
 * Excluded accounts/names that must NEVER appear in Location Tracking or Location Viewer:
 * 1. Blackworm Agritech (company/admin account)
 * 2. Pravin Waghmare
 * 3. Shridhar / Shidhar Shinde
 */
export function isExcludedFromLocationTracking(
  person?: Partial<UserProfile & UserLocationRecord> | Record<string, any> | null
): boolean {
  if (!person) return false;
  const norm = (val: any) =>
    String(val || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const fullName = norm(person.fullName);
  const loginId = norm((person as any).loginId);
  const userCode = norm(person.userCode);
  const emailId = norm((person as any).emailId);
  const combined = `${fullName} ${loginId} ${userCode} ${emailId}`;

  // 1. Blackworm Agritech / Admin company account
  if (
    combined.includes('blackworm') ||
    combined.includes('black worm') ||
    combined.includes('agritech') ||
    loginId === 'admin'
  ) {
    return true;
  }

  // 2. Pravin Waghmare (supports Pravin / Praveen)
  if (
    (fullName.includes('pravin') || fullName.includes('praveen')) &&
    fullName.includes('waghmare')
  ) {
    return true;
  }
  if (
    (loginId.includes('pravin') || loginId.includes('praveen')) &&
    loginId.includes('waghmare')
  ) {
    return true;
  }

  // 3. Shridhar / Shidhar Shinde
  if (
    (fullName.includes('shridhar') ||
      fullName.includes('shidhar') ||
      fullName.includes('sridhar')) &&
    fullName.includes('shinde')
  ) {
    return true;
  }
  if (
    (loginId.includes('shridhar') ||
      loginId.includes('shidhar') ||
      loginId.includes('sridhar')) &&
    loginId.includes('shinde')
  ) {
    return true;
  }

  return false;
}

/**
 * Checks browser geolocation permission WITHOUT ever triggering a permission prompt/notification.
 * Returns coordinates only if permission was already granted by the browser/device.
 */
async function readPreGrantedGpsSilently(): Promise<{
  latitude: number;
  longitude: number;
  accuracy: number;
} | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;

  // CRITICAL: Never call getCurrentPosition unless permission state is ALREADY 'granted'.
  // This guarantees zero browser location prompts or notifications to any user.
  let isAlreadyGranted = false;
  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
      isAlreadyGranted = status?.state === 'granted';
    }
  } catch {
    isAlreadyGranted = false;
  }

  if (!isAlreadyGranted) {
    return null;
  }

  return new Promise((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            latitude: Number(pos.coords.latitude.toFixed(6)),
            longitude: Number(pos.coords.longitude.toFixed(6)),
            accuracy: Math.round(pos.coords.accuracy || 0),
          });
        },
        () => resolve(null),
        {
          enableHighAccuracy: true,
          timeout: 6000,
          maximumAge: 5 * 60 * 1000,
        }
      );
    } catch {
      resolve(null);
    }
  });
}

function upsertIntoLocalLocationCache(record: UserLocationRecord): void {
  if (isExcludedFromLocationTracking(record)) return;
  try {
    const existing = getCachedUserLocations().filter(
      (r) => r && r.uid !== record.uid && !isExcludedFromLocationTracking(r)
    );
    const next = [record, ...existing];
    memoryLocationsCache = next;
    safeLocalStorageSet(LOCATIONS_CACHE_KEY, JSON.stringify(next));
  } catch {}
}

/**
 * Silently records user's session location in the background without any UI alert, toast, or permission prompt.
 * Throttled by 15-minute cooldown to avoid unnecessary network/API calls.
 */
export async function recordSilentUserLocation(
  profile: UserProfile | null | undefined,
  options?: { force?: boolean; minIntervalMs?: number }
): Promise<void> {
  if (!profile?.uid) return;
  if (isExcludedFromLocationTracking(profile)) return;

  const uid = profile.uid;
  const minInterval = options?.minIntervalMs ?? (options?.force ? 60 * 1000 : CHECKIN_COOLDOWN_MS);

  try {
    const lastTs = Number(localStorage.getItem(`${CHECKIN_TS_PREFIX}${uid}`) || '0');
    if (Date.now() - lastTs < minInterval) {
      return;
    }
    safeLocalStorageSet(`${CHECKIN_TS_PREFIX}${uid}`, String(Date.now()));
  } catch {}

  try {
    const gps = await readPreGrantedGpsSilently();

    let serverStored: UserLocationRecord | null = null;
    try {
      const resp = await fetch('/api/location/silent-checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid,
          loginId: profile.loginId || '',
          userCode: profile.userCode || '',
          fullName: profile.fullName || '',
          designation: profile.designation || '',
          center: profile.center || '',
          mobileNumber: profile.mobileNumber || '',
          village: (profile as any).village || '',
          taluka: (profile as any).taluka || '',
          district: (profile as any).district || '',
          state: (profile as any).state || '',
          latitude: gps?.latitude ?? null,
          longitude: gps?.longitude ?? null,
          accuracy: gps?.accuracy ?? null,
        }),
      });
      if (resp.ok) {
        const json = await resp.json();
        if (json?.record && !json?.excluded) {
          serverStored = json.record as UserLocationRecord;
        }
      }
    } catch {
      // Silent failure: never disturb user
    }

    const fallbackRecord: UserLocationRecord = serverStored || {
      id: `loc_${uid}`,
      uid,
      userCode: profile.userCode || '',
      fullName: profile.fullName || '',
      designation: profile.designation || '',
      center: profile.center || '',
      mobileNumber: profile.mobileNumber || '',
      latitude: gps?.latitude ?? null,
      longitude: gps?.longitude ?? null,
      accuracy: gps?.accuracy ?? null,
      city: (profile as any).village || profile.center || '',
      region: (profile as any).district || (profile as any).state || '',
      addressLabel: gps
        ? `GPS (${gps.latitude}, ${gps.longitude})`
        : [(profile as any).village, profile.center, (profile as any).district, (profile as any).state]
            .filter(Boolean)
            .join(', ') || 'Registered Center',
      source: gps ? 'gps' : 'profile',
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now(),
    };

    upsertIntoLocalLocationCache(fallbackRecord);

    // Sync to Firestore strictly throttled to protect free credits
    try {
      const lastFsTs = Number(localStorage.getItem(`${FIRESTORE_TS_PREFIX}${uid}`) || '0');
      const lastSrc = localStorage.getItem(`${LAST_SOURCE_PREFIX}${uid}`) || '';
      const upgradedFromProfile =
        lastSrc === 'profile' && (fallbackRecord.source === 'gps' || fallbackRecord.source === 'network');

      if (
        !isQuotaBlocked() &&
        (upgradedFromProfile || Date.now() - lastFsTs >= FIRESTORE_WRITE_COOLDOWN_MS)
      ) {
        safeLocalStorageSet(`${FIRESTORE_TS_PREFIX}${uid}`, String(Date.now()));
        safeLocalStorageSet(`${LAST_SOURCE_PREFIX}${uid}`, fallbackRecord.source);
        void safeFirestoreSet('user_locations', `loc_${uid}`, fallbackRecord, { merge: true }).catch(() => {});
      }
    } catch {}
  } catch {
    // Completely silent by requirement
  }
}

/**
 * Triggers a throttled silent sync ping so active online sessions refresh their cached locations.
 * Never displays any prompt or alert to any user.
 */
export async function requestSilentLocationRefreshPing(requester: UserProfile): Promise<void> {
  if (Date.now() - lastPingSentAt < 60 * 1000) return;
  lastPingSentAt = Date.now();
  try {
    const pingDoc = {
      id: 'latest_sync_ping',
      requestedByUid: requester.uid,
      requestedByCode: requester.userCode || requester.loginId || 'EMP-002',
      requestedAt: new Date().toISOString(),
      requestedAtMs: Date.now(),
    };
    await pushToSecondary({
      collection: 'location_requests',
      id: 'latest_sync_ping',
      doc: pingDoc,
      merge: true,
    });
  } catch {
    // Silent fallback
  }
}

export function getCachedUserLocations(): UserLocationRecord[] {
  if (memoryLocationsCache && memoryLocationsCache.length > 0) {
    return memoryLocationsCache.filter((r) => r && !isExcludedFromLocationTracking(r));
  }
  try {
    const raw = localStorage.getItem(LOCATIONS_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const clean = parsed.filter((r) => r && !isExcludedFromLocationTracking(r));
        memoryLocationsCache = clean;
        return clean;
      }
    }
  } catch {}
  return [];
}

/**
 * On-demand fetch of all employee/user locations with deduplication and caching
 * so free API/DB credits are conserved and duplicate requests are eliminated.
 */
export async function fetchAllUserLocationsOnDemand(
  users: UserProfile[],
  forceRefresh = false
): Promise<UserLocationRecord[]> {
  const now = Date.now();
  if (!forceRefresh && memoryLocationsCache && now - memoryLocationsFetchedAt < FETCH_CACHE_TTL_MS) {
    return mergeUsersWithLocationDocs(users, memoryLocationsCache);
  }

  if (inflightLocationsFetch) {
    const docs = await inflightLocationsFetch;
    return mergeUsersWithLocationDocs(users, docs);
  }

  inflightLocationsFetch = (async () => {
    const map = new Map<string, UserLocationRecord>();

    // Seed from local cache first for 0ms resilience
    getCachedUserLocations().forEach((rec) => {
      if (rec?.uid && !isExcludedFromLocationTracking(rec)) {
        map.set(rec.uid, rec);
      }
    });

    // 1. Fetch from fast Secondary DB (SQLite WAL — zero Firebase read credits)
    try {
      const sec = await fetchSecondaryCollection('user_locations', { limit: 1000 });
      if (sec.ok && Array.isArray(sec.items)) {
        sec.items.forEach((raw: any) => {
          const uid = String(raw?.uid || String(raw?.id || '').replace(/^loc_/, '')).trim();
          if (!uid || isExcludedFromLocationTracking(raw)) return;
          const rec: UserLocationRecord = {
            ...raw,
            id: raw.id || `loc_${uid}`,
            uid,
            source: raw.source || (raw.latitude && raw.longitude ? 'gps' : 'profile'),
            updatedAt: raw.updatedAt || new Date().toISOString(),
            updatedAtMs: Number(raw.updatedAtMs) || Date.parse(raw.updatedAt || '') || 0,
          };
          const prev = map.get(uid);
          if (!prev || rec.updatedAtMs >= prev.updatedAtMs) {
            map.set(uid, rec);
          }
        });
      }
    } catch {}

    // 2. Fetch from Firestore ONLY on-demand when forced or cache expired & not quota-blocked
    if (!isQuotaBlocked() && (forceRefresh || now - memoryLocationsFetchedAt >= FETCH_CACHE_TTL_MS)) {
      try {
        const snap = await getDocs(collection(db, 'user_locations'));
        trackFirestoreUsage('read', Math.max(1, snap.docs.length));
        snap.docs.forEach((d) => {
          const raw = d.data() as any;
          const uid = String(raw?.uid || d.id.replace(/^loc_/, '')).trim();
          if (!uid || isExcludedFromLocationTracking(raw)) return;
          const rec: UserLocationRecord = {
            ...raw,
            id: d.id,
            uid,
            source: raw.source || (raw.latitude && raw.longitude ? 'gps' : 'profile'),
            updatedAt: raw.updatedAt || new Date().toISOString(),
            updatedAtMs: Number(raw.updatedAtMs) || Date.parse(raw.updatedAt || '') || 0,
          };
          const prev = map.get(uid);
          if (!prev || rec.updatedAtMs >= prev.updatedAtMs) {
            map.set(uid, rec);
          }
        });
      } catch (err) {
        if (isQuotaExceededError(err)) {
          setQuotaBlocked(15 * 60 * 1000);
        }
      }
    }

    const result = Array.from(map.values()).filter((r) => !isExcludedFromLocationTracking(r));
    memoryLocationsCache = result;
    memoryLocationsFetchedAt = Date.now();
    safeLocalStorageSet(LOCATIONS_CACHE_KEY, JSON.stringify(result));
    return result;
  })();

  try {
    const docs = await inflightLocationsFetch;
    return mergeUsersWithLocationDocs(users, docs);
  } finally {
    inflightLocationsFetch = null;
  }
}

export function mergeUsersWithLocationDocs(
  users: UserProfile[],
  docs: UserLocationRecord[]
): UserLocationRecord[] {
  const byUid = new Map<string, UserLocationRecord>();
  docs.forEach((d) => {
    if (d?.uid && !isExcludedFromLocationTracking(d)) {
      byUid.set(d.uid, d);
    }
  });

  const merged: UserLocationRecord[] = [];
  const seen = new Set<string>();

  users.forEach((u: any) => {
    if (!u?.uid || u.isArchived) return;
    if (isExcludedFromLocationTracking(u)) {
      seen.add(u.uid); // Mark seen so extra doc fallback also skips it
      return;
    }
    seen.add(u.uid);
    const existing = byUid.get(u.uid);
    const profileAddress = [u.village, u.taluka, u.center, u.district, u.state]
      .filter(Boolean)
      .filter((v, idx, arr) => arr.findIndex((x) => String(x).toLowerCase() === String(v).toLowerCase()) === idx)
      .join(', ');

    if (existing) {
      merged.push({
        ...existing,
        userCode: u.userCode || existing.userCode || '',
        fullName: u.fullName || existing.fullName || u.uid,
        designation: u.designation || existing.designation || u.role || '',
        center: u.center || existing.center || '',
        mobileNumber: u.mobileNumber || existing.mobileNumber || '',
        addressLabel: existing.addressLabel || profileAddress || u.center || 'Not Available',
      });
    } else {
      merged.push({
        id: `loc_${u.uid}`,
        uid: u.uid,
        userCode: u.userCode || '',
        fullName: u.fullName || u.uid,
        designation: u.designation || u.role || '',
        center: u.center || '',
        mobileNumber: u.mobileNumber || '',
        latitude: null,
        longitude: null,
        accuracy: null,
        city: u.village || u.center || '',
        region: u.district || u.state || '',
        addressLabel: profileAddress || u.center || 'Not Available',
        source: 'profile',
        updatedAt: u.updatedAt || u.createdAt || '',
        updatedAtMs: Date.parse(u.updatedAt || u.createdAt || '') || 0,
      });
    }
  });

  // Include any extra location docs not matched in users list (still excluding filtered names)
  docs.forEach((d) => {
    if (d?.uid && !seen.has(d.uid) && !isExcludedFromLocationTracking(d)) {
      merged.push(d);
    }
  });

  // Sort active live locations (gps -> network) first, then most recently updated
  const sourceRank = (src?: string) => (src === 'gps' ? 2 : src === 'network' ? 1 : 0);
  return merged.sort((a, b) => {
    const rDiff = sourceRank(b.source) - sourceRank(a.source);
    if (rDiff !== 0) return rDiff;
    return (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
  });
}
