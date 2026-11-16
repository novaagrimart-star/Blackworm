import React, { useState, useMemo, useEffect } from 'react';
import {
  MapPin,
  Search,
  Plus,
  Users,
  Phone,
  ChevronRight,
  X,
  CheckCircle2,
  Trash2,
  ExternalLink,
  Layers,
  Filter,
  Loader2,
  Save,
  Hash,
} from 'lucide-react';
import { UserProfile, isAdmin } from '../../lib/auth';
import { Language } from '../../lib/i18n';
import { toTitleCase } from '../../lib/utils';
import { safeFirestoreSet, safeFirestoreDelete, logAudit } from '../../lib/dataService';
import {
  getLocationTalukaDocId,
  useSharedDealers,
  useSharedLocationTalukas,
  useSharedLocationVillages,
  useSharedUsers,
} from '../../lib/realtimeStore';
import {
  DEFAULT_STATE,
  LGD_STATES,
  LocationTalukaItem,
  LocationVillageItem,
  canonicalizeDistrictName,
  canonicalizeTalukaName,
  getDistrictDisplayLabel,
  getDistrictMeta,
  getDistrictsForState,
  getLocationVillageDocId,
  getStateMeta,
  getTalukaMeta,
  getTalukaMetasForDistrict,
  inferTalukaFromLocation,
  normalizeLocationKey,
  normalizeStateName,
  resolveStateFromDistrict,
} from '../../lib/maharashtraLocations';
import {
  OfficialLgdVillage,
  findOfficialLgdVillageSync,
  getOfficialDistrictVillageCountSync,
  getOfficialTalukaVillageCountSync,
  getOfficialVillagesByTalukaSync,
  getOfficialVillagesFilteredSync,
  isLgdStateCachedInMemory,
  loadLgdStateVillages,
} from '../../lib/lgdCache';
import { CustomDialogModal } from '../CustomDialogModal';

interface Props {
  profile: UserProfile;
  lang: Language;
  onOpenDealer?: (dealerId: string) => void;
}

interface VillageRow {
  id: string;
  villageCode: string;
  village: string;
  talukaCode: string;
  taluka: string;
  districtCode: string;
  district: string;
  stateCode: string;
  state: string;
  pinCode: string;
  isOfficialLgd: boolean;
  isCustomSaved: boolean;
  createdByUid?: string;
  dealers: any[];
}

const PAGE_STEP = 60;

export const LocationView: React.FC<Props> = ({ profile, onOpenDealer }) => {
  const { dealers } = useSharedDealers();
  const { locationVillages, setLocationVillagesOptimistic } = useSharedLocationVillages();
  const { locationTalukas, setLocationTalukasOptimistic } = useSharedLocationTalukas();
  const { usersMap } = useSharedUsers();

  const userIsAdmin = isAdmin(profile);

  const [selectedState, setSelectedState] = useState<string>(DEFAULT_STATE); // 'Maharashtra' | 'Karnataka' | 'all'
  const [selectedDistrict, setSelectedDistrict] = useState<string>('all');
  const [selectedTaluka, setSelectedTaluka] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [onlyWithDealers, setOnlyWithDealers] = useState<boolean>(false);
  const [visibleLimit, setVisibleLimit] = useState<number>(PAGE_STEP);

  // One-time LGD IndexedDB cache load state
  const [lgdRevision, setLgdRevision] = useState<number>(0);
  const [loadingLgd, setLoadingLgd] = useState<boolean>(
    () => !isLgdStateCachedInMemory('27') || !isLgdStateCachedInMemory('29')
  );

  // Admin Add Village Modal state
  const [showAddVillageModal, setShowAddVillageModal] = useState<boolean>(false);
  const [modalState, setModalState] = useState<string>(DEFAULT_STATE);
  const [newDistrict, setNewDistrict] = useState<string>('Sangli');
  const [newTaluka, setNewTaluka] = useState<string>('');
  const [newVillageName, setNewVillageName] = useState<string>('');
  const [newVillageCode, setNewVillageCode] = useState<string>('');
  const [newPinCode, setNewPinCode] = useState<string>('');
  const [isSavingVillage, setIsSavingVillage] = useState<boolean>(false);

  // Admin Add Taluka Modal state
  const [showAddTalukaModal, setShowAddTalukaModal] = useState<boolean>(false);
  const [talukaModalState, setTalukaModalState] = useState<string>(DEFAULT_STATE);
  const [talukaModalDistrict, setTalukaModalDistrict] = useState<string>('Sangli');
  const [newTalukaName, setNewTalukaName] = useState<string>('');
  const [newTalukaCode, setNewTalukaCode] = useState<string>('');
  const [isSavingTaluka, setIsSavingTaluka] = useState<boolean>(false);

  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [dialogConfig, setDialogConfig] = useState<{
    isOpen: boolean;
    type?: 'confirm' | 'alert' | 'success';
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm: () => void;
    onCancel?: () => void;
  }>({
    isOpen: false,
    message: '',
    onConfirm: () => {},
  });

  // Load MH (27) and KA (29) Official LGD data once into IndexedDB + Memory
  useEffect(() => {
    let active = true;
    const initCache = async () => {
      try {
        await Promise.all([loadLgdStateVillages('27'), loadLgdStateVillages('29')]);
      } finally {
        if (active) {
          setLoadingLgd(false);
          setLgdRevision((r) => r + 1);
        }
      }
    };
    void initCache();
    return () => {
      active = false;
    };
  }, []);

  // Reset pagination whenever filters change
  useEffect(() => {
    setVisibleLimit(PAGE_STEP);
  }, [selectedState, selectedDistrict, selectedTaluka, searchQuery, onlyWithDealers]);

  const selectedStateMeta = useMemo(
    () => (selectedState === 'all' ? undefined : getStateMeta(selectedState)),
    [selectedState]
  );

  // Index Dealers cleanly onto official LGD villages, custom villages, or fallback unmapped buckets
  const dealerMappingIndex = useMemo(() => {
    const dealersByVillageKey = new Map<string, any[]>(); // `${stateCode}|${districtCode||districtNorm}|${talukaCode||talukaNorm}|${villageNorm}` OR `code:${villageCode}`
    const unmappedBuckets = new Map<string, VillageRow>();
    const dealerCountByStateCode = new Map<string, number>();
    const dealerCountByDistrictKey = new Map<string, number>();
    const dealerCountByTalukaKey = new Map<string, number>();

    // Helper lookup for custom saved villages (for dealers missing explicit taluka)
    const customTalukaLookup = new Map<string, { taluka: string; talukaCode?: string; villageCode?: string }>();
    locationVillages.forEach((lv) => {
      if (!lv || lv.isArchived) return;
      const sMeta = getStateMeta(lv.stateCode || lv.state || DEFAULT_STATE);
      const dMeta = getDistrictMeta(lv.districtCode || lv.district, sMeta?.code);
      const distName = dMeta?.name || canonicalizeDistrictName(lv.district, sMeta?.name);
      const talName = canonicalizeTalukaName(distName, lv.taluka, sMeta?.name) || lv.taluka;
      if (distName && lv.village && talName && talName !== 'Other') {
        customTalukaLookup.set(`${normalizeLocationKey(distName)}|${normalizeLocationKey(lv.village)}`, {
          taluka: talName,
          talukaCode: lv.talukaCode,
          villageCode: lv.villageCode,
        });
      }
    });

    const addDealerToKey = (key: string, d: any) => {
      const arr = dealersByVillageKey.get(key);
      if (arr) {
        arr.push(d);
      } else {
        dealersByVillageKey.set(key, [d]);
      }
    };

    const sortDealers = (list: any[]) =>
      list.sort((a, b) => {
        const numA = parseInt(String(a.dealerCode || '').replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(String(b.dealerCode || '').replace(/\D/g, ''), 10) || 0;
        if (numA !== numB) return numB - numA;
        return String(a.firmName || '').localeCompare(String(b.firmName || ''));
      });

    dealers.forEach((d) => {
      if (!d || d.isArchived) return;

      const guessedState =
        d.stateLgdCode ||
        d.state ||
        resolveStateFromDistrict(d.district) ||
        DEFAULT_STATE;
      const stMeta = getStateMeta(guessedState);
      const stCode = stMeta?.code || normalizeLocationKey(guessedState);
      const stName = stMeta?.name || normalizeStateName(guessedState);

      const dMeta = getDistrictMeta(d.districtLgdCode || d.district, stMeta?.code);
      const dName = dMeta?.name || canonicalizeDistrictName(d.district || '', stName) || 'Unmapped District';
      const dCode = dMeta?.code || normalizeLocationKey(dName);

      const rawVillage = String(d.village || d.center || '').trim();
      if (!rawVillage && dName === 'Unmapped District') return;
      const villageLabel = rawVillage || 'Other';

      const distVilKey = `${normalizeLocationKey(dName)}|${normalizeLocationKey(villageLabel)}`;
      const customMatch = customTalukaLookup.get(distVilKey);

      const tMeta = getTalukaMeta(
        dMeta?.code || dName,
        d.talukaLgdCode ||
          d.taluka ||
          customMatch?.taluka ||
          inferTalukaFromLocation(dName, villageLabel, d.center, stName),
        stMeta?.code
      );
      const resolvedTalukaName =
        tMeta?.name ||
        canonicalizeTalukaName(dName, d.taluka || '', stName) ||
        customMatch?.taluka ||
        inferTalukaFromLocation(dName, villageLabel, d.center, stName) ||
        'Other / Unmapped Taluka';
      const tCode = tMeta?.code || d.talukaLgdCode || normalizeLocationKey(resolvedTalukaName);

      // Count metrics
      dealerCountByStateCode.set(stCode, (dealerCountByStateCode.get(stCode) || 0) + 1);
      const distMetricKey = `${stCode}|${normalizeLocationKey(dName)}`;
      dealerCountByDistrictKey.set(distMetricKey, (dealerCountByDistrictKey.get(distMetricKey) || 0) + 1);
      const talMetricKey = `${distMetricKey}|${normalizeLocationKey(resolvedTalukaName)}`;
      dealerCountByTalukaKey.set(talMetricKey, (dealerCountByTalukaKey.get(talMetricKey) || 0) + 1);

      // Try matching to Official LGD Village Master
      const officialHit = findOfficialLgdVillageSync({
        stateCode: stMeta?.code,
        talukaCode: tMeta?.code,
        villageCode: d.villageLgdCode,
        villageName: villageLabel,
      });

      if (officialHit) {
        addDealerToKey(`code:${officialHit.villageCode}`, d);
        return;
      }

      // Check custom saved village match
      const customKey = `${stCode}|${normalizeLocationKey(dName)}|${normalizeLocationKey(resolvedTalukaName)}|${normalizeLocationKey(villageLabel)}`;
      const isSavedCustom = locationVillages.some(
        (lv) =>
          !lv.isArchived &&
          ((d.villageLgdCode && lv.villageCode === d.villageLgdCode) ||
            `${normalizeLocationKey(lv.state)}|${normalizeLocationKey(lv.district)}|${normalizeLocationKey(lv.taluka)}|${normalizeLocationKey(lv.village)}` ===
              `${normalizeLocationKey(stName)}|${normalizeLocationKey(dName)}|${normalizeLocationKey(resolvedTalukaName)}|${normalizeLocationKey(villageLabel)}`)
      );

      if (isSavedCustom) {
        addDealerToKey(customKey, d);
        return;
      }

      // Legacy or non-LGD spelling fallback bucket
      let bucket = unmappedBuckets.get(customKey);
      if (!bucket) {
        bucket = {
          id: getLocationVillageDocId(stName, dName, resolvedTalukaName, villageLabel, d.villageLgdCode),
          villageCode: d.villageLgdCode || '',
          village: villageLabel,
          talukaCode: tMeta?.code || d.talukaLgdCode || '',
          taluka: resolvedTalukaName,
          districtCode: dMeta?.code || '',
          district: dName,
          stateCode: stMeta?.code || '',
          state: stName,
          pinCode: String(d.pinCode || '').trim(),
          isOfficialLgd: false,
          isCustomSaved: false,
          dealers: [],
        };
        unmappedBuckets.set(customKey, bucket);
      }
      bucket.dealers.push(d);
      if (!bucket.pinCode && d.pinCode) bucket.pinCode = String(d.pinCode).trim();
    });

    dealersByVillageKey.forEach((arr) => sortDealers(arr));
    unmappedBuckets.forEach((b) => sortDealers(b.dealers));

    return {
      dealersByVillageKey,
      unmappedBuckets: Array.from(unmappedBuckets.values()),
      dealerCountByStateCode,
      dealerCountByDistrictKey,
      dealerCountByTalukaKey,
    };
  }, [dealers, locationVillages, lgdRevision]);

  // Helper to get combined custom villages filtered to current state
  const customVillageRows = useMemo(() => {
    const seen = new Map<string, VillageRow>();
    locationVillages.forEach((lv) => {
      if (!lv || lv.isArchived) return;
      const stMeta = getStateMeta(lv.stateCode || lv.state || DEFAULT_STATE);
      const stCode = stMeta?.code || '';
      const stName = stMeta?.name || normalizeStateName(lv.state || DEFAULT_STATE);

      const dMeta = getDistrictMeta(lv.districtCode || lv.district, stMeta?.code);
      const dName = dMeta?.name || canonicalizeDistrictName(lv.district, stName);
      const tMeta = getTalukaMeta(dMeta?.code || dName, lv.talukaCode || lv.taluka, stMeta?.code);
      const tName = tMeta?.name || canonicalizeTalukaName(dName, lv.taluka, stName) || lv.taluka || 'Other';

      // If it exists in official LGD master, do not duplicate it here
      const officialHit = findOfficialLgdVillageSync({
        stateCode: stMeta?.code,
        talukaCode: tMeta?.code,
        villageCode: lv.villageCode,
        villageName: lv.village,
      });
      if (officialHit) return;

      const customKey = `${stCode || normalizeLocationKey(stName)}|${normalizeLocationKey(dName)}|${normalizeLocationKey(tName)}|${normalizeLocationKey(lv.village)}`;
      const linkedDealers =
        dealerMappingIndex.dealersByVillageKey.get(customKey) ||
        (lv.villageCode ? dealerMappingIndex.dealersByVillageKey.get(`code:${lv.villageCode}`) : undefined) ||
        [];

      seen.set(customKey, {
        id: lv.id,
        villageCode: lv.villageCode || '',
        village: lv.village,
        talukaCode: tMeta?.code || lv.talukaCode || '',
        taluka: tName,
        districtCode: dMeta?.code || lv.districtCode || '',
        district: dName,
        stateCode: stCode,
        state: stName,
        pinCode: String(lv.pinCode || '').trim(),
        isOfficialLgd: false,
        isCustomSaved: true,
        createdByUid: lv.createdByUid,
        dealers: linkedDealers,
      });
    });
    return Array.from(seen.values());
  }, [locationVillages, dealerMappingIndex, lgdRevision]);

  // District summaries for selected State (or All)
  const districtSummaries = useMemo(() => {
    const baseDistricts = getDistrictsForState(selectedState === 'all' ? 'all' : selectedState);
    const list = baseDistricts.map((d) => {
      const distMetricKey = `${d.stateCode}|${normalizeLocationKey(d.name)}`;
      const officialVillagesCount = getOfficialDistrictVillageCountSync(d.stateCode, d.code);
      const customCount = customVillageRows.filter(
        (cv) => cv.stateCode === d.stateCode && normalizeLocationKey(cv.district) === normalizeLocationKey(d.name)
      ).length;
      const officialTalukas = getTalukaMetasForDistrict(d.code, d.stateCode);
      const customTals = locationTalukas.filter(
        (lt) => normalizeLocationKey(lt.district) === normalizeLocationKey(d.name)
      );
      return {
        code: d.code,
        stateCode: d.stateCode,
        stateName: d.stateName,
        district: d.name,
        label: getDistrictDisplayLabel(d.name),
        totalTalukas: officialTalukas.length + customTals.length,
        villageCount: officialVillagesCount + customCount,
        dealerCount: dealerMappingIndex.dealerCountByDistrictKey.get(distMetricKey) || 0,
      };
    });
    return list;
  }, [selectedState, customVillageRows, locationTalukas, dealerMappingIndex, lgdRevision]);

  const selectedDistrictMeta = useMemo(() => {
    if (selectedDistrict === 'all') return undefined;
    return getDistrictMeta(selectedDistrict, selectedStateMeta?.code);
  }, [selectedDistrict, selectedStateMeta?.code]);

  // Talukas for selected District (Official LGD Talukas + Admin-added Custom Talukas + Unmapped dealer talukas)
  const talukaSummaries = useMemo(() => {
    if (selectedDistrict === 'all') return [];
    const stCode = selectedDistrictMeta?.stateCode || selectedStateMeta?.code || '';
    const dName = selectedDistrictMeta?.name || canonicalizeDistrictName(selectedDistrict);
    const officialTalukas = getTalukaMetasForDistrict(
      selectedDistrictMeta?.code || dName,
      stCode
    );

    const map = new Map<
      string,
      { code: string; taluka: string; villageCount: number; dealerCount: number; isCustom: boolean; customDocId?: string }
    >();

    officialTalukas.forEach((t) => {
      const talMetricKey = `${t.stateCode}|${normalizeLocationKey(dName)}|${normalizeLocationKey(t.name)}`;
      const officialVillages = getOfficialTalukaVillageCountSync(t.stateCode, t.code);
      const customVillages = customVillageRows.filter(
        (cv) =>
          normalizeLocationKey(cv.district) === normalizeLocationKey(dName) &&
          normalizeLocationKey(cv.taluka) === normalizeLocationKey(t.name)
      ).length;

      map.set(normalizeLocationKey(t.name), {
        code: t.code,
        taluka: t.name,
        villageCount: officialVillages + customVillages,
        dealerCount: dealerMappingIndex.dealerCountByTalukaKey.get(talMetricKey) || 0,
        isCustom: false,
      });
    });

    // Admin-added custom talukas
    locationTalukas.forEach((lt) => {
      if (lt.isArchived) return;
      if (normalizeLocationKey(lt.district) !== normalizeLocationKey(dName)) return;
      const tk = normalizeLocationKey(lt.taluka);
      if (!map.has(tk)) {
        const talMetricKey = `${stCode}|${normalizeLocationKey(dName)}|${tk}`;
        const customVillages = customVillageRows.filter(
          (cv) =>
            normalizeLocationKey(cv.district) === normalizeLocationKey(dName) &&
            normalizeLocationKey(cv.taluka) === tk
        ).length;
        map.set(tk, {
          code: lt.talukaCode,
          taluka: lt.taluka,
          villageCount: customVillages,
          dealerCount: dealerMappingIndex.dealerCountByTalukaKey.get(talMetricKey) || 0,
          isCustom: true,
          customDocId: lt.id,
        });
      }
    });

    // Legacy unmapped talukas if any dealer sits there
    dealerMappingIndex.unmappedBuckets.forEach((ub) => {
      if (normalizeLocationKey(ub.district) !== normalizeLocationKey(dName)) return;
      const tk = normalizeLocationKey(ub.taluka);
      const existing = map.get(tk);
      if (existing) {
        existing.villageCount += 1;
      } else {
        map.set(tk, {
          code: ub.talukaCode || '',
          taluka: ub.taluka,
          villageCount: 1,
          dealerCount: ub.dealers.length,
          isCustom: false,
        });
      }
    });

    return Array.from(map.values()).sort((a, b) => {
      if (a.taluka.startsWith('Other') && !b.taluka.startsWith('Other')) return 1;
      if (b.taluka.startsWith('Other') && !a.taluka.startsWith('Other')) return -1;
      return a.taluka.localeCompare(b.taluka);
    });
  }, [
    selectedDistrict,
    selectedDistrictMeta,
    selectedStateMeta?.code,
    customVillageRows,
    locationTalukas,
    dealerMappingIndex,
    lgdRevision,
  ]);

  const selectedTalukaMeta = useMemo(() => {
    if (selectedTaluka === 'all' || selectedDistrict === 'all') return undefined;
    return getTalukaMeta(
      selectedDistrictMeta?.code || selectedDistrict,
      selectedTaluka,
      selectedDistrictMeta?.stateCode || selectedStateMeta?.code
    );
  }, [selectedTaluka, selectedDistrict, selectedDistrictMeta, selectedStateMeta?.code]);

  // Build visible paginated Village Rows cleanly without blowing up memory across 75,705 villages
  const villageQueryResult = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const stateFilterCode = selectedState === 'all' ? 'all' : selectedStateMeta?.code || '';
    const distFilterCode = selectedDistrict !== 'all' ? selectedDistrictMeta?.code || '' : 'all';
    const talFilterCode = selectedTaluka !== 'all' ? selectedTalukaMeta?.code || '' : 'all';

    const matchesText = (row: {
      village: string;
      villageCode: string;
      pinCode: string;
      taluka: string;
      district: string;
      dealers: any[];
    }) => {
      if (!q) return true;
      if (
        row.village.toLowerCase().includes(q) ||
        row.villageCode.toLowerCase().includes(q) ||
        row.pinCode.toLowerCase().includes(q) ||
        row.taluka.toLowerCase().includes(q) ||
        row.district.toLowerCase().includes(q)
      ) {
        return true;
      }
      return row.dealers.some(
        (d) =>
          (d.firmName || '').toLowerCase().includes(q) ||
          (d.dealerCode || '').toLowerCase().includes(q) ||
          (d.proprietorName || '').toLowerCase().includes(q) ||
          (d.contactNumber || '').toLowerCase().includes(q)
      );
    };

    const matchesScope = (row: VillageRow) => {
      if (stateFilterCode && stateFilterCode !== 'all' && row.stateCode !== stateFilterCode) {
        return false;
      }
      if (
        selectedDistrict !== 'all' &&
        normalizeLocationKey(row.district) !== normalizeLocationKey(selectedDistrictMeta?.name || selectedDistrict)
      ) {
        return false;
      }
      if (
        selectedTaluka !== 'all' &&
        normalizeLocationKey(row.taluka) !== normalizeLocationKey(selectedTalukaMeta?.name || selectedTaluka)
      ) {
        return false;
      }
      return true;
    };

    // Custom + Legacy Unmapped rows in current scope
    const extraRows = [...customVillageRows, ...dealerMappingIndex.unmappedBuckets]
      .filter(matchesScope)
      .filter((r) => (!onlyWithDealers || r.dealers.length > 0) && matchesText(r));

    // When "Only With Dealers" is toggled ON, gather official LGD villages that actually have linked dealers (fast!)
    if (onlyWithDealers) {
      const dealerOfficialRows: VillageRow[] = [];
      dealerMappingIndex.dealersByVillageKey.forEach((dList, key) => {
        if (!key.startsWith('code:')) return;
        const vCode = key.slice(5);
        const ov = findOfficialLgdVillageSync({ villageCode: vCode });
        if (!ov) return;
        const row: VillageRow = {
          id: `lgd_v_${ov.villageCode}`,
          villageCode: ov.villageCode,
          village: ov.villageName,
          talukaCode: ov.talukaCode,
          taluka: ov.talukaName,
          districtCode: ov.districtCode,
          district: ov.districtName,
          stateCode: ov.stateCode,
          state: ov.stateName,
          pinCode: ov.pinCode,
          isOfficialLgd: true,
          isCustomSaved: false,
          dealers: dList,
        };
        if (matchesScope(row) && matchesText(row)) {
          dealerOfficialRows.push(row);
        }
      });

      const merged = [...dealerOfficialRows, ...extraRows].sort((a, b) => {
        const dCmp = a.district.localeCompare(b.district);
        if (dCmp !== 0) return dCmp;
        const tCmp = a.taluka.localeCompare(b.taluka);
        if (tCmp !== 0) return tCmp;
        return a.village.localeCompare(b.village);
      });

      return {
        items: merged.slice(0, visibleLimit),
        totalCount: merged.length,
      };
    }

    // If a Taluka IS selected, check if it's a custom non-LGD taluka
    const isCustomSelectedTaluka = selectedTaluka !== 'all' && !talFilterCode;
    if (isCustomSelectedTaluka) {
      return {
        items: extraRows.slice(0, visibleLimit),
        totalCount: extraRows.length,
      };
    }

    // Fast path: filter official LGD villages in IndexedDB memory cache
    // First include any extra/custom villages that match text search, then official LGD villages up to visibleLimit
    const toRow = (ov: OfficialLgdVillage): VillageRow => ({
      id: `lgd_v_${ov.villageCode}`,
      villageCode: ov.villageCode,
      village: ov.villageName,
      talukaCode: ov.talukaCode,
      taluka: ov.talukaName,
      districtCode: ov.districtCode,
      district: ov.districtName,
      stateCode: ov.stateCode,
      state: ov.stateName,
      pinCode: ov.pinCode,
      isOfficialLgd: true,
      isCustomSaved: false,
      dealers: dealerMappingIndex.dealersByVillageKey.get(`code:${ov.villageCode}`) || [],
    });

    // If user searched by dealer firm/code, scan dealer-mapped official villages too
    const dealerMatchedOfficial: VillageRow[] = [];
    const seenOfficialCodes = new Set<string>();
    if (q) {
      dealerMappingIndex.dealersByVillageKey.forEach((dList, key) => {
        if (!key.startsWith('code:')) return;
        const hitDealer = dList.some(
          (d) =>
            (d.firmName || '').toLowerCase().includes(q) ||
            (d.dealerCode || '').toLowerCase().includes(q) ||
            (d.proprietorName || '').toLowerCase().includes(q) ||
            (d.contactNumber || '').toLowerCase().includes(q)
        );
        if (!hitDealer) return;
        const ov = findOfficialLgdVillageSync({ villageCode: key.slice(5) });
        if (!ov) return;
        const row = toRow(ov);
        if (matchesScope(row)) {
          seenOfficialCodes.add(ov.villageCode);
          dealerMatchedOfficial.push(row);
        }
      });
    }

    const officialRes = getOfficialVillagesFilteredSync({
      stateCode: stateFilterCode || 'all',
      districtCode: distFilterCode,
      talukaCode: talFilterCode,
      query: q,
      limit: Math.max(visibleLimit, PAGE_STEP),
    });

    const combined: VillageRow[] = [...extraRows, ...dealerMatchedOfficial];
    for (const ov of officialRes.items) {
      if (!seenOfficialCodes.has(ov.villageCode)) {
        combined.push(toRow(ov));
      }
    }

    // Put villages with dealers first when showing general filtered results inside a taluka or search
    combined.sort((a, b) => {
      if (a.dealers.length > 0 && b.dealers.length === 0) return -1;
      if (b.dealers.length > 0 && a.dealers.length === 0) return 1;
      const dCmp = a.district.localeCompare(b.district);
      if (dCmp !== 0) return dCmp;
      const tCmp = a.taluka.localeCompare(b.taluka);
      if (tCmp !== 0) return tCmp;
      return a.village.localeCompare(b.village);
    });

    return {
      items: combined.slice(0, visibleLimit),
      totalCount: officialRes.totalMatched + extraRows.length + dealerMatchedOfficial.length,
    };
  }, [
    selectedState,
    selectedStateMeta?.code,
    selectedDistrict,
    selectedDistrictMeta,
    selectedTaluka,
    selectedTalukaMeta,
    searchQuery,
    onlyWithDealers,
    visibleLimit,
    customVillageRows,
    dealerMappingIndex,
    lgdRevision,
  ]);

  // Global summary metrics for header
  const totalStats = useMemo(() => {
    const districts = districtSummaries.length;
    const talukas = districtSummaries.reduce((acc, d) => acc + d.totalTalukas, 0);
    const villages = districtSummaries.reduce((acc, d) => acc + d.villageCount, 0);
    const dealerCount =
      selectedState === 'all'
        ? Array.from(dealerMappingIndex.dealerCountByStateCode.values()).reduce((a, b) => a + b, 0)
        : dealerMappingIndex.dealerCountByStateCode.get(selectedStateMeta?.code || '') || 0;
    return { districts, talukas, villages, dealers: dealerCount };
  }, [districtSummaries, selectedState, selectedStateMeta?.code, dealerMappingIndex]);

  // Modal helpers
  const villageModalDistricts = useMemo(() => getDistrictsForState(modalState), [modalState]);
  const villageModalTalukas = useMemo(() => {
    const base = getTalukaMetasForDistrict(newDistrict, modalState).map((t) => t.name);
    const dKey = normalizeLocationKey(canonicalizeDistrictName(newDistrict, modalState));
    locationTalukas.forEach((lt) => {
      if (!lt.isArchived && normalizeLocationKey(lt.district) === dKey) {
        if (!base.some((b) => normalizeLocationKey(b) === normalizeLocationKey(lt.taluka))) {
          base.push(lt.taluka);
        }
      }
    });
    return base.sort((a, b) => a.localeCompare(b));
  }, [newDistrict, modalState, locationTalukas]);

  const talukaModalDistricts = useMemo(
    () => getDistrictsForState(talukaModalState),
    [talukaModalState]
  );

  const openAddVillageModal = (presetDistrict?: string, presetTaluka?: string) => {
    if (!userIsAdmin) return;
    const activeState = selectedState === 'all' ? DEFAULT_STATE : selectedState;
    const stateDists = getDistrictsForState(activeState);
    const dist =
      presetDistrict && presetDistrict !== 'all'
        ? canonicalizeDistrictName(presetDistrict, activeState)
        : selectedDistrict !== 'all'
          ? canonicalizeDistrictName(selectedDistrict, activeState)
          : stateDists[0]?.name || 'Sangli';
    const talList = getTalukaMetasForDistrict(dist, activeState).map((t) => t.name);
    const tal =
      presetTaluka && presetTaluka !== 'all' && !presetTaluka.startsWith('Other')
        ? canonicalizeTalukaName(dist, presetTaluka, activeState)
        : selectedTaluka !== 'all' && !selectedTaluka.startsWith('Other')
          ? canonicalizeTalukaName(dist, selectedTaluka, activeState)
          : talList[0] || '';

    setModalState(activeState);
    setNewDistrict(dist);
    setNewTaluka(tal);
    setNewVillageName('');
    setNewVillageCode('');
    setNewPinCode('');
    setShowAddVillageModal(true);
  };

  const openAddTalukaModal = (presetDistrict?: string) => {
    if (!userIsAdmin) return;
    const activeState = selectedState === 'all' ? DEFAULT_STATE : selectedState;
    const stateDists = getDistrictsForState(activeState);
    const dist =
      presetDistrict && presetDistrict !== 'all'
        ? canonicalizeDistrictName(presetDistrict, activeState)
        : selectedDistrict !== 'all'
          ? canonicalizeDistrictName(selectedDistrict, activeState)
          : stateDists[0]?.name || 'Sangli';
    setTalukaModalState(activeState);
    setTalukaModalDistrict(dist);
    setNewTalukaName('');
    setNewTalukaCode('');
    setShowAddTalukaModal(true);
  };

  const handleSaveNewTaluka = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userIsAdmin || isSavingTaluka) return;

    const stMeta = getStateMeta(talukaModalState) || getStateMeta(DEFAULT_STATE)!;
    const dMeta = getDistrictMeta(talukaModalDistrict, stMeta.code);
    const cleanDist = dMeta?.name || canonicalizeDistrictName(talukaModalDistrict, stMeta.name);
    const cleanTal = newTalukaName.trim();
    const customCodeInput = newTalukaCode.trim();

    if (!cleanDist || !cleanTal) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'माहिती अपूर्ण आहे',
        message: 'कृपया जिल्हा आणि नवीन तालुक्याचे नाव भरा.',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
      return;
    }

    // Check official LGD talukas first for duplicates
    const officialExisting = getTalukaMetasForDistrict(cleanDist, stMeta.code).find(
      (t) =>
        normalizeLocationKey(t.name) === normalizeLocationKey(cleanTal) ||
        (customCodeInput && t.code === customCodeInput)
    );
    const customExisting = locationTalukas.find(
      (lt) =>
        !lt.isArchived &&
        normalizeLocationKey(lt.state) === normalizeLocationKey(stMeta.name) &&
        normalizeLocationKey(lt.district) === normalizeLocationKey(cleanDist) &&
        (normalizeLocationKey(lt.taluka) === normalizeLocationKey(cleanTal) ||
          (customCodeInput && lt.talukaCode === customCodeInput))
    );

    if (officialExisting || customExisting) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'तालुका आधीपासून अस्तित्वात आहे',
        message: `${toTitleCase(cleanTal)} (${cleanDist}) हा तालुका किंवा LGD Code आधीपासून यादीत आहे.`,
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
      return;
    }

    setIsSavingTaluka(true);
    try {
      const nowIso = new Date().toISOString();
      const talCode =
        customCodeInput ||
        `CUST-T-${stMeta.code}-${normalizeLocationKey(cleanTal).slice(0, 4).toUpperCase()}-${Date.now().toString().slice(-4)}`;
      const docId = getLocationTalukaDocId(stMeta.name, cleanDist, cleanTal, talCode);

      const record: LocationTalukaItem = {
        id: docId,
        state: stMeta.name,
        stateCode: stMeta.code,
        district: cleanDist,
        districtCode: dMeta?.code || '',
        taluka: toTitleCase(cleanTal),
        talukaCode: talCode,
        createdByUid: profile.uid || '',
        createdByName: profile.fullName || profile.loginId || '',
        createdAt: nowIso,
        updatedAt: nowIso,
        isArchived: false,
      };

      setLocationTalukasOptimistic((prev) => [...prev.filter((t) => t.id !== record.id), record]);
      await safeFirestoreSet('location_talukas', record.id, record, { merge: true });
      await logAudit(
        'CREATE',
        'location_talukas',
        record.id,
        `Admin added Taluka ${record.taluka} [${record.talukaCode}] in ${record.district}, ${record.state}`,
        profile
      );

      setSelectedState(stMeta.name);
      setSelectedDistrict(cleanDist);
      setSelectedTaluka(record.taluka);
      setShowAddTalukaModal(false);
      setStatusBanner(`नवीन तालुका "${record.taluka}" (${cleanDist}) यशस्वीरित्या Add केला!`);
      setTimeout(() => setStatusBanner(null), 4000);
    } catch {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'सेव्ह त्रुटी',
        message: 'तालुका सेव्ह करताना अडचण आली.',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
    } finally {
      setIsSavingTaluka(false);
    }
  };

  const handleSaveNewVillage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userIsAdmin || isSavingVillage) return;

    const stMeta = getStateMeta(modalState) || getStateMeta(DEFAULT_STATE)!;
    const dMeta = getDistrictMeta(newDistrict, stMeta.code);
    const cleanDist = dMeta?.name || canonicalizeDistrictName(newDistrict, stMeta.name);
    const tMeta = getTalukaMeta(dMeta?.code || cleanDist, newTaluka, stMeta.code);
    const customTalMatch = !tMeta
      ? locationTalukas.find(
          (lt) =>
            normalizeLocationKey(lt.district) === normalizeLocationKey(cleanDist) &&
            normalizeLocationKey(lt.taluka) === normalizeLocationKey(newTaluka)
        )
      : undefined;
    const cleanTal = tMeta?.name || customTalMatch?.taluka || canonicalizeTalukaName(cleanDist, newTaluka, stMeta.name) || newTaluka.trim();
    const talCode = tMeta?.code || customTalMatch?.talukaCode || '';
    const cleanVil = newVillageName.trim();
    const customVilCode = newVillageCode.trim();
    const cleanPin = newPinCode.trim();

    if (!cleanDist || !cleanTal || !cleanVil) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'माहिती अपूर्ण आहे',
        message: 'कृपया जिल्हा, तालुका आणि गावाचे नाव भरा.',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
      return;
    }

    // Check official LGD master first to avoid any duplicate
    const officialExisting = findOfficialLgdVillageSync({
      stateCode: stMeta.code,
      talukaCode: talCode,
      villageCode: customVilCode,
      villageName: cleanVil,
    });

    if (officialExisting) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'गाव अधिकृत LGD यादीत आधीपासून आहे',
        message: `${officialExisting.villageName} (LGD Code: ${officialExisting.villageCode}, तालुका: ${officialExisting.talukaName}) हे गाव आधीपासून अधिकृत डेटाबेसमध्ये आहे.`,
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
      return;
    }

    const docId = getLocationVillageDocId(stMeta.name, cleanDist, cleanTal, cleanVil, customVilCode);
    const dupKey = `${normalizeLocationKey(stMeta.name)}|${normalizeLocationKey(cleanDist)}|${normalizeLocationKey(cleanTal)}|${normalizeLocationKey(cleanVil)}`;
    const existing = locationVillages.find((lv) => {
      if (customVilCode && lv.villageCode === customVilCode) return true;
      const k = `${normalizeLocationKey(lv.state)}|${normalizeLocationKey(lv.district)}|${normalizeLocationKey(lv.taluka)}|${normalizeLocationKey(lv.village)}`;
      return k === dupKey || lv.id === docId;
    });

    if (existing && (!cleanPin || existing.pinCode === cleanPin)) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'गाव आधीपासून अस्तित्वात आहे',
        message: `${toTitleCase(cleanVil)} (${cleanTal}, ${cleanDist}) हे गाव यादीत आधीपासून सेव्ह आहे.`,
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
      return;
    }

    setIsSavingVillage(true);
    try {
      const nowIso = new Date().toISOString();
      const vCode =
        customVilCode ||
        existing?.villageCode ||
        `CUST-V-${stMeta.code}-${normalizeLocationKey(cleanVil).slice(0, 4).toUpperCase()}-${Date.now().toString().slice(-4)}`;

      const record: LocationVillageItem = {
        ...(existing || {}),
        id: existing?.id || docId,
        state: stMeta.name,
        stateCode: stMeta.code,
        district: cleanDist,
        districtCode: dMeta?.code || '',
        taluka: cleanTal,
        talukaCode: talCode,
        village: toTitleCase(cleanVil),
        villageCode: vCode,
        pinCode: cleanPin || existing?.pinCode || '',
        isCustom: true,
        createdByUid: existing?.createdByUid || profile.uid || '',
        createdByName: existing?.createdByName || profile.fullName || profile.loginId || '',
        createdAt: existing?.createdAt || nowIso,
        updatedAt: nowIso,
        isArchived: false,
      };

      setLocationVillagesOptimistic((prev) => [...prev.filter((v) => v.id !== record.id), record]);
      await safeFirestoreSet('location_villages', record.id, record, { merge: true });
      await logAudit(
        existing ? 'UPDATE' : 'CREATE',
        'location_villages',
        record.id,
        `Admin ${existing ? 'updated' : 'added'} Village ${record.village} [${record.villageCode}] (${record.taluka}, ${record.district}, ${record.state})`,
        profile
      );

      setSelectedState(stMeta.name);
      setSelectedDistrict(cleanDist);
      setSelectedTaluka(cleanTal);
      setShowAddVillageModal(false);
      setStatusBanner(`नवीन गाव "${record.village}" (${cleanTal}, ${cleanDist}) यशस्वीरित्या Add केले!`);
      setTimeout(() => setStatusBanner(null), 4000);
    } catch {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'सेव्ह त्रुटी',
        message: 'गाव सेव्ह करताना अडचण आली. कृपया पुन्हा प्रयत्न करा.',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
    } finally {
      setIsSavingVillage(false);
    }
  };

  const handleDeleteCustomVillage = (row: VillageRow) => {
    if (!row.isCustomSaved || !userIsAdmin) return;
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'गाव काढून टाका (Remove Village)',
      message: `तुम्हाला "${toTitleCase(row.village)}" (${row.taluka}, ${row.district}) हे कस्टम गाव Location यादीतून काढायचे आहे का?`,
      confirmText: 'होय, काढा',
      cancelText: 'रद्द करा',
      onConfirm: async () => {
        setDialogConfig((p) => ({ ...p, isOpen: false }));
        setLocationVillagesOptimistic((prev) => prev.filter((v) => v.id !== row.id));
        await safeFirestoreDelete('location_villages', row.id, { softDelete: true, user: profile });
      },
      onCancel: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
    });
  };

  const handleDeleteCustomTaluka = (talukaId: string, talukaName: string) => {
    if (!userIsAdmin) return;
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'तालुका काढून टाका',
      message: `तुम्हाला "${talukaName}" हा कस्टम तालुका काढायचा आहे का?`,
      confirmText: 'होय, काढा',
      cancelText: 'रद्द करा',
      onConfirm: async () => {
        setDialogConfig((p) => ({ ...p, isOpen: false }));
        setLocationTalukasOptimistic((prev) => prev.filter((t) => t.id !== talukaId));
        await safeFirestoreDelete('location_talukas', talukaId, { softDelete: true, user: profile });
      },
      onCancel: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
    });
  };

  const getOfficerLabel = (d: any) => {
    const uid = d.created_by_user_id || d.createdByUid || d.userId || d.ownerId;
    const raw =
      (uid && usersMap[uid]) ||
      (d.loginId && usersMap[d.loginId.toLowerCase()]) ||
      d.officerName ||
      d.created_by_name ||
      '';
    return toTitleCase(raw);
  };

  const isDistrictOverviewMode = selectedDistrict === 'all' && !searchQuery.trim() && !onlyWithDealers;

  return (
    <div className="space-y-4 pb-24">
      {/* Header & Official LGD State Master Controls */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center shrink-0">
              <MapPin className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
                  Location Master ({selectedState === 'all' ? 'MH + KA' : selectedState})
                </h2>
                {selectedStateMeta && (
                  <span className="text-[10px] font-mono font-black bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0.5 rounded">
                    LGD: {selectedStateMeta.code}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 font-semibold">
                Official LGD Directory • State → District → Taluka → Village & Dealers
              </p>
            </div>
          </div>

          {userIsAdmin && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => openAddTalukaModal()}
                className="flex items-center gap-1 bg-slate-800 hover:bg-slate-900 text-white px-3 py-2 rounded-xl text-xs font-bold shadow-sm active:scale-95 transition cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>नवीन तालुका</span>
              </button>
              <button
                type="button"
                onClick={() => openAddVillageModal()}
                className="flex items-center gap-1 bg-red-600 hover:bg-red-700 text-white px-3 py-2 rounded-xl text-xs font-bold shadow-sm active:scale-95 transition cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>नवीन गाव Add करा</span>
              </button>
            </div>
          )}
        </div>

        {/* State Switcher Tabs */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {LGD_STATES.map((st) => {
            const active = selectedState === st.name;
            return (
              <button
                key={st.code}
                type="button"
                onClick={() => {
                  setSelectedState(st.name);
                  setSelectedDistrict('all');
                  setSelectedTaluka('all');
                }}
                className={`px-3 py-1.5 rounded-xl text-xs font-black border transition cursor-pointer flex items-center gap-1.5 ${
                  active
                    ? 'bg-red-600 text-white border-red-600 shadow-xs'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <span>{st.name}</span>
                <span
                  className={`text-[10px] font-mono px-1 py-0.2 rounded ${
                    active ? 'bg-white/20 text-white' : 'bg-white text-slate-500 border border-slate-200'
                  }`}
                >
                  LGD:{st.code}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              setSelectedState('all');
              setSelectedDistrict('all');
              setSelectedTaluka('all');
            }}
            className={`px-3 py-1.5 rounded-xl text-xs font-black border transition cursor-pointer ${
              selectedState === 'all'
                ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
            }`}
          >
            All (MH + KA)
          </button>

          {loadingLgd && (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-orange-700 bg-orange-50 px-2.5 py-1 rounded-lg">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>LGD Database लोड होत आहे...</span>
            </span>
          )}
        </div>

        {/* Summary Counters */}
        <div className="grid grid-cols-4 gap-2 pt-1">
          <div className="bg-slate-50 border border-slate-100 rounded-xl p-2 text-center">
            <div className="text-[10px] font-bold text-slate-500 uppercase">Districts</div>
            <div className="text-xs sm:text-sm font-black text-slate-900">{totalStats.districts}</div>
          </div>
          <div className="bg-blue-50/70 border border-blue-100 rounded-xl p-2 text-center">
            <div className="text-[10px] font-bold text-blue-700 uppercase">Talukas</div>
            <div className="text-xs sm:text-sm font-black text-blue-900">{totalStats.talukas}</div>
          </div>
          <div className="bg-amber-50/70 border border-amber-100 rounded-xl p-2 text-center">
            <div className="text-[10px] font-bold text-amber-700 uppercase">Villages</div>
            <div className="text-xs sm:text-sm font-black text-amber-900">
              {totalStats.villages.toLocaleString('en-IN')}
            </div>
          </div>
          <div className="bg-emerald-50/70 border border-emerald-100 rounded-xl p-2 text-center">
            <div className="text-[10px] font-bold text-emerald-700 uppercase">Dealers</div>
            <div className="text-xs sm:text-sm font-black text-emerald-900">{totalStats.dealers}</div>
          </div>
        </div>
      </div>

      {statusBanner && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl flex items-center justify-between animate-fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="font-bold">{statusBanner}</span>
          </div>
          <button type="button" onClick={() => setStatusBanner(null)} className="text-emerald-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Search & Hierarchy Filter Bar */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3.5 space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3.5 top-3 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="गाव, LGD Code, तालुका, जिल्हा, पिनकोड किंवा डीलर शोधा..."
            className="w-full pl-10 pr-9 py-2.5 text-xs sm:text-sm rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 font-medium"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {/* District Filter */}
          <div>
            <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">
              District (जिल्हा)
            </label>
            <select
              value={selectedDistrict}
              onChange={(e) => {
                setSelectedDistrict(e.target.value);
                setSelectedTaluka('all');
              }}
              className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
            >
              <option value="all">सर्व जिल्हे (All {districtSummaries.length} Districts)</option>
              {districtSummaries.map((d) => (
                <option key={`${d.stateCode}-${d.code}`} value={d.district}>
                  {d.label} [LGD:{d.code}] — {d.villageCount.toLocaleString('en-IN')} गावे
                  {d.dealerCount > 0 ? `, ${d.dealerCount} डीलर` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Taluka Filter */}
          <div>
            <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">
              Taluka (तालुका)
            </label>
            <select
              value={selectedTaluka}
              disabled={selectedDistrict === 'all'}
              onChange={(e) => setSelectedTaluka(e.target.value)}
              className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60 cursor-pointer"
            >
              <option value="all">
                {selectedDistrict === 'all'
                  ? 'प्रथम जिल्हा निवडा (Select District)'
                  : `सर्व तालुके (${talukaSummaries.length} Talukas)`}
              </option>
              {talukaSummaries.map((t) => (
                <option key={`${t.code}-${t.taluka}`} value={t.taluka}>
                  {t.taluka}
                  {t.code ? ` [LGD:${t.code}]` : ''} — {t.villageCount.toLocaleString('en-IN')} गावे
                  {t.dealerCount > 0 ? `, ${t.dealerCount} डीलर` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Quick Toggle Filter */}
          <div className="flex flex-col justify-end">
            <button
              type="button"
              onClick={() => setOnlyWithDealers((v) => !v)}
              className={`w-full px-3 py-2 rounded-xl text-xs font-bold border flex items-center justify-center gap-1.5 transition cursor-pointer ${
                onlyWithDealers
                  ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              <Filter className="w-3.5 h-3.5" />
              <span>{onlyWithDealers ? 'फक्त डीलर असलेली गावे (Active)' : 'फक्त डीलर असलेली गावे'}</span>
            </button>
          </div>
        </div>

        {/* Serial Hierarchy Breadcrumb */}
        <div className="flex items-center flex-wrap gap-1.5 pt-1 text-xs font-bold text-slate-600 border-t border-slate-100">
          <button
            type="button"
            onClick={() => {
              setSelectedDistrict('all');
              setSelectedTaluka('all');
            }}
            className={`px-2 py-0.5 rounded-lg transition cursor-pointer ${
              selectedDistrict === 'all'
                ? 'bg-orange-100 text-orange-800'
                : 'hover:bg-slate-100 text-slate-700'
            }`}
          >
            {selectedState === 'all' ? 'All States (MH + KA)' : `${selectedState} (LGD: ${selectedStateMeta?.code})`}
          </button>

          {selectedDistrict !== 'all' && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              <button
                type="button"
                onClick={() => setSelectedTaluka('all')}
                className={`px-2 py-0.5 rounded-lg transition cursor-pointer ${
                  selectedTaluka === 'all'
                    ? 'bg-blue-100 text-blue-800'
                    : 'hover:bg-slate-100 text-slate-700'
                }`}
              >
                {getDistrictDisplayLabel(selectedDistrict)}
                {selectedDistrictMeta?.code ? ` [LGD: ${selectedDistrictMeta.code}]` : ''}
              </button>
            </>
          )}

          {selectedTaluka !== 'all' && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              <span className="px-2 py-0.5 rounded-lg bg-emerald-100 text-emerald-800">
                {selectedTaluka}
                {selectedTalukaMeta?.code ? ` [LGD: ${selectedTalukaMeta.code}]` : ''}
              </span>
            </>
          )}

          {(selectedDistrict !== 'all' || searchQuery || onlyWithDealers) && (
            <button
              type="button"
              onClick={() => {
                setSelectedDistrict('all');
                setSelectedTaluka('all');
                setSearchQuery('');
                setOnlyWithDealers(false);
              }}
              className="ml-auto text-[11px] text-red-600 hover:underline font-bold cursor-pointer"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* MODE A: DISTRICT DIRECTORY OVERVIEW */}
      {isDistrictOverviewMode && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3.5 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-orange-600" />
              <span>
                {selectedState === 'all' ? 'Maharashtra & Karnataka' : selectedState} Districts ({districtSummaries.length}) — जिल्हा निवडा
              </span>
            </h3>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {[...districtSummaries]
              .sort((a, b) => {
                if (b.dealerCount !== a.dealerCount) return b.dealerCount - a.dealerCount;
                return a.district.localeCompare(b.district);
              })
              .map((d, idx) => {
                const hasDealers = d.dealerCount > 0;
                return (
                  <button
                    key={`${d.stateCode}-${d.code}`}
                    type="button"
                    onClick={() => {
                      if (selectedState === 'all') setSelectedState(d.stateName);
                      setSelectedDistrict(d.district);
                      setSelectedTaluka('all');
                    }}
                    className={`text-left p-2.5 rounded-xl border transition cursor-pointer active:scale-95 ${
                      hasDealers
                        ? 'bg-orange-50/50 border-orange-200 hover:border-orange-400 shadow-2xs'
                        : 'bg-slate-50/70 border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[10px] font-mono font-bold text-slate-500">
                        #{String(idx + 1).padStart(2, '0')} • LGD:{d.code}
                      </span>
                      {d.dealerCount > 0 && (
                        <span className="text-[10px] font-black bg-emerald-600 text-white px-1.5 py-0.5 rounded-md">
                          {d.dealerCount} Dealers
                        </span>
                      )}
                    </div>
                    <div className="text-xs font-black text-slate-900 mt-1 truncate">{d.label}</div>
                    <div className="text-[10px] text-slate-500 font-semibold mt-0.5">
                      {d.totalTalukas} तालुके • {d.villageCount.toLocaleString('en-IN')} गावे
                    </div>
                  </button>
                );
              })}
          </div>
        </div>
      )}

      {/* MODE B: TALUKA DIRECTORY STRIP */}
      {selectedDistrict !== 'all' && selectedTaluka === 'all' && !searchQuery.trim() && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3.5 space-y-2.5">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider">
              {getDistrictDisplayLabel(selectedDistrict)} — Talukas ({talukaSummaries.length})
            </h3>
            {userIsAdmin && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => openAddTalukaModal(selectedDistrict)}
                  className="text-[11px] font-bold text-slate-700 hover:bg-slate-100 border border-slate-300 px-2.5 py-1 rounded-lg flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>तालुका Add करा</span>
                </button>
                <button
                  type="button"
                  onClick={() => openAddVillageModal(selectedDistrict)}
                  className="text-[11px] font-bold text-red-600 hover:bg-red-50 border border-red-200 px-2.5 py-1 rounded-lg flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>गाव Add करा</span>
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {talukaSummaries.map((t, idx) => (
              <div
                key={`${t.code}-${t.taluka}`}
                className={`p-2 rounded-xl border transition flex flex-col justify-between ${
                  t.dealerCount > 0
                    ? 'bg-blue-50/50 border-blue-200 hover:border-blue-400'
                    : 'bg-slate-50 border-slate-200 hover:border-slate-300'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedTaluka(t.taluka)}
                  className="text-left cursor-pointer w-full"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[10px] font-mono font-bold text-slate-500">
                      {idx + 1}. {t.code ? `LGD:${t.code}` : ''}
                    </span>
                    {t.dealerCount > 0 && (
                      <span className="text-[10px] font-black text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                        {t.dealerCount} डीलर
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-black text-slate-900 truncate mt-0.5">{t.taluka}</div>
                  <div className="text-[10px] text-slate-500 font-semibold">
                    {t.villageCount.toLocaleString('en-IN')} गावे
                  </div>
                </button>
                {userIsAdmin && t.isCustom && t.customDocId && t.villageCount === 0 && t.dealerCount === 0 && (
                  <button
                    type="button"
                    onClick={() => handleDeleteCustomTaluka(t.customDocId!, t.taluka)}
                    className="self-end text-slate-400 hover:text-red-600 p-0.5 mt-1 cursor-pointer"
                    title="Remove empty custom taluka"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* VILLAGE -> DEALERS HIERARCHICAL SERIAL LIST */}
      {(!isDistrictOverviewMode || onlyWithDealers) && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-slate-900 text-white px-4 py-2.5 flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs font-black uppercase tracking-wide flex items-center gap-2">
              <Users className="w-4 h-4 text-orange-400" />
              <span>
                Village & Linked Dealers ({villageQueryResult.totalCount.toLocaleString('en-IN')} गावे)
              </span>
            </div>
            {userIsAdmin && selectedDistrict !== 'all' && (
              <button
                type="button"
                onClick={() =>
                  openAddVillageModal(
                    selectedDistrict,
                    selectedTaluka !== 'all' ? selectedTaluka : undefined
                  )
                }
                className="text-[11px] font-bold bg-red-600 hover:bg-red-700 text-white px-2.5 py-1 rounded-lg flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Village</span>
              </button>
            )}
          </div>

          {villageQueryResult.items.length === 0 ? (
            <div className="p-8 text-center space-y-3">
              <MapPin className="w-8 h-8 text-slate-300 mx-auto" />
              <div className="text-sm font-bold text-slate-700">
                या निवडलेल्या लोकेशनसाठी गावे सापडली नाहीत.
              </div>
              {userIsAdmin && (
                <button
                  type="button"
                  onClick={() =>
                    openAddVillageModal(
                      selectedDistrict !== 'all' ? selectedDistrict : 'Sangli',
                      selectedTaluka !== 'all' ? selectedTaluka : undefined
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-xl shadow-sm cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>नवीन गाव Add करा</span>
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="divide-y divide-slate-100">
                {villageQueryResult.items.map((b, index) => (
                  <div
                    key={`${b.id}_${index}`}
                    className="p-3 sm:p-3.5 hover:bg-slate-50/80 transition flex flex-col sm:flex-row sm:items-start gap-3"
                  >
                    {/* Left: Serial + Village + LGD Code + Hierarchy */}
                    <div className="sm:w-72 shrink-0 space-y-1">
                      <div className="flex items-center flex-wrap gap-1.5">
                        <span className="text-[11px] font-mono font-black text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                          {index + 1}.
                        </span>
                        <span className="text-sm font-black text-slate-900">
                          {toTitleCase(b.village)}
                        </span>
                        {b.villageCode && (
                          <span className="text-[10px] font-mono font-bold text-slate-600 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5">
                            <Hash className="w-2.5 h-2.5 text-slate-400" />
                            {b.villageCode}
                          </span>
                        )}
                        {b.pinCode && (
                          <span className="text-[10px] font-mono font-bold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">
                            {b.pinCode}
                          </span>
                        )}
                        {userIsAdmin && b.isCustomSaved && b.dealers.length === 0 && (
                          <button
                            type="button"
                            onClick={() => handleDeleteCustomVillage(b)}
                            className="ml-auto text-slate-400 hover:text-red-600 p-1 cursor-pointer"
                            title="Remove empty custom village"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 font-semibold pl-7">
                        {b.taluka} → {getDistrictDisplayLabel(b.district)} ({b.state})
                      </div>
                    </div>

                    {/* Right: Multiple Linked Dealers for this Village */}
                    <div className="flex-1 min-w-0">
                      {b.dealers.length === 0 ? (
                        <div className="text-[11px] text-slate-400 font-semibold italic py-1">
                          अद्याप या गावात डीलर लिंक केलेला नाही
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {b.dealers.map((d) => {
                            const code = d.dealerCode ? String(d.dealerCode).replace(/^#/, '') : 'DEALER';
                            const officer = getOfficerLabel(d);
                            return (
                              <button
                                key={d.id}
                                type="button"
                                onClick={() => onOpenDealer?.(d.id)}
                                className="text-left bg-emerald-50/70 hover:bg-emerald-100/80 border border-emerald-200 rounded-xl px-2.5 py-1.5 transition flex items-start gap-2 cursor-pointer group max-w-full"
                                title={onOpenDealer ? 'डीलर फॉर्म उघडा' : undefined}
                              >
                                <span className="text-[10px] font-mono font-black text-red-600 bg-white border border-red-200 px-1.5 py-0.5 rounded shrink-0 mt-0.5">
                                  #{code}
                                </span>
                                <div className="min-w-0">
                                  <div className="text-xs font-black text-slate-900 group-hover:text-red-700 flex items-center gap-1 truncate">
                                    <span className="truncate">{toTitleCase(d.firmName) || 'Unnamed Firm'}</span>
                                    {onOpenDealer && <ExternalLink className="w-3 h-3 text-slate-400 shrink-0" />}
                                  </div>
                                  <div className="text-[10px] text-slate-600 font-semibold flex flex-wrap items-center gap-x-2">
                                    {d.proprietorName && <span>{toTitleCase(d.proprietorName)}</span>}
                                    {d.contactNumber && (
                                      <span className="inline-flex items-center gap-0.5 font-mono text-slate-700">
                                        <Phone className="w-2.5 h-2.5 text-emerald-700" />
                                        {d.contactNumber}
                                      </span>
                                    )}
                                    {officer && <span className="text-slate-500">({officer})</span>}
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {villageQueryResult.items.length < villageQueryResult.totalCount && (
                <div className="p-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[11px] font-bold text-slate-600">
                    दाखवलेली गावे: {villageQueryResult.items.length} / {villageQueryResult.totalCount.toLocaleString('en-IN')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setVisibleLimit((prev) => prev + PAGE_STEP)}
                    className="px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold shadow-xs cursor-pointer active:scale-95 transition"
                  >
                    पुढील {Math.min(PAGE_STEP, villageQueryResult.totalCount - villageQueryResult.items.length)} गावे पहा
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ADMIN-ONLY: ADD NEW VILLAGE MODAL */}
      {userIsAdmin && showAddVillageModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-5 space-y-4 border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-orange-100 text-orange-700 flex items-center justify-center">
                  <MapPin className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900">नवीन गाव Add करा (Admin)</h3>
                  <p className="text-[11px] font-semibold text-slate-500">
                    State → District → Taluka → Village
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAddVillageModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveNewVillage} className="space-y-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">State (राज्य) *</label>
                <select
                  value={modalState}
                  onChange={(e) => {
                    const nextSt = e.target.value;
                    setModalState(nextSt);
                    const nextDists = getDistrictsForState(nextSt);
                    const firstDist = nextDists[0]?.name || '';
                    setNewDistrict(firstDist);
                    const firstTal = getTalukaMetasForDistrict(firstDist, nextSt)[0]?.name || '';
                    setNewTaluka(firstTal);
                  }}
                  className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  {LGD_STATES.map((st) => (
                    <option key={st.code} value={st.name}>
                      {st.name} (LGD: {st.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">District (जिल्हा) *</label>
                <select
                  value={newDistrict}
                  onChange={(e) => {
                    const nextDist = e.target.value;
                    setNewDistrict(nextDist);
                    const nextTals = getTalukaMetasForDistrict(nextDist, modalState).map((t) => t.name);
                    setNewTaluka(nextTals[0] || '');
                  }}
                  required
                  className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  {villageModalDistricts.map((d) => (
                    <option key={d.code} value={d.name}>
                      {getDistrictDisplayLabel(d.name)} [LGD: {d.code}]
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Taluka (तालुका) *</label>
                {villageModalTalukas.length > 0 ? (
                  <select
                    value={newTaluka}
                    onChange={(e) => setNewTaluka(e.target.value)}
                    required
                    className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  >
                    <option value="">-- तालुका निवडा --</option>
                    {villageModalTalukas.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={newTaluka}
                    onChange={(e) => setNewTaluka(e.target.value)}
                    placeholder="तालुक्याचे नाव टाका"
                    required
                    className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                )}
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Village Name (गावाचे नाव) *</label>
                <input
                  type="text"
                  value={newVillageName}
                  onChange={(e) => setNewVillageName(e.target.value)}
                  placeholder="उदा. कवठेमहांकाळ / Savalaj"
                  required
                  className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">LGD Code (ऐच्छिक)</label>
                  <input
                    type="text"
                    value={newVillageCode}
                    onChange={(e) => setNewVillageCode(e.target.value)}
                    placeholder="Auto if empty"
                    className="w-full px-3 py-2 text-xs font-mono font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Pincode (पिनकोड)</label>
                  <input
                    type="text"
                    value={newPinCode}
                    onChange={(e) => setNewPinCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="उदा. 416405"
                    className="w-full px-3 py-2 text-xs font-mono font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddVillageModal(false)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  रद्द करा
                </button>
                <button
                  type="submit"
                  disabled={isSavingVillage}
                  className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
                >
                  {isSavingVillage ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  <span>{isSavingVillage ? 'Saving...' : 'गाव सेव्ह करा'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ADMIN-ONLY: ADD NEW TALUKA MODAL */}
      {userIsAdmin && showAddTalukaModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-5 space-y-4 border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center">
                  <Layers className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900">नवीन तालुका Add करा (Admin)</h3>
                  <p className="text-[11px] font-semibold text-slate-500">
                    State → District → New Taluka
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAddTalukaModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveNewTaluka} className="space-y-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">State (राज्य) *</label>
                <select
                  value={talukaModalState}
                  onChange={(e) => {
                    const nextSt = e.target.value;
                    setTalukaModalState(nextSt);
                    setTalukaModalDistrict(getDistrictsForState(nextSt)[0]?.name || '');
                  }}
                  className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  {LGD_STATES.map((st) => (
                    <option key={st.code} value={st.name}>
                      {st.name} (LGD: {st.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">District (जिल्हा) *</label>
                <select
                  value={talukaModalDistrict}
                  onChange={(e) => setTalukaModalDistrict(e.target.value)}
                  required
                  className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  {talukaModalDistricts.map((d) => (
                    <option key={d.code} value={d.name}>
                      {getDistrictDisplayLabel(d.name)} [LGD: {d.code}]
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Taluka Name (तालुक्याचे नाव) *</label>
                <input
                  type="text"
                  value={newTalukaName}
                  onChange={(e) => setNewTalukaName(e.target.value)}
                  placeholder="नवीन तालुक्याचे नाव टाका"
                  required
                  className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">LGD / Unique Taluka Code (ऐच्छिक)</label>
                <input
                  type="text"
                  value={newTalukaCode}
                  onChange={(e) => setNewTalukaCode(e.target.value)}
                  placeholder="Auto if empty"
                  className="w-full px-3 py-2 text-xs font-mono font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddTalukaModal(false)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  रद्द करा
                </button>
                <button
                  type="submit"
                  disabled={isSavingTaluka}
                  className="flex-1 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
                >
                  {isSavingTaluka ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  <span>{isSavingTaluka ? 'Saving...' : 'तालुका सेव्ह करा'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
