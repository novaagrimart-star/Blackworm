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
}

export type ModuleSeenMap = Record<string, ModuleSeenEntry>;

export interface ModuleUpdateBadge {
  moduleId: string;
  count: number;
  title: string;
  message: string;
  latestAtMs: number;
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
    toTimestampMs(rec.markedAt)
  );
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
  if (!myUid) return false;
  const ownerUid = String(
    order.userId || order.ownerId || order.created_by_user_id || order.createdByUid || ''
  )
    .trim()
    .toLowerCase();
  const status = String(order.status || '').toLowerCase();
  const isPostApprovalUpdate =
    status === 'approved' ||
    Boolean(order.approvedAt) ||
    Boolean(order.warehouseDispatchedAt || order.dispatchedAt) ||
    Boolean(order.warehouseDeliveredAt || order.deliveredAt);

  // If Admin approved/dispatched/delivered an officer's order, the officer MUST see it
  if (isPostApprovalUpdate && !isAdmin(profile)) {
    return false;
  }
  if (isAdmin(profile) && status === 'approved' && !order.updatedByUid) {
    // Admin just approved the order themselves
    return false;
  }
  if (ownerUid === myUid && !isPostApprovalUpdate && (status === 'pending' || status === 'pending_approval')) {
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
    const seenAt = seenMap.order?.seenAtMs;
    const orders = (input.orders || []).filter((o) => o && !o.isArchived);
    const visibleOrders = userIsAdmin
      ? orders
      : orders.filter((o) => isUserRecord(o, profile));

    const updatedOrders = visibleOrders.filter((o) => {
      const st = String(o.status || '').toLowerCase();
      if (seenAt === undefined) {
        // First-ever baseline: show pending approvals for Admin immediately
        return userIsAdmin && (st === 'pending' || st === 'pending_approval');
      }
      const ts = getRecordUpdateMs(o);
      if (ts <= seenAt) return false;
      if (isOrderSelfAuthoredOnly(o, profile)) return false;
      return true;
    });

    if (updatedOrders.length > 0) {
      const latestAtMs = Math.max(...updatedOrders.map(getRecordUpdateMs), 0);
      const newest = updatedOrders[0];
      const dealerName = toTitleCase(newest?.dealerName || newest?.firmName || '');
      badges.order = {
        moduleId: 'order',
        count: updatedOrders.length,
        title: 'ऑर्डर्स (Orders)',
        message:
          updatedOrders.length === 1 && dealerName
            ? `ऑर्डर अपडेट: ${dealerName}`
            : `${updatedOrders.length} नवीन / अपडेटेड ऑर्डर्स`,
        latestAtMs,
      };
    }
  }

  // 2. DEALER FORM
  if (canAccessModule(profile, 'dealer')) {
    const seenAt = seenMap.dealer?.seenAtMs;
    if (seenAt !== undefined) {
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
        if (ts <= seenAt) return false;
        if (isSelfAuthoredGeneric(d, profile)) return false;
        return true;
      });

      if (updatedDealers.length > 0) {
        const latestAtMs = Math.max(...updatedDealers.map(getRecordUpdateMs), 0);
        const newest = updatedDealers[0];
        const firm = toTitleCase(newest?.firmName || newest?.proprietorName || '');
        badges.dealer = {
          moduleId: 'dealer',
          count: updatedDealers.length,
          title: 'डीलर फॉर्म (Dealer)',
          message:
            updatedDealers.length === 1 && firm
              ? `नवीन डीलर फॉर्म: ${firm}`
              : `${updatedDealers.length} नवीन / अपडेटेड डीलर फॉर्म`,
          latestAtMs,
        };
      }
    }
  }

  // 3. USER FORM & APPROVAL REQUESTS
  if (canAccessModule(profile, 'user')) {
    const seenAt = seenMap.user?.seenAtMs;
    const users = (input.users || []).filter((u) => u && !u.isArchived);
    const pendingReqs = userIsAdmin
      ? (input.userApprovalRequests || []).filter((r) => r && !r.isArchived && r.status === 'pending')
      : [];

    const visibleUsers = userIsAdmin ? users : users.filter((u) => isSameUserSelf(u, profile));

    const updatedUsers =
      seenAt !== undefined
        ? visibleUsers.filter((u) => {
            const ts = getRecordUpdateMs(u);
            if (ts <= seenAt) return false;
            if (!userIsAdmin && isSelfAuthoredGeneric(u, profile)) return false;
            if (userIsAdmin && isSameUserSelf(u, profile)) return false;
            return true;
          })
        : [];

    const unreadReqs =
      seenAt === undefined
        ? pendingReqs
        : pendingReqs.filter((r) => getRecordUpdateMs(r) > seenAt || r.status === 'pending');

    const totalUserCount = updatedUsers.length + unreadReqs.length;
    if (totalUserCount > 0) {
      const latestAtMs = Math.max(
        ...updatedUsers.map(getRecordUpdateMs),
        ...unreadReqs.map(getRecordUpdateMs),
        0
      );
      badges.user = {
        moduleId: 'user',
        count: totalUserCount,
        title: 'युजर फॉर्म (User Form)',
        message:
          unreadReqs.length > 0
            ? `${unreadReqs.length} प्रोफाइल बदल मंजुरी प्रतीक्षेत`
            : `${totalUserCount} युजर फॉर्म अपडेट झाले`,
        latestAtMs,
      };
    }
  }

  // 4. WAREHOUSE INCHARGE (Approved Orders + Staff + Attendance)
  if (canAccessModule(profile, 'office_staff')) {
    const seenAt = seenMap.office_staff?.seenAtMs;
    const approvedOrders = (input.orders || []).filter(
      (o) => o && !o.isArchived && String(o.status || '').toLowerCase() === 'approved'
    );
    const staffList = (input.officeStaff || []).filter((s) => s && !s.isArchived);
    const attendanceList = (input.officeAttendance || []).filter((a) => a && !a.isArchived);

    let warehouseCount = 0;
    let latestAtMs = 0;

    approvedOrders.forEach((o) => {
      const whStatus = String(o.warehouseStatus || 'fresh').toLowerCase();
      if (seenAt === undefined) {
        if (isGodownIncharge(profile) && whStatus === 'fresh') {
          warehouseCount += 1;
          latestAtMs = Math.max(latestAtMs, getRecordUpdateMs(o));
        }
        return;
      }
      const ts = Math.max(
        toTimestampMs(o.approvedAt),
        toTimestampMs(o.warehouseDispatchedAt || o.dispatchedAt),
        toTimestampMs(o.warehouseDeliveredAt || o.deliveredAt),
        getRecordUpdateMs(o)
      );
      if (ts > seenAt) {
        warehouseCount += 1;
        latestAtMs = Math.max(latestAtMs, ts);
      }
    });

    if (seenAt !== undefined) {
      staffList.forEach((s) => {
        const ts = getRecordUpdateMs(s);
        if (ts > seenAt && !isSelfAuthoredGeneric(s, profile)) {
          warehouseCount += 1;
          latestAtMs = Math.max(latestAtMs, ts);
        }
      });
      attendanceList.forEach((a) => {
        const ts = getRecordUpdateMs(a);
        if (ts > seenAt && !isSelfAuthoredGeneric(a, profile)) {
          warehouseCount += 1;
          latestAtMs = Math.max(latestAtMs, ts);
        }
      });
    }

    if (warehouseCount > 0) {
      badges.office_staff = {
        moduleId: 'office_staff',
        count: warehouseCount,
        title: 'वेअर हाऊस (Warehouse)',
        message: `${warehouseCount} वेअर हाऊस / डिस्पॅच अपडेट्स`,
        latestAtMs,
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
        };
      }
    }
  }

  // 7. COLLECTIONS
  if (canAccessModule(profile, 'collection')) {
    const seenAt = seenMap.collection?.seenAtMs;
    if (seenAt !== undefined) {
      const visible = (input.collections || []).filter(
        (c) => c && !c.isArchived && (userIsAdmin || isUserRecord(c, profile))
      );
      const updated = visible.filter(
        (c) => getRecordUpdateMs(c) > seenAt && !isSelfAuthoredGeneric(c, profile)
      );
      if (updated.length > 0) {
        badges.collection = {
          moduleId: 'collection',
          count: updated.length,
          title: 'कलेक्शन (Collections)',
          message: `${updated.length} नवीन कलेक्शन नोंदी / अपडेट`,
          latestAtMs: Math.max(...updated.map(getRecordUpdateMs), 0),
        };
      }
    }
  }

  // 8. OUTSTANDING (calculator)
  if (canAccessModule(profile, 'calculator')) {
    const seenAt = seenMap.calculator?.seenAtMs;
    if (seenAt !== undefined) {
      const visible = (input.outstandingRecords || []).filter(
        (r) => r && !r.isArchived && (userIsAdmin || isUserRecord(r, profile))
      );
      const updated = visible.filter(
        (r) => getRecordUpdateMs(r) > seenAt && !isSelfAuthoredGeneric(r, profile)
      );
      if (updated.length > 0) {
        badges.calculator = {
          moduleId: 'calculator',
          count: updated.length,
          title: 'आऊटस्टँडिंग (Outstanding)',
          message: `${updated.length} आऊटस्टँडिंग नोंदी अपडेट झाल्या`,
          latestAtMs: Math.max(...updated.map(getRecordUpdateMs), 0),
        };
      }
    }
  }

  // 9. TARGET SHEET
  if (canAccessModule(profile, 'target')) {
    const seenAt = seenMap.target?.seenAtMs;
    if (seenAt !== undefined) {
      const combinedTargets = [...(input.yearlyTargets || []), ...(input.monthlyTargets || [])].filter(
        (t) => t && !t.isArchived && matchesTargetOrTravelOwner(t, profile)
      );
      const updated = combinedTargets.filter(
        (t) => getRecordUpdateMs(t) > seenAt && !isSelfAuthoredGeneric(t, profile)
      );
      if (updated.length > 0) {
        badges.target = {
          moduleId: 'target',
          count: updated.length,
          title: 'टार्गेट शीट (Target Sheet)',
          message: `${updated.length} टार्गेट शीट अपडेट झाले`,
          latestAtMs: Math.max(...updated.map(getRecordUpdateMs), 0),
        };
      }
    }
  }

  // 10. TRAVELING
  if (canAccessModule(profile, 'travel')) {
    const seenAt = seenMap.travel?.seenAtMs;
    if (seenAt !== undefined) {
      const visible = (input.travelSheets || []).filter(
        (s) => s && !s.isArchived && matchesTargetOrTravelOwner(s, profile)
      );
      const updated = visible.filter(
        (s) => getRecordUpdateMs(s) > seenAt && !isSelfAuthoredGeneric(s, profile)
      );
      if (updated.length > 0) {
        badges.travel = {
          moduleId: 'travel',
          count: updated.length,
          title: 'ट्रॅव्हलिंग (Traveling)',
          message: `${updated.length} ट्रॅव्हलिंग शीट अपडेट झाले`,
          latestAtMs: Math.max(...updated.map(getRecordUpdateMs), 0),
        };
      }
    }
  }

  // 11. LOCATION MAPPING
  if (canAccessModule(profile, 'location')) {
    const seenAt = seenMap.location?.seenAtMs;
    if (seenAt !== undefined) {
      const visibleLocDealers = (input.locationDealers || []).filter(
        (d) =>
          d &&
          !d.isArchived &&
          (userIsAdmin ||
            isUserRecord(d, profile) ||
            String(d.createdByUid || d.userId || '').trim() === String(profile.uid || '').trim())
      );
      const visible = [
        ...(input.locationVillages || []),
        ...(input.locationTalukas || []),
        ...visibleLocDealers,
      ].filter((l) => l && !l.isArchived);
      const updated = visible.filter(
        (l) => getRecordUpdateMs(l) > seenAt && !isSelfAuthoredGeneric(l, profile)
      );
      if (updated.length > 0) {
        badges.location = {
          moduleId: 'location',
          count: updated.length,
          title: 'लोकेशन मॅपिंग (Location)',
          message: `${updated.length} नवीन लोकेशन / डीलर नोंदी अपडेट`,
          latestAtMs: Math.max(...updated.map(getRecordUpdateMs), 0),
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
      badges.setting = {
        moduleId: 'setting',
        count: settingCount,
        title: 'सेटिंग्ज (Setting)',
        message: unseenAppUpdate
          ? 'नवीन ॲप व्हर्जन / सिस्टम अपडेट उपलब्ध आहे'
          : 'ॲप ब्रँडिंग / सेटिंग अपडेट झाले आहे',
        latestAtMs: Math.max(brandingUpdatedAtMs, unseenAppUpdate ? Date.now() : 0),
      };
    }
  }

  const items = Object.values(badges).sort((a, b) => b.latestAtMs - a.latestAtMs);
  const totalCount = items.reduce((sum, item) => sum + item.count, 0);
  const signature = items.map((i) => `${i.moduleId}:${i.count}:${i.latestAtMs}`).join(';');

  return { badges, items, totalCount, signature };
}
