import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, ChevronRight, X } from 'lucide-react';
import { collection, onSnapshot, query } from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile, canAccessModule, isAdmin, isGodownIncharge } from '../lib/auth';
import {
  MODULE_SEEN_EVENT,
  ModuleSeenMap,
  ModuleUpdateBadge,
  RemoteAppUpdateSignal,
  computeModuleUpdates,
  computePricelistFingerprint,
  computeSchemeFingerprint,
  computeSettingFingerprint,
  getDefaultInitialBaselineMs,
  loadModuleSeenMap,
  markModuleAllViewed,
  notifyModuleSeenUpdated,
  saveModuleSeenMap,
} from '../lib/moduleUpdates';
import { useModuleSeenCloudSync } from '../lib/moduleSeenSync';
import {
  useSharedCollectionEntries,
  useSharedDealers,
  useSharedLocationDealers,
  useSharedLocationTalukas,
  useSharedLocationVillages,
  useSharedMasterPricelist,
  useSharedOfficeAttendance,
  useSharedOfficeStaff,
  useSharedOrders,
  useSharedOutstandingRecords,
  useSharedSchemeDiscounts,
  useSharedTargets,
  useSharedTravelSheets,
  useSharedUsers,
  useSharedYearlyTargets,
} from '../lib/realtimeStore';
import { useBranding } from '../lib/branding';
import {
  checkRemoteAppVersion,
  getLatestRemoteVersionInfo,
  APP_BUILD_ID,
} from '../lib/appVersion';
import { isQuotaBlocked, setQuotaBlocked, toTimestampMs } from '../lib/dataService';
import { bootstrapCollectionToSecondary, fetchSecondaryCollection, subscribeSecondaryCollection } from '../lib/secondaryDb';

interface SourceState<T> {
  data: T;
  loaded: boolean;
}

const OrdersSource: React.FC<{ onUpdate: (s: SourceState<any[]>) => void }> = ({ onUpdate }) => {
  const { orders, loaded } = useSharedOrders();
  useEffect(() => {
    onUpdate({ data: orders, loaded });
  }, [orders, loaded, onUpdate]);
  return null;
};

const DealersSource: React.FC<{ onUpdate: (s: SourceState<any[]>) => void }> = ({ onUpdate }) => {
  const { dealers, loaded } = useSharedDealers();
  useEffect(() => {
    onUpdate({ data: dealers, loaded });
  }, [dealers, loaded, onUpdate]);
  return null;
};

const OfficeStaffSource: React.FC<{ onUpdate: (s: SourceState<any[]>) => void }> = ({ onUpdate }) => {
  const { staffMembers, loaded } = useSharedOfficeStaff();
  useEffect(() => {
    onUpdate({ data: staffMembers, loaded });
  }, [staffMembers, loaded, onUpdate]);
  return null;
};

const OfficeAttendanceSource: React.FC<{ onUpdate: (s: SourceState<any[]>) => void }> = ({
  onUpdate,
}) => {
  const { attendanceRecords, loaded } = useSharedOfficeAttendance();
  useEffect(() => {
    onUpdate({ data: attendanceRecords, loaded });
  }, [attendanceRecords, loaded, onUpdate]);
  return null;
};

const PricelistSource: React.FC<{
  onUpdate: (s: { products: any[]; validityDate: string; updatedAtMs: number; loaded: boolean }) => void;
}> = ({ onUpdate }) => {
  const { products, validityDate, updatedAtMs, loaded } = useSharedMasterPricelist();
  useEffect(() => {
    onUpdate({ products, validityDate, updatedAtMs, loaded });
  }, [products, validityDate, updatedAtMs, loaded, onUpdate]);
  return null;
};

const SchemeSource: React.FC<{
  onUpdate: (s: { discounts: Record<string, number>; updatedAtMs: number; loaded: boolean }) => void;
}> = ({ onUpdate }) => {
  const { discounts, updatedAtMs, loaded } = useSharedSchemeDiscounts();
  useEffect(() => {
    onUpdate({ discounts, updatedAtMs, loaded });
  }, [discounts, updatedAtMs, loaded, onUpdate]);
  return null;
};

const CollectionsSource: React.FC<{ onUpdate: (s: SourceState<any[]>) => void }> = ({ onUpdate }) => {
  const { collectionEntries, loaded } = useSharedCollectionEntries();
  useEffect(() => {
    onUpdate({ data: collectionEntries, loaded });
  }, [collectionEntries, loaded, onUpdate]);
  return null;
};

const OutstandingSource: React.FC<{ onUpdate: (s: SourceState<any[]>) => void }> = ({ onUpdate }) => {
  const { outstandingRecords, loaded } = useSharedOutstandingRecords();
  useEffect(() => {
    onUpdate({ data: outstandingRecords, loaded });
  }, [outstandingRecords, loaded, onUpdate]);
  return null;
};

const TargetsSource: React.FC<{
  onUpdate: (s: { yearlyTargets: any[]; monthlyTargets: any[]; loaded: boolean }) => void;
}> = ({ onUpdate }) => {
  const { yearlyTargets, loaded: yLoaded } = useSharedYearlyTargets();
  const { targets, loaded: mLoaded } = useSharedTargets();
  useEffect(() => {
    onUpdate({ yearlyTargets, monthlyTargets: targets, loaded: yLoaded && mLoaded });
  }, [yearlyTargets, targets, yLoaded, mLoaded, onUpdate]);
  return null;
};

const TravelSource: React.FC<{ onUpdate: (s: SourceState<any[]>) => void }> = ({ onUpdate }) => {
  const { travelSheets, loaded } = useSharedTravelSheets();
  useEffect(() => {
    onUpdate({ data: travelSheets, loaded });
  }, [travelSheets, loaded, onUpdate]);
  return null;
};

const LocationSource: React.FC<{
  onUpdate: (s: { villages: any[]; talukas: any[]; locationDealers: any[]; loaded: boolean }) => void;
}> = ({ onUpdate }) => {
  const { locationVillages, loaded: vLoaded } = useSharedLocationVillages();
  const { locationTalukas, loaded: tLoaded } = useSharedLocationTalukas();
  const { locationDealers, loaded: dLoaded } = useSharedLocationDealers();
  useEffect(() => {
    onUpdate({
      villages: locationVillages,
      talukas: locationTalukas,
      locationDealers,
      loaded: vLoaded && tLoaded && dLoaded,
    });
  }, [locationVillages, locationTalukas, locationDealers, vLoaded, tLoaded, dLoaded, onUpdate]);
  return null;
};

const AdminApprovalRequestsSource: React.FC<{ onUpdate: (s: SourceState<any[]>) => void }> = ({
  onUpdate,
}) => {
  useEffect(() => {
    const reqMap = new Map<string, any>();
    let hydrated = false;

    const emit = () => {
      const list = Array.from(reqMap.values())
        .filter((d) => d && d.status === 'pending' && !d.isArchived)
        .sort((a, b) => toTimestampMs(b.createdAt) - toTimestampMs(a.createdAt));
      onUpdate({ data: list, loaded: hydrated });
    };

    const pullSec = () => {
      void fetchSecondaryCollection('user_approval_requests', { limit: 300 }).then((res) => {
        if (!res.ok) return;
        (res.archivedIds || []).forEach((id) => reqMap.delete(id));
        res.items.forEach((it) => {
          if (it?.id) reqMap.set(it.id, it);
        });
        hydrated = true;
        emit();
      });
    };

    const unsubSec = subscribeSecondaryCollection('user_approval_requests', (events) => {
      events.forEach((evt) => {
        if (evt.deleted || evt.doc?.isArchived) reqMap.delete(evt.id);
        else if (evt.doc) reqMap.set(evt.id, { ...evt.doc, id: evt.id });
      });
      hydrated = true;
      emit();
    });

    pullSec();

    let unsub: (() => void) | null = null;
    if (!isQuotaBlocked()) {
      try {
        unsub = onSnapshot(
          query(collection(db, 'user_approval_requests')),
          (snap) => {
            const syncedList: any[] = [];
            snap.forEach((d) => {
              const data = d.data();
              const item = { ...data, id: d.id };
              syncedList.push(item);
              if (data?.isArchived) reqMap.delete(d.id);
              else reqMap.set(d.id, item);
            });
            hydrated = true;
            emit();
            if (!snap.metadata?.fromCache && syncedList.length > 0) {
              bootstrapCollectionToSecondary('user_approval_requests', syncedList);
            }
          },
          (err) => {
            if (unsub) {
              try { unsub(); } catch {}
              unsub = null;
            }
            const msg = String(err?.message || '').toLowerCase();
            if (msg.includes('quota') || msg.includes('resource_exhausted')) {
              setQuotaBlocked(2 * 60 * 1000);
            }
            pullSec();
          }
        );
      } catch {
        unsub = null;
      }
    }

    const onLocalMutation = (e: Event) => {
      const detail = (e as CustomEvent)?.detail;
      if (detail?.collection === 'user_approval_requests' && detail?.id) {
        if (detail.deleted || detail.doc?.isArchived) reqMap.delete(detail.id);
        else if (detail.doc) {
          reqMap.set(detail.id, { ...(reqMap.get(detail.id) || {}), ...detail.doc, id: detail.id });
        }
        emit();
      }
    };
    window.addEventListener('blackworm_local_record_mutation', onLocalMutation);
    window.addEventListener('blackworm_data_refresh', pullSec);
    return () => {
      unsubSec();
      if (unsub) {
        try { unsub(); } catch {}
      }
      window.removeEventListener('blackworm_local_record_mutation', onLocalMutation);
      window.removeEventListener('blackworm_data_refresh', pullSec);
    };
  }, [onUpdate]);

  return null;
};

export interface DashboardModuleUpdateWatcherProps {
  profile: UserProfile;
  activeTab: string;
  onBadgesChange: (badges: Record<string, ModuleUpdateBadge>, items: ModuleUpdateBadge[], signature: string) => void;
}

export const DashboardModuleUpdateWatcher: React.FC<DashboardModuleUpdateWatcherProps> = ({
  profile,
  activeTab,
  onBadgesChange,
}) => {
  const uid = profile?.uid || 'user';
  const userIsAdmin = isAdmin(profile);

  const { users, loaded: usersLoaded } = useSharedUsers();
  const branding = useBranding();

  const [ordersState, setOrdersState] = useState<SourceState<any[]>>({ data: [], loaded: false });
  const [dealersState, setDealersState] = useState<SourceState<any[]>>({ data: [], loaded: false });
  const [staffState, setStaffState] = useState<SourceState<any[]>>({ data: [], loaded: false });
  const [attendanceState, setAttendanceState] = useState<SourceState<any[]>>({ data: [], loaded: false });
  const [pricelistState, setPricelistState] = useState<{
    products: any[];
    validityDate: string;
    updatedAtMs: number;
    loaded: boolean;
  }>({ products: [], validityDate: '', updatedAtMs: 0, loaded: false });
  const [schemeState, setSchemeState] = useState<{
    discounts: Record<string, number>;
    updatedAtMs: number;
    loaded: boolean;
  }>({ discounts: {}, updatedAtMs: 0, loaded: false });
  const [collectionsState, setCollectionsState] = useState<SourceState<any[]>>({ data: [], loaded: false });
  const [outstandingState, setOutstandingState] = useState<SourceState<any[]>>({ data: [], loaded: false });
  const [targetsState, setTargetsState] = useState<{
    yearlyTargets: any[];
    monthlyTargets: any[];
    loaded: boolean;
  }>({ yearlyTargets: [], monthlyTargets: [], loaded: false });
  const [travelState, setTravelState] = useState<SourceState<any[]>>({ data: [], loaded: false });
  const [locationState, setLocationState] = useState<{
    villages: any[];
    talukas: any[];
    locationDealers: any[];
    loaded: boolean;
  }>({ villages: [], talukas: [], locationDealers: [], loaded: false });
  const [approvalReqState, setApprovalReqState] = useState<SourceState<any[]>>({ data: [], loaded: false });
  const [remoteAppVersion, setRemoteAppVersion] = useState<RemoteAppUpdateSignal | null>(() => {
    const info = getLatestRemoteVersionInfo();
    if (!info?.buildId) return null;
    return {
      hasUpdate: info.buildId !== APP_BUILD_ID,
      remoteBuildId: info.buildId,
      version: info.version,
    };
  });

  const { cloudHydrated } = useModuleSeenCloudSync(uid);
  const [seenMap, setSeenMap] = useState<ModuleSeenMap>(() => loadModuleSeenMap(uid));
  const seenMapRef = useRef<ModuleSeenMap>(seenMap);
  const prevTabRef = useRef<string>(activeTab);
  const lastEmittedBadgesSigRef = useRef<string>('__uninitialized__');

  const updateOrdersState = useCallback((next: SourceState<any[]>) => {
    setOrdersState((prev) => (prev.data === next.data && prev.loaded === next.loaded ? prev : next));
  }, []);
  const updateDealersState = useCallback((next: SourceState<any[]>) => {
    setDealersState((prev) => (prev.data === next.data && prev.loaded === next.loaded ? prev : next));
  }, []);
  const updateStaffState = useCallback((next: SourceState<any[]>) => {
    setStaffState((prev) => (prev.data === next.data && prev.loaded === next.loaded ? prev : next));
  }, []);
  const updateAttendanceState = useCallback((next: SourceState<any[]>) => {
    setAttendanceState((prev) => (prev.data === next.data && prev.loaded === next.loaded ? prev : next));
  }, []);
  const updatePricelistState = useCallback(
    (next: { products: any[]; validityDate: string; updatedAtMs: number; loaded: boolean }) => {
      setPricelistState((prev) =>
        prev.products === next.products &&
        prev.validityDate === next.validityDate &&
        prev.updatedAtMs === next.updatedAtMs &&
        prev.loaded === next.loaded
          ? prev
          : next
      );
    },
    []
  );
  const updateSchemeState = useCallback(
    (next: { discounts: Record<string, number>; updatedAtMs: number; loaded: boolean }) => {
      setSchemeState((prev) =>
        prev.discounts === next.discounts &&
        prev.updatedAtMs === next.updatedAtMs &&
        prev.loaded === next.loaded
          ? prev
          : next
      );
    },
    []
  );
  const updateCollectionsState = useCallback((next: SourceState<any[]>) => {
    setCollectionsState((prev) => (prev.data === next.data && prev.loaded === next.loaded ? prev : next));
  }, []);
  const updateOutstandingState = useCallback((next: SourceState<any[]>) => {
    setOutstandingState((prev) => (prev.data === next.data && prev.loaded === next.loaded ? prev : next));
  }, []);
  const updateTargetsState = useCallback(
    (next: { yearlyTargets: any[]; monthlyTargets: any[]; loaded: boolean }) => {
      setTargetsState((prev) =>
        prev.yearlyTargets === next.yearlyTargets &&
        prev.monthlyTargets === next.monthlyTargets &&
        prev.loaded === next.loaded
          ? prev
          : next
      );
    },
    []
  );
  const updateTravelState = useCallback((next: SourceState<any[]>) => {
    setTravelState((prev) => (prev.data === next.data && prev.loaded === next.loaded ? prev : next));
  }, []);
  const updateLocationState = useCallback(
    (next: { villages: any[]; talukas: any[]; locationDealers: any[]; loaded: boolean }) => {
      setLocationState((prev) =>
        prev.villages === next.villages &&
        prev.talukas === next.talukas &&
        prev.locationDealers === next.locationDealers &&
        prev.loaded === next.loaded
          ? prev
          : next
      );
    },
    []
  );
  const updateApprovalReqState = useCallback((next: SourceState<any[]>) => {
    setApprovalReqState((prev) => {
      if (prev.loaded === next.loaded && prev.data.length === next.data.length) {
        try {
          if (JSON.stringify(prev.data) === JSON.stringify(next.data)) return prev;
        } catch {}
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const next = loadModuleSeenMap(uid);
    try {
      if (JSON.stringify(seenMapRef.current) === JSON.stringify(next)) return;
    } catch {}
    seenMapRef.current = next;
    setSeenMap(next);
  }, [uid]);

  useEffect(() => {
    const syncSeenMap = () => {
      const next = loadModuleSeenMap(uid);
      try {
        if (JSON.stringify(seenMapRef.current) === JSON.stringify(next)) return;
      } catch {}
      seenMapRef.current = next;
      setSeenMap(next);
    };
    window.addEventListener(MODULE_SEEN_EVENT, syncSeenMap);
    window.addEventListener('storage', syncSeenMap);
    return () => {
      window.removeEventListener(MODULE_SEEN_EVENT, syncSeenMap);
      window.removeEventListener('storage', syncSeenMap);
    };
  }, [uid]);

  // Periodically check remote app version non-destructively for Setting update badge
  useEffect(() => {
    if (!canAccessModule(profile, 'setting')) return;
    let cancelled = false;
    const syncRemoteVer = async () => {
      try {
        const res = await checkRemoteAppVersion({ forceReloadOnUpdate: false });
        if (!cancelled && res.checked) {
          setRemoteAppVersion((prev) => {
            if (
              prev &&
              prev.hasUpdate === res.hasUpdate &&
              prev.remoteBuildId === res.remoteBuildId &&
              prev.version === res.remote?.version
            ) {
              return prev;
            }
            return {
              hasUpdate: res.hasUpdate,
              remoteBuildId: res.remoteBuildId,
              version: res.remote?.version,
            };
          });
        }
      } catch {}
    };
    void syncRemoteVer();
    const timer = window.setInterval(syncRemoteVer, 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [profile]);

  const canOrder = canAccessModule(profile, 'order');
  const canDealer = canAccessModule(profile, 'dealer');
  const canWarehouse = canAccessModule(profile, 'office_staff');
  const canPrice = canAccessModule(profile, 'price');
  const canScheme = canAccessModule(profile, 'scheme');
  const canCollection = canAccessModule(profile, 'collection');
  const canOutstanding = canAccessModule(profile, 'calculator');
  const canTarget = canAccessModule(profile, 'target');
  const canTravel = canAccessModule(profile, 'travel');
  const canLocation = canAccessModule(profile, 'location');
  const canSetting = canAccessModule(profile, 'setting');

  const getCurrentModuleFingerprint = useCallback(
    (moduleId: string): string | undefined => {
      if (moduleId === 'price') {
        return computePricelistFingerprint(
          pricelistState.products,
          pricelistState.validityDate,
          pricelistState.updatedAtMs
        );
      }
      if (moduleId === 'scheme') {
        return computeSchemeFingerprint(schemeState.discounts, schemeState.updatedAtMs);
      }
      if (moduleId === 'setting') {
        return computeSettingFingerprint(remoteAppVersion, branding.updatedAtMs || 0);
      }
      return undefined;
    },
    [
      pricelistState.products,
      pricelistState.validityDate,
      pricelistState.updatedAtMs,
      schemeState.discounts,
      schemeState.updatedAtMs,
      remoteAppVersion,
      branding.updatedAtMs,
    ]
  );

  // Initialize one-time baseline ONLY AFTER cloud seen-state has hydrated on a fresh device
  useEffect(() => {
    if (!cloudHydrated) return;
    const prev = seenMapRef.current;
    let changed = false;
    const next: ModuleSeenMap = { ...prev };
    const now = Date.now();

    const ensureBaseline = (
      modId: string,
      isLoaded: boolean,
      keepPendingVisible = false,
      baselineTs = now
    ) => {
      if (!isLoaded || next[modId] !== undefined || keepPendingVisible) return;
      next[modId] = {
        seenAtMs: baselineTs,
        fingerprint: getCurrentModuleFingerprint(modId),
      };
      changed = true;
    };
    const recentLookbackMs = getDefaultInitialBaselineMs(now);

    const hasAdminPendingOrders =
      userIsAdmin &&
      ordersState.data.some((o) => {
        const st = String(o?.status || '').toLowerCase();
        return !o?.isArchived && (st === 'pending' || st === 'pending_approval');
      });

    const hasInchargeFreshOrders =
      isGodownIncharge(profile) &&
      ordersState.data.some((o) => {
        const st = String(o?.status || '').toLowerCase();
        const wh = String(o?.warehouseStatus || 'fresh').toLowerCase();
        const isApprovedOrder =
          st === 'complete' ||
          st === 'approved' ||
          st === 'dispatched' ||
          st === 'delivered' ||
          st === 'collected' ||
          st === 'confirmed';
        return !o?.isArchived && isApprovedOrder && wh === 'fresh';
      });

    const hasAdminPendingReqs =
      userIsAdmin && approvalReqState.data.some((r) => r && !r.isArchived && r.status === 'pending');

    ensureBaseline('order', ordersState.loaded, hasAdminPendingOrders, recentLookbackMs);
    ensureBaseline('dealer', dealersState.loaded, false, recentLookbackMs);
    ensureBaseline('user', usersLoaded && (!userIsAdmin || approvalReqState.loaded), hasAdminPendingReqs, recentLookbackMs);
    ensureBaseline(
      'office_staff',
      staffState.loaded && attendanceState.loaded && ordersState.loaded,
      hasInchargeFreshOrders,
      recentLookbackMs
    );
    ensureBaseline('price', pricelistState.loaded && pricelistState.products.length > 0, false, now);
    ensureBaseline('scheme', schemeState.loaded, false, now);
    ensureBaseline('collection', collectionsState.loaded, false, recentLookbackMs);
    ensureBaseline('calculator', outstandingState.loaded, false, recentLookbackMs);
    ensureBaseline('target', targetsState.loaded, false, recentLookbackMs);
    ensureBaseline('travel', travelState.loaded, false, recentLookbackMs);
    ensureBaseline('location', locationState.loaded, false, recentLookbackMs);
    ensureBaseline('setting', true, Boolean(remoteAppVersion?.hasUpdate), now);

    if (changed) {
      saveModuleSeenMap(uid, next);
      seenMapRef.current = next;
      setSeenMap(next);
      notifyModuleSeenUpdated(uid, '_baseline', 'local');
    }
  }, [
    cloudHydrated,
    uid,
    profile,
    userIsAdmin,
    ordersState.loaded,
    ordersState.data,
    dealersState.loaded,
    usersLoaded,
    approvalReqState.loaded,
    approvalReqState.data,
    staffState.loaded,
    attendanceState.loaded,
    pricelistState.loaded,
    pricelistState.products.length,
    schemeState.loaded,
    collectionsState.loaded,
    outstandingState.loaded,
    targetsState.loaded,
    travelState.loaded,
    locationState.loaded,
    remoteAppVersion?.hasUpdate,
    getCurrentModuleFingerprint,
  ]);

  const computed = useMemo(() => {
    if (!cloudHydrated && Object.keys(seenMap).length === 0) {
      return { badges: {}, items: [], totalCount: 0, signature: '' };
    }
    return computeModuleUpdates({
      profile,
      seenMap,
      orders: canOrder || canWarehouse ? ordersState.data : [],
      dealers: canDealer ? dealersState.data : [],
      users,
      userApprovalRequests: userIsAdmin ? approvalReqState.data : [],
      officeStaff: canWarehouse ? staffState.data : [],
      officeAttendance: canWarehouse ? attendanceState.data : [],
      pricelist: canPrice ? pricelistState : undefined,
      schemeDiscounts: canScheme ? schemeState : undefined,
      collections: canCollection ? collectionsState.data : [],
      outstandingRecords: canOutstanding ? outstandingState.data : [],
      yearlyTargets: canTarget ? targetsState.yearlyTargets : [],
      monthlyTargets: canTarget ? targetsState.monthlyTargets : [],
      travelSheets: canTravel ? travelState.data : [],
      locationVillages: canLocation ? locationState.villages : [],
      locationTalukas: canLocation ? locationState.talukas : [],
      locationDealers: canLocation ? locationState.locationDealers : [],
      branding: canSetting ? branding : undefined,
      remoteAppVersion: canSetting ? remoteAppVersion : null,
    });
  }, [
    cloudHydrated,
    profile,
    seenMap,
    canOrder,
    canWarehouse,
    canDealer,
    canPrice,
    canScheme,
    canCollection,
    canOutstanding,
    canTarget,
    canTravel,
    canLocation,
    canSetting,
    userIsAdmin,
    ordersState.data,
    dealersState.data,
    users,
    approvalReqState.data,
    staffState.data,
    attendanceState.data,
    pricelistState.products,
    pricelistState.validityDate,
    pricelistState.updatedAtMs,
    pricelistState.loaded,
    schemeState.discounts,
    schemeState.updatedAtMs,
    schemeState.loaded,
    collectionsState.data,
    outstandingState.data,
    targetsState.yearlyTargets,
    targetsState.monthlyTargets,
    travelState.data,
    locationState.villages,
    locationState.talukas,
    locationState.locationDealers,
    branding.logoUrl,
    branding.logoSize,
    branding.updatedAtMs,
    remoteAppVersion?.hasUpdate,
    remoteAppVersion?.remoteBuildId,
    remoteAppVersion?.version,
  ]);

  // Auto-mark singleton/non-row modules (target, price, scheme, setting) viewed shortly after opening
  // AND when leaving the tab, syncing cleanly across all devices without needing a "सर्व पाहिले" banner.
  useEffect(() => {
    const SINGLETON_AUTO_MARK_ALL = new Set(['target', 'price', 'scheme', 'setting']);
    const prevTab = prevTabRef.current;
    prevTabRef.current = activeTab;

    if (prevTab && prevTab !== activeTab && SINGLETON_AUTO_MARK_ALL.has(prevTab) && cloudHydrated) {
      markModuleAllViewed(uid, prevTab, getCurrentModuleFingerprint(prevTab));
    }
  }, [activeTab, uid, cloudHydrated, getCurrentModuleFingerprint]);

  const activeSingletonBadgeLatestMs = computed.badges[activeTab]?.latestAtMs || 0;
  const activeSingletonBadgeCount = computed.badges[activeTab]?.count || 0;
  useEffect(() => {
    const SINGLETON_AUTO_MARK_ALL = new Set(['target', 'price', 'scheme', 'setting']);
    if (!cloudHydrated || !SINGLETON_AUTO_MARK_ALL.has(activeTab) || activeSingletonBadgeCount <= 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      markModuleAllViewed(
        uid,
        activeTab,
        getCurrentModuleFingerprint(activeTab),
        activeSingletonBadgeLatestMs
      );
    }, 800);
    return () => window.clearTimeout(timer);
  }, [
    activeTab,
    activeSingletonBadgeCount,
    activeSingletonBadgeLatestMs,
    cloudHydrated,
    uid,
    getCurrentModuleFingerprint,
  ]);


  useEffect(() => {
    if (lastEmittedBadgesSigRef.current === computed.signature) return;
    lastEmittedBadgesSigRef.current = computed.signature;
    onBadgesChange(computed.badges, computed.items, computed.signature);
  }, [computed.badges, computed.items, computed.signature, onBadgesChange]);

  return (
    <>
      {(canOrder || canWarehouse) && <OrdersSource onUpdate={updateOrdersState} />}
      {canDealer && <DealersSource onUpdate={updateDealersState} />}
      {userIsAdmin && <AdminApprovalRequestsSource onUpdate={updateApprovalReqState} />}
      {canWarehouse && (
        <>
          <OfficeStaffSource onUpdate={updateStaffState} />
          <OfficeAttendanceSource onUpdate={updateAttendanceState} />
        </>
      )}
      {canPrice && <PricelistSource onUpdate={updatePricelistState} />}
      {canScheme && <SchemeSource onUpdate={updateSchemeState} />}
      {canCollection && <CollectionsSource onUpdate={updateCollectionsState} />}
      {canOutstanding && <OutstandingSource onUpdate={updateOutstandingState} />}
      {canTarget && <TargetsSource onUpdate={updateTargetsState} />}
      {canTravel && <TravelSource onUpdate={updateTravelState} />}
      {canLocation && <LocationSource onUpdate={updateLocationState} />}
    </>
  );
};

interface ModuleUpdatePopupProps {
  isOpen: boolean;
  items: ModuleUpdateBadge[];
  onClose: () => void;
  onOpenModule: (moduleId: string) => void;
}

export const ModuleUpdatePopup: React.FC<ModuleUpdatePopupProps> = ({
  isOpen,
  items,
  onClose,
  onOpenModule,
}) => {
  if (!isOpen || items.length === 0) return null;

  const totalCount = items.reduce((sum, item) => sum + item.count, 0);

  return (
    <div
      className="fixed bottom-20 right-3 left-3 sm:left-auto sm:right-5 sm:w-96 z-40 animate-in fade-in slide-in-from-bottom-4 duration-200 no-print"
      role="status"
      aria-live="polite"
    >
      <div className="bg-white rounded-2xl shadow-2xl border-2 border-indigo-200 overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-600 to-blue-600 px-4 py-3 text-white flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
              <BellRing className="w-4 h-4 text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-black tracking-tight truncate">
                नवीन अपडेट्स ({totalCount})
              </p>
              <p className="text-[10px] font-semibold text-indigo-100 truncate">
                संबंधित ऑप्शन पाहण्यासाठी टॅप करा
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white transition cursor-pointer shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-2.5 space-y-1.5 max-h-[42vh] overflow-y-auto bg-slate-50/70">
          {items.map((item) => (
            <button
              key={item.moduleId}
              type="button"
              onClick={() => onOpenModule(item.moduleId)}
              className="w-full text-left bg-white hover:bg-indigo-50/60 border border-slate-200 hover:border-indigo-300 rounded-xl px-3 py-2 flex items-center justify-between gap-2.5 transition active:scale-[0.99] cursor-pointer"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black text-slate-900 truncate">{item.title}</span>
                  <span className="px-1.5 py-0.5 rounded-full bg-rose-600 text-white text-[10px] font-black leading-none shrink-0">
                    {item.count > 99 ? '99+' : item.count}
                  </span>
                </div>
                <p className="text-[11px] font-semibold text-slate-600 truncate mt-0.5">
                  {item.message}
                </p>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
            </button>
          ))}
        </div>

        <div className="px-3 py-2 bg-white border-t border-slate-100 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-black transition cursor-pointer"
          >
            बंद करा (Close)
          </button>
        </div>
      </div>
    </div>
  );
};
