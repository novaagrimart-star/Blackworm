import {
  UserProfile,
  canAccessModule,
  isAdmin,
  isGodownIncharge,
  isUserRecord,
} from './auth';
import { toTimestampMs } from './dataService';
import { toTitleCase } from './utils';

export interface ModuleSeenEntry {
  seenAtMs: number;
  fingerprint?: string;
  viewedRecords?: Record<string, number>;
}

export type ModuleSeenMap = Record<string, ModuleSeenEntry>;

export interface UnreadRecordMeta {
  id: string;
  moduleId: string;
  subType?: string;
  actorName: string;
  actionLabel: string;
  title: string;
  updatedAtMs: number;
}

export interface ModuleUpdateBadge {
  moduleId: string;
  count: number;
  title: string;
  message: string;
  latestAtMs: number;
  unreadRecords?: UnreadRecordMeta[];
}

export interface RemoteAppUpdateSignal {
  hasUpdate?: boolean;
  remoteBuildId?: string;
  version?: string;
}

export interface ComputeModuleUpdatesInput {
  profile: Partial<UserProfile> | null | undefined;
  seenMap: ModuleSeenMap;
  orders?: any[];
  dealers?: any[];
  users?: any[];
  userApprovalRequests?: any[];
  officeStaff?: any[];
  officeAttendance?: any[];
  pricelist?: { products?: any[]; validityDate?: string; updatedAtMs?: number; loaded?: boolean };
  schemeDiscounts?: { discounts?: Record<string, number>; updatedAtMs?: number; loaded?: boolean };
  collections?: any[];
  outstandingRecords?: any[];
  yearlyTargets?: any[];
  monthlyTargets?: any[];
  travelSheets?: any[];
  locationVillages?: any[];
  locationTalukas?: any[];
  locationDealers?: any[];
  branding?: { logoUrl?: string; logoSize?: number; updatedAtMs?: number };
  remoteAppVersion?: RemoteAppUpdateSignal | null;
}

export interface ComputeModuleUpdatesResult {
  badges: Record<string, ModuleUpdateBadge>;
  items: ModuleUpdateBadge[];
  totalCount: number;
  signature: string;
}

const SEEN_STORAGE_PREFIX = 'blackworm_module_seen_v1_';
const POPUP_ACK_PREFIX = 'blackworm_module_popup_ack_v1_';
export const MODULE_SEEN_EVENT = 'blackworm_module_seen_updated';

export const ALL_TRACKED_MODULE_IDS = [
  'order',
  'dealer',
  'user',
  'office_staff',
  'price',
  'scheme',
  'collection',
  'calculator',
  'target',
  'travel',
  'location',
  'setting',
] as const;

export function getRecordUpdateMs(rec: any): number {
  if (!rec || typeof rec !== 'object') return 0;
  return Math.max(
    Number(rec._syncUpdatedAtMs) || 0,
    toTimestampMs(rec.updatedAt),
    toTimestampMs(rec.createdAt),
    toTimestampMs(rec.approvedAt),
    toTimestampMs(rec.warehouseDispatchedAt),
    toTimestampMs(rec.dispatchedAt),
    toTimestampMs(rec.warehouseDeliveredAt),
    toTimestampMs(rec.deliveredAt),
    toTimestampMs(rec.markedAt),
    toTimestampMs(rec.uploadedAt)
  );
}

/**
 * Default baseline for a fresh browser / new URL / updated APK:
 * Start of yesterday (local time) so today's and yesterday's officer updates
 * immediately show up as unread until explicitly viewed, without flooding older history.
 */
export function getDefaultInitialBaselineMs(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
}

export function loadModuleSeenMap(uid?: string | null): ModuleSeenMap {
  if (typeof window === 'undefined' || !uid) return {};
  try {
    const raw = localStorage.getItem(`${SEEN_STORAGE_PREFIX}${uid}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveModuleSeenMap(uid: string | undefined | null, map: ModuleSeenMap): void {
  if (typeof window === 'undefined' || !uid) return;
  try {
    localStorage.setItem(`${SEEN_STORAGE_PREFIX}${uid}`, JSON.stringify(map));
  } catch {}
}

function dispatchSeenUpdatedEvent(
  uid: string,
  moduleId: string,
  recordId?: string,
  source: 'local' | 'remote' = 'local'
): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent(MODULE_SEEN_EVENT, {
        detail: { uid, moduleId, recordId, source },
      })
    );
  } catch {}
}

export function notifyModuleSeenUpdated(
  uid: string,
  moduleId: string,
  source: 'local' | 'remote' = 'local',
  recordId?: string
): void {
  if (!uid) return;
  dispatchSeenUpdatedEvent(uid, moduleId, recordId, source);
}

export function getSeenCloudDocId(uid?: string | null): string {
  const raw = String(uid || '').trim();
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 140) || 'user';
  return `user_seen_${safe}`;
}

export function isRecordViewed(
  seenEntry: ModuleSeenEntry | undefined,
  recordId: string,
  recordTs: number
): boolean {
  if (!seenEntry) return false;
  const viewedMap = seenEntry.viewedRecords;
  if (viewedMap && recordId) {
    const recSeenAt = Number(viewedMap[recordId] || 0);
    if (recSeenAt > 0 && (recordTs <= 0 || recSeenAt >= recordTs)) {
      return true;
    }
  }
  if (seenEntry.seenAtMs > 0 && recordTs > 0 && recordTs <= seenEntry.seenAtMs) {
    return true;
  }
  return false;
}

function pruneViewedRecords(
  viewedRecords: Record<string, number>,
  seenAtMs: number,
  maxKeys = 250
): Record<string, number> {
  const entries = Object.entries(viewedRecords)
    .filter(([k, ts]) => Boolean(k) && Number.isFinite(Number(ts)) && Number(ts) > seenAtMs)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, maxKeys);
  const pruned: Record<string, number> = {};
  for (const [k, v] of entries) {
    pruned[k] = Number(v);
  }
  return pruned;
}

export function sanitizeModuleSeenEntry(raw: any): ModuleSeenEntry | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const seenAtMs = Math.max(0, Number(raw.seenAtMs) || 0);
  const fingerprint = typeof raw.fingerprint === 'string' && raw.fingerprint ? raw.fingerprint : undefined;
  const rawViewed =
    raw.viewedRecords && typeof raw.viewedRecords === 'object' && !Array.isArray(raw.viewedRecords)
      ? (raw.viewedRecords as Record<string, number>)
      : {};
  const viewedRecords = pruneViewedRecords(rawViewed, seenAtMs, 250);
  return {
    seenAtMs,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    ...(Object.keys(viewedRecords).length > 0 ? { viewedRecords } : {}),
  };
}

export function sanitizeModuleSeenMap(raw: any): ModuleSeenMap {
  const out: ModuleSeenMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const modId = String(k || '').trim();
    if (!modId) continue;
    const entry = sanitizeModuleSeenEntry(v);
    if (entry) out[modId] = entry;
  }
  return out;
}

export function mergeModuleSeenMaps(localRaw: any, remoteRaw: any): ModuleSeenMap {
  const localMap = sanitizeModuleSeenMap(localRaw);
  const remoteMap = sanitizeModuleSeenMap(remoteRaw);
  const allKeys = new Set<string>([...Object.keys(localMap), ...Object.keys(remoteMap)]);
  const merged: ModuleSeenMap = {};

  for (const modId of allKeys) {
    const a = localMap[modId];
    const b = remoteMap[modId];
    if (a && !b) {
      merged[modId] = a;
      continue;
    }
    if (!a && b) {
      merged[modId] = b;
      continue;
    }
    if (!a || !b) continue;

    const aSeen = Number(a.seenAtMs) || 0;
    const bSeen = Number(b.seenAtMs) || 0;
    const seenAtMs = Math.max(aSeen, bSeen);

    let fingerprint: string | undefined;
    if (aSeen > bSeen) {
      fingerprint = a.fingerprint ?? b.fingerprint;
    } else if (bSeen > aSeen) {
      fingerprint = b.fingerprint ?? a.fingerprint;
    } else {
      fingerprint = b.fingerprint || a.fingerprint;
    }

    const combinedViewed: Record<string, number> = { ...(a.viewedRecords || {}) };
    for (const [recId, tsVal] of Object.entries(b.viewedRecords || {})) {
      const ts = Number(tsVal) || 0;
      if (ts > (combinedViewed[recId] || 0)) {
        combinedViewed[recId] = ts;
      }
    }
    const viewedRecords = pruneViewedRecords(combinedViewed, seenAtMs, 250);

    merged[modId] = {
      seenAtMs,
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      ...(Object.keys(viewedRecords).length > 0 ? { viewedRecords } : {}),
    };
  }

  return merged;
}

export function areModuleSeenMapsEqual(aRaw: ModuleSeenMap, bRaw: ModuleSeenMap): boolean {
  const a = sanitizeModuleSeenMap(aRaw);
  const b = sanitizeModuleSeenMap(bRaw);
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;

  for (let i = 0; i < aKeys.length; i += 1) {
    const k = aKeys[i];
    if (k !== bKeys[i]) return false;
    const ae = a[k];
    const be = b[k];
    if ((Number(ae.seenAtMs) || 0) !== (Number(be.seenAtMs) || 0)) return false;
    if ((ae.fingerprint || '') !== (be.fingerprint || '')) return false;
    const av = ae.viewedRecords || {};
    const bv = be.viewedRecords || {};
    const avKeys = Object.keys(av).sort();
    const bvKeys = Object.keys(bv).sort();
    if (avKeys.length !== bvKeys.length) return false;
    for (let j = 0; j < avKeys.length; j += 1) {
      const rk = avKeys[j];
      if (rk !== bvKeys[j]) return false;
      if (Number(av[rk]) !== Number(bv[rk])) return false;
    }
  }
  return true;
}

export function markRecordUpdateViewed(
  uid: string | undefined | null,
  moduleId: string,
  recordId: string,
  recordTs?: number
): void {
  if (!uid || !moduleId || !recordId) return;
  const map = loadModuleSeenMap(uid);
  const prev = map[moduleId] || { seenAtMs: 0 };
  const stamp = Math.max(Number(recordTs) || 0, Date.now());
  const nextViewed = pruneViewedRecords(
    {
      ...(prev.viewedRecords || {}),
      [recordId]: Math.max(Number(prev.viewedRecords?.[recordId] || 0), stamp),
    },
    prev.seenAtMs || 0
  );
  map[moduleId] = {
    ...prev,
    viewedRecords: nextViewed,
  };
  saveModuleSeenMap(uid, map);
  dispatchSeenUpdatedEvent(uid, moduleId, recordId);
}

export function markModuleRecordsViewed(
  uid: string | undefined | null,
  moduleId: string,
  items: Array<{ id: string; ts?: number }>
): void {
  if (!uid || !moduleId || !items || items.length === 0) return;
  const map = loadModuleSeenMap(uid);
  const prev = map[moduleId] || { seenAtMs: 0 };
  const merged = { ...(prev.viewedRecords || {}) };
  const now = Date.now();
  let changed = false;
  for (const it of items) {
    if (!it?.id) continue;
    const stamp = Math.max(Number(it.ts) || 0, now);
    const existing = Number(merged[it.id] || 0);
    if (stamp > existing) {
      merged[it.id] = stamp;
      changed = true;
    }
  }
  if (!changed) return;
  map[moduleId] = {
    ...prev,
    viewedRecords: pruneViewedRecords(merged, prev.seenAtMs || 0),
  };
  saveModuleSeenMap(uid, map);
  dispatchSeenUpdatedEvent(uid, moduleId);
}

export function markModuleAllViewed(
  uid: string | undefined | null,
  moduleId: string,
  fingerprint?: string,
  minTs = 0
): void {
  if (!uid || !moduleId) return;
  const map = loadModuleSeenMap(uid);
  const prev = map[moduleId];
  const nextSeenAtMs = Math.max(Number(prev?.seenAtMs) || 0, Date.now() + 1500, Number(minTs) || 0);
  map[moduleId] = {
    seenAtMs: nextSeenAtMs,
    fingerprint: fingerprint !== undefined ? fingerprint : prev?.fingerprint,
    viewedRecords: {},
  };
  saveModuleSeenMap(uid, map);
  dispatchSeenUpdatedEvent(uid, moduleId);
}

export function loadAcknowledgedPopupSignature(uid?: string | null): string {
  if (typeof window === 'undefined' || !uid) return '';
  try {
    return String(localStorage.getItem(`${POPUP_ACK_PREFIX}${uid}`) || '');
  } catch {
    return '';
  }
}

export function saveAcknowledgedPopupSignature(uid: string | undefined | null, sig: string): void {
  if (typeof window === 'undefined' || !uid) return;
  try {
    localStorage.setItem(`${POPUP_ACK_PREFIX}${uid}`, sig);
  } catch {}
}

export function computePricelistFingerprint(products: any[] = [], validityDate = '', updatedAtMs = 0): string {
  let checksum = 0;
  for (let i = 0; i < products.length; i += 1) {
    const p = products[i];
    if (!p) continue;
    const rate = Number(p.dealerRate || p.rate || p.mrp || 0);
    checksum = (checksum + (i + 1) * (Math.round(rate * 100) % 9973)) % 1000000007;
  }
  return `${products.length}|${validityDate}|${updatedAtMs}|${checksum}`;
}

export function computeSchemeFingerprint(discounts: Record<string, number> = {}, updatedAtMs = 0): string {
  const entries = Object.entries(discounts || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${Number(v) || 0}`)
    .join(',');
  return `${updatedAtMs}|${entries}`;
}

export function computeSettingFingerprint(
  remoteAppVersion?: RemoteAppUpdateSignal | null,
  brandingUpdatedAtMs = 0
): string {
  const buildTag = remoteAppVersion?.hasUpdate ? String(remoteAppVersion.remoteBuildId || 'update') : '';
  return `${buildTag}|${brandingUpdatedAtMs}`;
}

export function resolveActorName(rec: any, fallback = 'Staff'): string {
  if (!rec || typeof rec !== 'object') return fallback;
  const raw =
    rec.updatedByName ||
    rec.warehouseDeliveredBy ||
    rec.warehouseDispatchedBy ||
    rec.approvedBy ||
    rec.collectedByName ||
    rec.markedByName ||
    rec.requestedByName ||
    rec.createdByName ||
    rec.created_by_name ||
    rec.officerName ||
    rec.staffName ||
    rec.fullName ||
    rec.userName ||
    '';
  const cleaned = toTitleCase(String(raw || '').trim());
  return cleaned || fallback;
}

function resolveOrderActorAndAction(o: any): { actorName: string; actionLabel: string } {
  const wh = String(o?.warehouseStatus || '').toLowerCase();
  const st = String(o?.status || '').toLowerCase();
  const createdMs = toTimestampMs(o?.createdAt);
  const approvedMs = toTimestampMs(o?.approvedAt);
  const dispatchedMs = toTimestampMs(o?.warehouseDispatchedAt || o?.dispatchedAt);
  const deliveredMs = toTimestampMs(o?.warehouseDeliveredAt || o?.deliveredAt);
  const updatedMs = toTimestampMs(o?.updatedAt);

  // If someone explicitly edited the order AFTER its latest status milestone, show the editor
  const latestMilestoneMs = Math.max(createdMs, approvedMs, dispatchedMs, deliveredMs);
  if (o?.updatedByName && updatedMs > latestMilestoneMs + 2000) {
    return {
      actorName: toTitleCase(String(o.updatedByName).trim()) || 'Staff',
      actionLabel: 'Updated Order',
    };
  }

  if ((wh === 'delivered' || st === 'delivered') && deliveredMs >= dispatchedMs && deliveredMs >= approvedMs) {
    const actor = toTitleCase(String(o?.warehouseDeliveredBy || o?.updatedByName || o?.approvedBy || '').trim()) || 'Warehouse';
    return { actorName: actor, actionLabel: 'Delivered' };
  }
  if ((wh === 'dispatched' || st === 'dispatched') && dispatchedMs >= approvedMs) {
    const actor = toTitleCase(String(o?.warehouseDispatchedBy || o?.updatedByName || '').trim()) || 'Warehouse';
    return { actorName: actor, actionLabel: 'Dispatched' };
  }
  if (st === 'complete' || st === 'approved') {
    const actor = toTitleCase(String(o?.approvedBy || o?.updatedByName || '').trim()) || 'Admin';
    return { actorName: actor, actionLabel: 'Approved' };
  }
  if (o?.updatedByName && updatedMs > 0 && createdMs > 0 && updatedMs - createdMs > 2000) {
    return {
      actorName: toTitleCase(String(o.updatedByName).trim()) || 'Staff',
      actionLabel: 'Updated Order',
    };
  }
  return {
    actorName: toTitleCase(String(o?.createdByName || o?.created_by_name || o?.officerName || '').trim()) || 'Officer',
    actionLabel: 'New Order',
  };
}

function isSelfAuthoredGeneric(rec: any, profile: Partial<UserProfile>): boolean {
  const myUid = String(profile.uid || '').trim().toLowerCase();
  if (!myUid) return false;
  const updatedByUid = String(rec.updatedByUid || rec.performedByUid || rec.markedByUid || '').trim().toLowerCase();
  if (updatedByUid) return updatedByUid === myUid;
  const createdByUid = String(rec.createdByUid || rec.created_by_user_id || '').trim().toLowerCase();
  const createdMs = toTimestampMs(rec.createdAt);
  const updatedMs = toTimestampMs(rec.updatedAt);
  // Only treat as self-authored if no separate updater updated it later
  if (createdByUid && createdByUid === myUid && (!updatedMs || Math.abs(updatedMs - createdMs) <= 2000)) {
    return true;
  }
  return false;
}

function isOrderSelfAuthoredOnly(order: any, profile: Partial<UserProfile>): boolean {
  const myUid = String(profile.uid || '').trim().toLowerCase();
  const myName = String(profile.fullName || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!myUid) return false;

  const ownerUid = String(
    order.userId || order.ownerId || order.created_by_user_id || order.createdByUid || ''
  )
    .trim()
    .toLowerCase();
  const status = String(order.status || '').toLowerCase();
  const whStatus = String(order.warehouseStatus || '').toLowerCase();
  const createdMs = toTimestampMs(order.createdAt);
  const approvedMs = toTimestampMs(order.approvedAt);
  const dispatchedMs = toTimestampMs(order.warehouseDispatchedAt || order.dispatchedAt);
  const deliveredMs = toTimestampMs(order.warehouseDeliveredAt || order.deliveredAt);
  const updatedMs = toTimestampMs(order.updatedAt);
  const lastByUid = String(order.updatedByUid || '').trim().toLowerCase();

  const isPostApprovalUpdate =
    status === 'approved' ||
    status === 'complete' ||
    status === 'dispatched' ||
    status === 'delivered' ||
    whStatus === 'dispatched' ||
    whStatus === 'delivered' ||
    Boolean(order.approvedAt) ||
    Boolean(order.warehouseDispatchedAt || order.dispatchedAt) ||
    Boolean(order.warehouseDeliveredAt || order.deliveredAt);

  // Check if the latest action is a Warehouse Dispatch or Delivery done by someone else
  const isWhDeliveryLatest =
    (whStatus === 'delivered' || status === 'delivered') &&
    deliveredMs >= approvedMs &&
    updatedMs <= deliveredMs + 2000;
  if (isWhDeliveryLatest) {
    const whActorName = String(order.warehouseDeliveredBy || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (whActorName && myName) {
      return whActorName === myName;
    }
  }

  const isWhDispatchLatest =
    (whStatus === 'dispatched' || status === 'dispatched') &&
    dispatchedMs >= approvedMs &&
    updatedMs <= dispatchedMs + 2000;
  if (isWhDispatchLatest) {
    const whActorName = String(order.warehouseDispatchedBy || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (whActorName && myName) {
      return whActorName === myName;
    }
  }

  // If Admin/Warehouse approved/dispatched/delivered/edited an officer's order, the officer MUST see it
  if (isPostApprovalUpdate && !isAdmin(profile)) {
    if (lastByUid && lastByUid === myUid) return true;
    return false;
  }
  if (ownerUid === myUid && !isPostApprovalUpdate && (status === 'pending' || status === 'pending_approval')) {
    if (lastByUid && lastByUid !== myUid) return false;
    return true;
  }
  return isSelfAuthoredGeneric(order, profile);
}

function isSameUserSelf(u: any, profile: Partial<UserProfile>): boolean {
  const myUid = String(profile.uid || '').trim().toLowerCase();
  const uUid = String(u?.uid || u?.id || '').trim().toLowerCase();
  if (myUid && uUid && myUid === uUid) return true;
  const myLogin = String(profile.loginId || '').trim().toLowerCase();
  const uLogin = String(u?.loginId || '').trim().toLowerCase();
  if (myLogin && uLogin && uLogin !== 'admin' && myLogin === uLogin) return true;
  return false;
}

function matchesTargetOrTravelOwner(rec: any, profile: Partial<UserProfile>): boolean {
  if (isAdmin(profile)) return true;
  if (isUserRecord(rec, profile)) return true;
  const myUid = String(profile.uid || '').trim().toLowerCase();
  const recUid = String(rec?.userId || rec?.uid || '').trim().toLowerCase();
  if (myUid && recUid && myUid === recUid) return true;
  const myLogin = String(profile.loginId || '').trim().toLowerCase();
  const recLogin = String(rec?.loginId || '').trim().toLowerCase();
  if (myLogin && recLogin && recLogin === myLogin) return true;
  const myName = String(profile.fullName || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const recName = String(rec?.fullName || rec?.officerName || rec?.userName || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return Boolean(myName && recName && myName === recName);
}

export function computeModuleUpdates(input: ComputeModuleUpdatesInput): ComputeModuleUpdatesResult {
  const { profile, seenMap } = input;
  const badges: Record<string, ModuleUpdateBadge> = {};
  if (!profile) {
    return { badges, items: [], totalCount: 0, signature: '' };
  }

  const userIsAdmin = isAdmin(profile);

  // 1. ORDERS
  if (canAccessModule(profile, 'order')) {
    const seenEntry = seenMap.order;
    const seenAt = seenEntry?.seenAtMs;
    const hasBaseline = seenAt !== undefined && seenAt > 0;
    const orders = (input.orders || []).filter((o) => o && !o.isArchived);
    const visibleOrders = userIsAdmin
      ? orders
      : orders.filter((o) => isUserRecord(o, profile));

    const updatedOrders = visibleOrders.filter((o) => {
      const st = String(o.status || '').toLowerCase();
      const ts = getRecordUpdateMs(o);
      const recId = String(o.id || '');
      if (recId && isRecordViewed(seenEntry, recId, ts)) return false;
      if (!hasBaseline) {
        if (userIsAdmin && (st === 'pending' || st === 'pending_approval')) return true;
        return ts > getDefaultInitialBaselineMs() && !isOrderSelfAuthoredOnly(o, profile);
      }
      if (ts <= (seenAt || 0)) return false;
      if (isOrderSelfAuthoredOnly(o, profile)) return false;
      return true;
    });

    if (updatedOrders.length > 0) {
      const sorted = [...updatedOrders].sort((a, b) => getRecordUpdateMs(b) - getRecordUpdateMs(a));
      const latestAtMs = Math.max(...sorted.map(getRecordUpdateMs), 0);
      const newest = sorted[0];
      const dealerName = toTitleCase(newest?.dealerName || newest?.firmName || '');
      const unreadRecords: UnreadRecordMeta[] = sorted.map((o) => {
        const { actorName, actionLabel } = resolveOrderActorAndAction(o);
        const firm = toTitleCase(o.dealerName || o.firmName || o.orderNumber || 'Order');
        return {
          id: String(o.id),
          moduleId: 'order',
          subType: 'order',
          actorName,
          actionLabel,
          title: `${o.orderNumber ? `${o.orderNumber} · ` : ''}${firm}`,
          updatedAtMs: getRecordUpdateMs(o),
        };
      });
      badges.order = {
        moduleId: 'order',
        count: unreadRecords.length,
        title: 'ऑर्डर्स (Orders)',
        message:
          unreadRecords.length === 1 && dealerName
            ? `${unreadRecords[0].actorName}: ${dealerName}`
            : `${unreadRecords.length} नवीन / अपडेटेड ऑर्डर्स`,
        latestAtMs,
        unreadRecords,
      };
    }
  }

  // 2. DEALER FORM
  if (canAccessModule(profile, 'dealer')) {
    const seenEntry = seenMap.dealer;
    const seenAt = seenEntry?.seenAtMs;
    if (seenAt !== undefined && seenAt > 0) {
      const dealers = (input.dealers || []).filter((d) => d && !d.isArchived);
      const visibleDealers = userIsAdmin
        ? dealers
        : dealers.filter(
            (d) =>
              isUserRecord(d, profile) ||
              String(d.createdByUid || d.created_by_user_id || d.userId || '').trim() === String(profile.uid || '').trim()
          );

      const updatedDealers = visibleDealers.filter((d) => {
        const ts = getRecordUpdateMs(d);
        const recId = String(d.id || '');
        if (recId && isRecordViewed(seenEntry, recId, ts)) return false;
        if (ts <= seenAt) return false;
        if (isSelfAuthoredGeneric(d, profile)) return false;
        return true;
      });

      if (updatedDealers.length > 0) {
        const sorted = [...updatedDealers].sort((a, b) => getRecordUpdateMs(b) - getRecordUpdateMs(a));
        const latestAtMs = Math.max(...sorted.map(getRecordUpdateMs), 0);
        const newest = sorted[0];
        const firm = toTitleCase(newest?.firmName || newest?.proprietorName || '');
        const unreadRecords: UnreadRecordMeta[] = sorted.map((d) => {
          const isEdit = Boolean(d.updatedByName && toTimestampMs(d.updatedAt) - toTimestampMs(d.createdAt) > 2000);
          return {
            id: String(d.id),
            moduleId: 'dealer',
            subType: 'dealer',
            actorName: resolveActorName(d, 'Officer'),
            actionLabel: isEdit ? 'Updated Dealer' : 'New Dealer',
            title: toTitleCase(d.firmName || d.proprietorName || 'Dealer'),
            updatedAtMs: getRecordUpdateMs(d),
          };
        });
        badges.dealer = {
          moduleId: 'dealer',
          count: unreadRecords.length,
          title: 'डीलर फॉर्म (Dealer)',
          message:
            unreadRecords.length === 1 && firm
              ? `${unreadRecords[0].actorName}: ${firm}`
              : `${unreadRecords.length} नवीन / अपडेटेड डीलर फॉर्म`,
          latestAtMs,
          unreadRecords,
        };
      }
    }
  }

  // 3. USER FORM & APPROVAL REQUESTS
  if (canAccessModule(profile, 'user')) {
    const seenEntry = seenMap.user;
    const seenAt = seenEntry?.seenAtMs;
    const hasBaseline = seenAt !== undefined && seenAt > 0;
    const users = (input.users || []).filter((u) => u && !u.isArchived);
    const pendingReqs = userIsAdmin
      ? (input.userApprovalRequests || []).filter((r) => r && !r.isArchived && r.status === 'pending')
      : [];

    const visibleUsers = userIsAdmin ? users : users.filter((u) => isSameUserSelf(u, profile));

    const updatedUsers = hasBaseline
      ? visibleUsers.filter((u) => {
          const ts = getRecordUpdateMs(u);
          const recId = String(u.uid || u.id || '');
          if (recId && isRecordViewed(seenEntry, recId, ts)) return false;
          if (ts <= (seenAt || 0)) return false;
          if (!userIsAdmin && isSelfAuthoredGeneric(u, profile)) return false;
          if (userIsAdmin && isSameUserSelf(u, profile)) return false;
          return true;
        })
      : [];

    const unreadReqs = pendingReqs.filter((r) => {
      const ts = getRecordUpdateMs(r);
      const reqKey = `req:${r.id}`;
      if (isRecordViewed(seenEntry, reqKey, ts) || isRecordViewed(seenEntry, String(r.id), ts)) return false;
      if (!hasBaseline) return true;
      return ts > (seenAt || 0);
    });

    const unreadRecords: UnreadRecordMeta[] = [
      ...unreadReqs.map((r) => ({
        id: `req:${r.id}`,
        moduleId: 'user',
        subType: 'approval_request',
        actorName: toTitleCase(String(r.requestedByName || r.fullName || 'Employee').trim()) || 'Employee',
        actionLabel: r.requestType === 'password_change' ? 'Password Request' : 'Profile Update Request',
        title: toTitleCase(r.fullName || r.requestedByName || 'Approval Request'),
        updatedAtMs: getRecordUpdateMs(r),
      })),
      ...updatedUsers.map((u) => ({
        id: String(u.uid || u.id),
        moduleId: 'user',
        subType: 'user',
        actorName: resolveActorName(u, 'Admin'),
        actionLabel: 'User Form Updated',
        title: toTitleCase(u.fullName || u.loginId || 'User'),
        updatedAtMs: getRecordUpdateMs(u),
      })),
    ].sort((a, b) => b.updatedAtMs - a.updatedAtMs);

    if (unreadRecords.length > 0) {
      const latestAtMs = Math.max(...unreadRecords.map((r) => r.updatedAtMs), 0);
      badges.user = {
        moduleId: 'user',
        count: unreadRecords.length,
        title: 'युजर फॉर्म (User Form)',
        message:
          unreadReqs.length > 0
            ? `${unreadReqs.length} प्रोफाइल बदल मंजुरी प्रतीक्षेत`
            : `${unreadRecords.length} युजर फॉर्म अपडेट झाले`,
        latestAtMs,
        unreadRecords,
      };
    }
  }

  // 4. WAREHOUSE INCHARGE (Approved/Complete Orders + Staff + Attendance)
  if (canAccessModule(profile, 'office_staff')) {
    const seenEntry = seenMap.office_staff;
    const seenAt = seenEntry?.seenAtMs;
    const hasBaseline = seenAt !== undefined && seenAt > 0;
    const approvedOrders = (input.orders || []).filter((o) => {
      if (!o || o.isArchived) return false;
      const st = String(o.status || '').toLowerCase();
      return (
        st === 'complete' ||
        st === 'approved' ||
        st === 'dispatched' ||
        st === 'delivered' ||
        st === 'collected' ||
        st === 'confirmed'
      );
    });
    const staffList = (input.officeStaff || []).filter((s) => s && !s.isArchived);
    const attendanceList = (input.officeAttendance || []).filter((a) => a && !a.isArchived);

    const unreadRecords: UnreadRecordMeta[] = [];

    approvedOrders.forEach((o) => {
      const whStatus = String(o.warehouseStatus || 'fresh').toLowerCase();
      const ts = Math.max(
        toTimestampMs(o.approvedAt),
        toTimestampMs(o.warehouseDispatchedAt || o.dispatchedAt),
        toTimestampMs(o.warehouseDeliveredAt || o.deliveredAt),
        getRecordUpdateMs(o)
      );
      const recKey = `order:${o.id}`;
      if (isRecordViewed(seenEntry, recKey, ts) || isRecordViewed(seenEntry, String(o.id), ts)) {
        return;
      }
      if (!hasBaseline) {
        if (isGodownIncharge(profile) && whStatus === 'fresh') {
          const { actorName, actionLabel } = resolveOrderActorAndAction(o);
          unreadRecords.push({
            id: recKey,
            moduleId: 'office_staff',
            subType: 'order',
            actorName,
            actionLabel,
            title: `${o.orderNumber ? `${o.orderNumber} · ` : ''}${toTitleCase(o.dealerName || 'Order')}`,
            updatedAtMs: ts,
          });
        }
        return;
      }
      if (ts > (seenAt || 0) && !isSelfAuthoredGeneric(o, profile)) {
        const { actorName, actionLabel } = resolveOrderActorAndAction(o);
        unreadRecords.push({
          id: recKey,
          moduleId: 'office_staff',
          subType: 'order',
          actorName,
          actionLabel,
          title: `${o.orderNumber ? `${o.orderNumber} · ` : ''}${toTitleCase(o.dealerName || 'Order')}`,
          updatedAtMs: ts,
        });
      }
    });

    if (hasBaseline) {
      staffList.forEach((s) => {
        const ts = getRecordUpdateMs(s);
        const recKey = `staff:${s.id}`;
        if (
          ts > (seenAt || 0) &&
          !isSelfAuthoredGeneric(s, profile) &&
          !isRecordViewed(seenEntry, recKey, ts) &&
          !isRecordViewed(seenEntry, String(s.id), ts)
        ) {
          unreadRecords.push({
            id: recKey,
            moduleId: 'office_staff',
            subType: 'staff',
            actorName: resolveActorName(s, 'Warehouse'),
            actionLabel: 'Staff Update',
            title: toTitleCase(s.fullName || s.name || 'Staff'),
            updatedAtMs: ts,
          });
        }
      });
      attendanceList.forEach((a) => {
        const ts = getRecordUpdateMs(a);
        const recKey = `att:${a.id}`;
        if (
          ts > (seenAt || 0) &&
          !isSelfAuthoredGeneric(a, profile) &&
          !isRecordViewed(seenEntry, recKey, ts) &&
          !isRecordViewed(seenEntry, String(a.id), ts)
        ) {
          unreadRecords.push({
            id: recKey,
            moduleId: 'office_staff',
            subType: 'attendance',
            actorName: resolveActorName(a, 'Warehouse'),
            actionLabel: 'Attendance',
            title: toTitleCase(a.staffName || a.date || 'Attendance'),
            updatedAtMs: ts,
          });
        }
      });
    }

    if (unreadRecords.length > 0) {
      unreadRecords.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      const latestAtMs = Math.max(...unreadRecords.map((r) => r.updatedAtMs), 0);
      badges.office_staff = {
        moduleId: 'office_staff',
        count: unreadRecords.length,
        title: 'वेअर हाऊस (Warehouse)',
        message: `${unreadRecords.length} वेअर हाऊस / डिस्पॅच अपडेट्स`,
        latestAtMs,
        unreadRecords,
      };
    }
  }

  // 5. PRICE LIST
  if (canAccessModule(profile, 'price')) {
    const seenEntry = seenMap.price;
    const products = input.pricelist?.products || [];
    const validityDate = input.pricelist?.validityDate || '';
    const updatedAtMs = Number(input.pricelist?.updatedAtMs || 0);
    if (seenEntry !== undefined && products.length > 0) {
      const fp = computePricelistFingerprint(products, validityDate, updatedAtMs);
      const isUpdated =
        (updatedAtMs > 0 && updatedAtMs > seenEntry.seenAtMs) ||
        Boolean(seenEntry.fingerprint && seenEntry.fingerprint !== fp);
      if (isUpdated) {
        badges.price = {
          moduleId: 'price',
          count: 1,
          title: 'प्राईस लिस्ट (Price List)',
          message: validityDate
            ? `नवीन प्राईस लिस्ट अपडेट (${validityDate})`
            : 'प्राईस लिस्ट अपडेट झाली आहे',
          latestAtMs: updatedAtMs || Date.now(),
          unreadRecords: [
            {
              id: 'pricelist_master',
              moduleId: 'price',
              subType: 'pricelist',
              actorName: 'Admin',
              actionLabel: 'Price List Updated',
              title: validityDate ? `Validity: ${validityDate}` : `${products.length} Products`,
              updatedAtMs: updatedAtMs || Date.now(),
            },
          ],
        };
      }
    }
  }

  // 6. SCHEME
  if (canAccessModule(profile, 'scheme')) {
    const seenEntry = seenMap.scheme;
    const discounts = input.schemeDiscounts?.discounts || {};
    const updatedAtMs = Number(input.schemeDiscounts?.updatedAtMs || 0);
    if (seenEntry !== undefined) {
      const fp = computeSchemeFingerprint(discounts, updatedAtMs);
      const isUpdated =
        (updatedAtMs > 0 && updatedAtMs > seenEntry.seenAtMs) ||
        Boolean(seenEntry.fingerprint && seenEntry.fingerprint !== fp);
      if (isUpdated) {
        badges.scheme = {
          moduleId: 'scheme',
          count: 1,
          title: 'स्कीम (Scheme)',
          message: 'स्कीम / अतिरिक्त डिस्काउंट अपडेट झाले',
          latestAtMs: updatedAtMs || Date.now(),
          unreadRecords: [
            {
              id: 'scheme_discounts',
              moduleId: 'scheme',
              subType: 'scheme',
              actorName: 'Admin',
              actionLabel: 'Scheme Updated',
              title: 'स्कीम / अतिरिक्त डिस्काउंट अपडेट झाले',
              updatedAtMs: updatedAtMs || Date.now(),
            },
          ],
        };
      }
    }
  }

  // 7. COLLECTIONS
  if (canAccessModule(profile, 'collection')) {
    const seenEntry = seenMap.collection;
    const seenAt = seenEntry?.seenAtMs;
    if (seenAt !== undefined && seenAt > 0) {
      const visible = (input.collections || []).filter(
        (c) => c && !c.isArchived && (userIsAdmin || isUserRecord(c, profile))
      );
      const updated = visible.filter((c) => {
        const ts = getRecordUpdateMs(c);
        const recId = String(c.id || '');
        if (recId && isRecordViewed(seenEntry, recId, ts)) return false;
        return ts > seenAt && !isSelfAuthoredGeneric(c, profile);
      });
      if (updated.length > 0) {
        const sorted = [...updated].sort((a, b) => getRecordUpdateMs(b) - getRecordUpdateMs(a));
        const unreadRecords: UnreadRecordMeta[] = sorted.map((c) => ({
          id: String(c.id),
          moduleId: 'collection',
          subType: 'collection',
          actorName: resolveActorName(c, 'Officer'),
          actionLabel: `₹${Number(c.amount || 0).toLocaleString()} Collection`,
          title: toTitleCase(c.dealerName || c.partyName || 'Collection Entry'),
          updatedAtMs: getRecordUpdateMs(c),
        }));
        badges.collection = {
          moduleId: 'collection',
          count: unreadRecords.length,
          title: 'कलेक्शन (Collections)',
          message: `${unreadRecords.length} नवीन कलेक्शन नोंदी / अपडेट`,
          latestAtMs: Math.max(...unreadRecords.map((r) => r.updatedAtMs), 0),
          unreadRecords,
        };
      }
    }
  }

  // 8. OUTSTANDING (calculator)
  if (canAccessModule(profile, 'calculator')) {
    const seenEntry = seenMap.calculator;
    const seenAt = seenEntry?.seenAtMs;
    if (seenAt !== undefined && seenAt > 0) {
      const visible = (input.outstandingRecords || []).filter(
        (r) => r && !r.isArchived && (userIsAdmin || isUserRecord(r, profile))
      );
      const updated = visible.filter((r) => {
        const ts = getRecordUpdateMs(r);
        const recId = String(r.id || '');
        if (recId && isRecordViewed(seenEntry, recId, ts)) return false;
        return ts > seenAt && !isSelfAuthoredGeneric(r, profile);
      });
      if (updated.length > 0) {
        const sorted = [...updated].sort((a, b) => getRecordUpdateMs(b) - getRecordUpdateMs(a));
        const unreadRecords: UnreadRecordMeta[] = sorted.map((r) => ({
          id: String(r.id),
          moduleId: 'calculator',
          subType: 'outstanding',
          actorName: resolveActorName(r, 'Admin'),
          actionLabel: 'Outstanding Updated',
          title: toTitleCase(r.dealerName || r.partyName || r.officerName || 'Outstanding Record'),
          updatedAtMs: getRecordUpdateMs(r),
        }));
        badges.calculator = {
          moduleId: 'calculator',
          count: unreadRecords.length,
          title: 'आऊटस्टँडिंग (Outstanding)',
          message: `${unreadRecords.length} आऊटस्टँडिंग नोंदी अपडेट झाल्या`,
          latestAtMs: Math.max(...unreadRecords.map((r) => r.updatedAtMs), 0),
          unreadRecords,
        };
      }
    }
  }

  // 9. TARGET SHEET
  if (canAccessModule(profile, 'target')) {
    const seenEntry = seenMap.target;
    const seenAt = seenEntry?.seenAtMs;
    if (seenAt !== undefined && seenAt > 0) {
      const combinedTargets = [...(input.yearlyTargets || []), ...(input.monthlyTargets || [])].filter(
        (t) => t && !t.isArchived && matchesTargetOrTravelOwner(t, profile)
      );
      const updated = combinedTargets.filter((t) => {
        const ts = getRecordUpdateMs(t);
        const recId = String(t.id || '');
        if (recId && isRecordViewed(seenEntry, recId, ts)) return false;
        return ts > seenAt && !isSelfAuthoredGeneric(t, profile);
      });
      if (updated.length > 0) {
        const sorted = [...updated].sort((a, b) => getRecordUpdateMs(b) - getRecordUpdateMs(a));
        const unreadRecords: UnreadRecordMeta[] = sorted.map((t) => ({
          id: String(t.id),
          moduleId: 'target',
          subType: 'target',
          actorName: resolveActorName(t, 'Officer'),
          actionLabel: 'Target Updated',
          title: toTitleCase(t.officerName || t.fullName || t.month || t.year || 'Target Sheet'),
          updatedAtMs: getRecordUpdateMs(t),
        }));
        badges.target = {
          moduleId: 'target',
          count: unreadRecords.length,
          title: 'टार्गेट शीट (Target Sheet)',
          message: `${unreadRecords.length} टार्गेट शीट अपडेट झाले`,
          latestAtMs: Math.max(...unreadRecords.map((r) => r.updatedAtMs), 0),
          unreadRecords,
        };
      }
    }
  }

  // 10. TRAVELING
  if (canAccessModule(profile, 'travel')) {
    const seenEntry = seenMap.travel;
    const seenAt = seenEntry?.seenAtMs;
    if (seenAt !== undefined && seenAt > 0) {
      const visible = (input.travelSheets || []).filter(
        (s) => s && !s.isArchived && matchesTargetOrTravelOwner(s, profile)
      );
      const updated = visible.filter((s) => {
        const ts = getRecordUpdateMs(s);
        const recId = String(s.id || '');
        if (recId && isRecordViewed(seenEntry, recId, ts)) return false;
        return ts > seenAt && !isSelfAuthoredGeneric(s, profile);
      });
      if (updated.length > 0) {
        const sorted = [...updated].sort((a, b) => getRecordUpdateMs(b) - getRecordUpdateMs(a));
        const unreadRecords: UnreadRecordMeta[] = sorted.map((s) => ({
          id: String(s.id),
          moduleId: 'travel',
          subType: 'travel',
          actorName: resolveActorName(s, 'Officer'),
          actionLabel: 'Traveling Updated',
          title: toTitleCase(s.officerName || s.fullName || s.month || 'Traveling Sheet'),
          updatedAtMs: getRecordUpdateMs(s),
        }));
        badges.travel = {
          moduleId: 'travel',
          count: unreadRecords.length,
          title: 'ट्रॅव्हलिंग (Traveling)',
          message: `${unreadRecords.length} ट्रॅव्हलिंग शीट अपडेट झाले`,
          latestAtMs: Math.max(...unreadRecords.map((r) => r.updatedAtMs), 0),
          unreadRecords,
        };
      }
    }
  }

  // 11. LOCATION MAPPING
  if (canAccessModule(profile, 'location')) {
    const seenEntry = seenMap.location;
    const seenAt = seenEntry?.seenAtMs;
    if (seenAt !== undefined && seenAt > 0) {
      const visibleLocDealers = (input.locationDealers || []).filter(
        (d) =>
          d &&
          !d.isArchived &&
          (userIsAdmin ||
            isUserRecord(d, profile) ||
            String(d.createdByUid || d.userId || '').trim() === String(profile.uid || '').trim())
      );
      const villages = (input.locationVillages || []).filter((l) => l && !l.isArchived);
      const talukas = (input.locationTalukas || []).filter((l) => l && !l.isArchived);

      const unreadRecords: UnreadRecordMeta[] = [];
      visibleLocDealers.forEach((d) => {
        const ts = getRecordUpdateMs(d);
        const recId = String(d.id || '');
        if (ts > seenAt && !isSelfAuthoredGeneric(d, profile) && !(recId && isRecordViewed(seenEntry, recId, ts))) {
          unreadRecords.push({
            id: recId,
            moduleId: 'location',
            subType: 'location_dealer',
            actorName: resolveActorName(d, 'Officer'),
            actionLabel: 'Location Dealer',
            title: toTitleCase(d.firmName || d.dealerName || d.villageName || 'Dealer'),
            updatedAtMs: ts,
          });
        }
      });
      villages.forEach((v) => {
        const ts = getRecordUpdateMs(v);
        const recId = `village:${v.id}`;
        if (ts > seenAt && !isSelfAuthoredGeneric(v, profile) && !isRecordViewed(seenEntry, recId, ts)) {
          unreadRecords.push({
            id: recId,
            moduleId: 'location',
            subType: 'village',
            actorName: resolveActorName(v, 'Staff'),
            actionLabel: 'Village Added',
            title: toTitleCase(v.villageName || v.name || 'Village'),
            updatedAtMs: ts,
          });
        }
      });
      talukas.forEach((t) => {
        const ts = getRecordUpdateMs(t);
        const recId = `taluka:${t.id}`;
        if (ts > seenAt && !isSelfAuthoredGeneric(t, profile) && !isRecordViewed(seenEntry, recId, ts)) {
          unreadRecords.push({
            id: recId,
            moduleId: 'location',
            subType: 'taluka',
            actorName: resolveActorName(t, 'Staff'),
            actionLabel: 'Taluka Added',
            title: toTitleCase(t.talukaName || t.name || 'Taluka'),
            updatedAtMs: ts,
          });
        }
      });

      if (unreadRecords.length > 0) {
        unreadRecords.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
        badges.location = {
          moduleId: 'location',
          count: unreadRecords.length,
          title: 'लोकेशन मॅपिंग (Location)',
          message: `${unreadRecords.length} नवीन लोकेशन / डीलर नोंदी अपडेट`,
          latestAtMs: Math.max(...unreadRecords.map((r) => r.updatedAtMs), 0),
          unreadRecords,
        };
      }
    }
  }

  // 12. SETTING (Remote App Version Update + Branding Update)
  if (canAccessModule(profile, 'setting')) {
    const seenEntry = seenMap.setting;
    const remoteHasUpdate = Boolean(input.remoteAppVersion?.hasUpdate && input.remoteAppVersion?.remoteBuildId);
    const brandingUpdatedAtMs = Number(input.branding?.updatedAtMs || 0);

    const prevFp = seenEntry?.fingerprint || '';
    const [seenBuildTag = ''] = prevFp.split('|');

    const unseenAppUpdate = remoteHasUpdate && String(input.remoteAppVersion?.remoteBuildId || '') !== seenBuildTag;
    const unseenBrandingUpdate =
      seenEntry !== undefined && brandingUpdatedAtMs > 0 && brandingUpdatedAtMs > seenEntry.seenAtMs;

    const settingCount = (unseenAppUpdate ? 1 : 0) + (unseenBrandingUpdate ? 1 : 0);
    if (settingCount > 0) {
      const unreadRecords: UnreadRecordMeta[] = [];
      if (unseenAppUpdate) {
        unreadRecords.push({
          id: 'app_version_update',
          moduleId: 'setting',
          subType: 'app_version',
          actorName: 'System',
          actionLabel: 'App Update Available',
          title: 'नवीन ॲप व्हर्जन उपलब्ध आहे',
          updatedAtMs: Date.now(),
        });
      }
      if (unseenBrandingUpdate) {
        unreadRecords.push({
          id: 'branding_update',
          moduleId: 'setting',
          subType: 'branding',
          actorName: 'Admin',
          actionLabel: 'Branding Updated',
          title: 'ॲप लोगो / ब्रँडिंग अपडेट झाले',
          updatedAtMs: brandingUpdatedAtMs,
        });
      }
      badges.setting = {
        moduleId: 'setting',
        count: settingCount,
        title: 'सेटिंग्ज (Setting)',
        message: unseenAppUpdate
          ? 'नवीन ॲप व्हर्जन / सिस्टम अपडेट उपलब्ध आहे'
          : 'ॲप ब्रँडिंग / सेटिंग अपडेट झाले आहे',
        latestAtMs: Math.max(brandingUpdatedAtMs, unseenAppUpdate ? Date.now() : 0),
        unreadRecords,
      };
    }
  }

  const items = Object.values(badges).sort((a, b) => b.latestAtMs - a.latestAtMs);
  const totalCount = items.reduce((sum, item) => sum + item.count, 0);
  const signature = items.map((i) => `${i.moduleId}:${i.count}:${i.latestAtMs}`).join(';');

  return { badges, items, totalCount, signature };
}
