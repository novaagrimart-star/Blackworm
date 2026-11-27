import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { UserProfile } from '../lib/auth';
import {
  ComputeModuleUpdatesInput,
  MODULE_SEEN_EVENT,
  ModuleSeenMap,
  ModuleUpdateBadge,
  UnreadRecordMeta,
  computeModuleUpdates,
  loadModuleSeenMap,
  markModuleAllViewed,
  markModuleRecordsViewed,
  markRecordUpdateViewed,
} from '../lib/moduleUpdates';
import { useModuleSeenCloudSync } from '../lib/moduleSeenSync';

export function useModuleRecordHighlights(
  profile: Partial<UserProfile> | null | undefined,
  moduleId: string,
  partialInput: Omit<ComputeModuleUpdatesInput, 'profile' | 'seenMap'>
) {
  const uid = String(profile?.uid || 'user');
  const { cloudHydrated } = useModuleSeenCloudSync(uid);
  const [seenMap, setSeenMap] = useState<ModuleSeenMap>(() => loadModuleSeenMap(uid));

  useEffect(() => {
    const next = loadModuleSeenMap(uid);
    setSeenMap((prev) => {
      try {
        if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
      } catch {}
      return next;
    });
  }, [uid]);

  useEffect(() => {
    const refreshSeen = () => {
      const next = loadModuleSeenMap(uid);
      setSeenMap((prev) => {
        try {
          if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
        } catch {}
        return next;
      });
    };
    window.addEventListener(MODULE_SEEN_EVENT, refreshSeen);
    window.addEventListener('storage', refreshSeen);
    return () => {
      window.removeEventListener(MODULE_SEEN_EVENT, refreshSeen);
      window.removeEventListener('storage', refreshSeen);
    };
  }, [uid]);

  const {
    orders,
    dealers,
    users,
    userApprovalRequests,
    officeStaff,
    officeAttendance,
    pricelist,
    schemeDiscounts,
    collections,
    outstandingRecords,
    yearlyTargets,
    monthlyTargets,
    travelSheets,
    locationVillages,
    locationTalukas,
    locationDealers,
    branding,
    remoteAppVersion,
  } = partialInput;

  const badge = useMemo<ModuleUpdateBadge | undefined>(() => {
    if (!cloudHydrated && Object.keys(seenMap).length === 0) {
      return undefined;
    }
    const res = computeModuleUpdates({
      profile,
      seenMap,
      orders,
      dealers,
      users,
      userApprovalRequests,
      officeStaff,
      officeAttendance,
      pricelist,
      schemeDiscounts,
      collections,
      outstandingRecords,
      yearlyTargets,
      monthlyTargets,
      travelSheets,
      locationVillages,
      locationTalukas,
      locationDealers,
      branding,
      remoteAppVersion,
    });
    return res.badges[moduleId];
  }, [
    cloudHydrated,
    profile,
    seenMap,
    moduleId,
    orders,
    dealers,
    users,
    userApprovalRequests,
    officeStaff,
    officeAttendance,
    pricelist?.products,
    pricelist?.validityDate,
    pricelist?.updatedAtMs,
    pricelist?.loaded,
    schemeDiscounts?.discounts,
    schemeDiscounts?.updatedAtMs,
    schemeDiscounts?.loaded,
    collections,
    outstandingRecords,
    yearlyTargets,
    monthlyTargets,
    travelSheets,
    locationVillages,
    locationTalukas,
    locationDealers,
    branding?.logoUrl,
    branding?.logoSize,
    branding?.updatedAtMs,
    remoteAppVersion?.hasUpdate,
    remoteAppVersion?.remoteBuildId,
    remoteAppVersion?.version,
  ]);

  const unreadById = useMemo(() => {
    const map = new Map<string, UnreadRecordMeta>();
    (badge?.unreadRecords || []).forEach((rec) => {
      map.set(rec.id, rec);
    });
    return map;
  }, [badge]);

  const getUnreadMeta = useCallback(
    (recordId?: string | null): UnreadRecordMeta | undefined => {
      if (!recordId) return undefined;
      return unreadById.get(String(recordId));
    },
    [unreadById]
  );

  const markViewed = useCallback(
    (recordId?: string | null, recordTs?: number) => {
      if (!recordId) return;
      markRecordUpdateViewed(uid, moduleId, String(recordId), recordTs);
    },
    [uid, moduleId]
  );

  const markManyViewed = useCallback(
    (items: Array<{ id: string; ts?: number }>) => {
      if (!items || items.length === 0) return;
      markModuleRecordsViewed(uid, moduleId, items);
    },
    [uid, moduleId]
  );

  const markAllViewed = useCallback(
    (fingerprint?: string) => {
      markModuleAllViewed(uid, moduleId, fingerprint);
    },
    [uid, moduleId]
  );

  return {
    badge,
    unreadRecords: badge?.unreadRecords || [],
    unreadCount: badge?.count || 0,
    unreadById,
    getUnreadMeta,
    markViewed,
    markManyViewed,
    markAllViewed,
  };
}

interface ModuleUpdateBannerProps {
  badge?: ModuleUpdateBadge;
  onMarkAllViewed: () => void;
  onSelectRecord?: (item: UnreadRecordMeta) => void;
  onMarkSingleViewed?: (item: UnreadRecordMeta) => void;
  className?: string;
}

// Banner box suppressed; per-row highlighting & numbered dashboard badges remain active and synced across devices.
export const ModuleUpdateBanner: React.FC<ModuleUpdateBannerProps> = () => null;
