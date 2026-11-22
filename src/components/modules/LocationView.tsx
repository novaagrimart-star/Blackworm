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
  Layers,
  Filter,
  Loader2,
  Save,
  Edit3,
  Store,
  UserCheck,
} from 'lucide-react';
import { UserProfile, isAdmin, isUserRecord } from '../../lib/auth';
import { Language } from '../../lib/i18n';
import { toTitleCase } from '../../lib/utils';
import { safeFirestoreSet, safeFirestoreDelete, logAudit } from '../../lib/dataService';
import {
  useSharedLocationDealers,
  useSharedLocationTalukas,
  useSharedLocationVillages,
  useSharedUsers,
} from '../../lib/realtimeStore';
import {
  DEFAULT_STATE,
  LGD_STATES,
  LocationDealerItem,
  canonicalizeDistrictName,
  canonicalizeTalukaName,
  getDistrictDisplayLabel,
  getDistrictMeta,
  getDistrictsForState,
  getStateMeta,
  getTalukaMeta,
  getTalukaMetasForDistrict,
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
  dealers: LocationDealerItem[];
}

const PAGE_STEP = 60;

const LOCATION_DEALER_CATEGORIES = [
  'Agro Center',
  'Fertilizer & Pesticide',
  'Seeds & Nursery',
  'General Agri Shop',
  'Potential Dealer',
  'Other',
];

export const LocationView: React.FC<Props> = ({ profile }) => {
  const { locationDealers: rawLocationDealers, setLocationDealersOptimistic } =
    useSharedLocationDealers();
  const { locationVillages } = useSharedLocationVillages();
  const { locationTalukas } = useSharedLocationTalukas();
  const { usersMap } = useSharedUsers();

  const userIsAdmin = isAdmin(profile);

  // Strictly scoped independent Location Mapping dealers (never linked to Dealer Management)
  const locationDealers = useMemo(
    () =>
      (rawLocationDealers || []).filter(
        (d) =>
          d &&
          !d.isArchived &&
          (userIsAdmin ||
            isUserRecord(d, profile) ||
            String(d.createdByUid || d.userId || '').trim() === String(profile.uid || '').trim())
      ),
    [rawLocationDealers, userIsAdmin, profile]
  );

  // Selected state starts unselected ('') so summary buttons appear only after Maharashtra, Karnataka, or All is chosen
  const [selectedState, setSelectedState] = useState<string>('');
  const [selectedDistrict, setSelectedDistrict] = useState<string>('all');
  const [selectedTaluka, setSelectedTaluka] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [onlyWithDealers, setOnlyWithDealers] = useState<boolean>(false);
  const [viewFocus, setViewFocus] = useState<'overview' | 'villages' | 'dealers'>('overview');
  const [visibleLimit, setVisibleLimit] = useState<number>(PAGE_STEP);

  // Background village directory cache load state
  const [lgdRevision, setLgdRevision] = useState<number>(0);
  const [loadingDirectory, setLoadingDirectory] = useState<boolean>(
    () => !isLgdStateCachedInMemory('27') || !isLgdStateCachedInMemory('29')
  );

  // Separate Location Dealer Form Modal State (Independent from Dealer Management)
  const [showDealerFormModal, setShowDealerFormModal] = useState<boolean>(false);
  const [editingDealerId, setEditingDealerId] = useState<string | null>(null);
  const [dealerStateInput, setDealerStateInput] = useState<string>(DEFAULT_STATE);
  const [dealerDistrictInput, setDealerDistrictInput] = useState<string>('Sangli');
  const [dealerTalukaInput, setDealerTalukaInput] = useState<string>('');
  const [dealerVillageInput, setDealerVillageInput] = useState<string>('');
  const [dealerVillageCodeInput, setDealerVillageCodeInput] = useState<string>('');
  const [dealerPinCodeInput, setDealerPinCodeInput] = useState<string>('');
  const [dealerFirmNameInput, setDealerFirmNameInput] = useState<string>('');
  const [dealerProprietorInput, setDealerProprietorInput] = useState<string>('');
  const [dealerMobileInput, setDealerMobileInput] = useState<string>('');
  const [dealerCategoryInput, setDealerCategoryInput] = useState<string>('Agro Center');
  const [dealerAddressInput, setDealerAddressInput] = useState<string>('');
  const [dealerNotesInput, setDealerNotesInput] = useState<string>('');
  const [isSavingDealer, setIsSavingDealer] = useState<boolean>(false);

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

  useEffect(() => {
    let active = true;
    const initCache = async () => {
      try {
        await Promise.all([loadLgdStateVillages('27'), loadLgdStateVillages('29')]);
      } finally {
        if (active) {
          setLoadingDirectory(false);
          setLgdRevision((r) => r + 1);
        }
      }
    };
    void initCache();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setVisibleLimit(PAGE_STEP);
  }, [selectedState, selectedDistrict, selectedTaluka, searchQuery, onlyWithDealers, viewFocus]);

  const selectedStateMeta = useMemo(
    () => (!selectedState || selectedState === 'all' ? undefined : getStateMeta(selectedState)),
    [selectedState]
  );

  // Index Location Mapping Dealers onto villages for counts & row display
  const dealerMappingIndex = useMemo(() => {
    const dealersByVillageKey = new Map<string, LocationDealerItem[]>();
    const unmappedBuckets = new Map<string, VillageRow>();
    const dealerCountByStateCode = new Map<string, number>();
    const dealerCountByDistrictKey = new Map<string, number>();
    const dealerCountByTalukaKey = new Map<string, number>();

    const addDealerToKey = (key: string, d: LocationDealerItem) => {
      const arr = dealersByVillageKey.get(key);
      if (arr) {
        arr.push(d);
      } else {
        dealersByVillageKey.set(key, [d]);
      }
    };

    const sortDealers = (list: LocationDealerItem[]) =>
      list.sort((a, b) => String(a.firmName || '').localeCompare(String(b.firmName || '')));

    locationDealers.forEach((d) => {
      if (!d || d.isArchived) return;

      const guessedState =
        d.stateCode ||
        d.state ||
        resolveStateFromDistrict(d.district) ||
        DEFAULT_STATE;
      const stMeta = getStateMeta(guessedState);
      const stCode = stMeta?.code || normalizeLocationKey(guessedState);
      const stName = stMeta?.name || normalizeStateName(guessedState);

      const dMeta = getDistrictMeta(d.districtCode || d.district, stMeta?.code);
      const dName = dMeta?.name || canonicalizeDistrictName(d.district || '', stName) || 'Other District';

      const villageLabel = String(d.village || '').trim() || 'Other';
      const tMeta = getTalukaMeta(
        dMeta?.code || dName,
        d.talukaCode || d.taluka,
        stMeta?.code
      );
      const resolvedTalukaName =
        tMeta?.name ||
        canonicalizeTalukaName(dName, d.taluka || '', stName) ||
        String(d.taluka || '').trim() ||
        'Other';

      dealerCountByStateCode.set(stCode, (dealerCountByStateCode.get(stCode) || 0) + 1);
      const distMetricKey = `${stCode}|${normalizeLocationKey(dName)}`;
      dealerCountByDistrictKey.set(distMetricKey, (dealerCountByDistrictKey.get(distMetricKey) || 0) + 1);
      const talMetricKey = `${distMetricKey}|${normalizeLocationKey(resolvedTalukaName)}`;
      dealerCountByTalukaKey.set(talMetricKey, (dealerCountByTalukaKey.get(talMetricKey) || 0) + 1);

      const officialHit = findOfficialLgdVillageSync({
        stateCode: stMeta?.code,
        talukaCode: tMeta?.code,
        villageCode: d.villageCode,
        villageName: villageLabel,
      });

      if (officialHit) {
        addDealerToKey(`code:${officialHit.villageCode}`, d);
        return;
      }

      const customKey = `${stCode}|${normalizeLocationKey(dName)}|${normalizeLocationKey(resolvedTalukaName)}|${normalizeLocationKey(villageLabel)}`;
      let bucket = unmappedBuckets.get(customKey);
      if (!bucket) {
        bucket = {
          id: `loc_dealer_bucket_${customKey}`,
          villageCode: d.villageCode || '',
          village: villageLabel,
          talukaCode: tMeta?.code || d.talukaCode || '',
          taluka: resolvedTalukaName,
          districtCode: dMeta?.code || d.districtCode || '',
          district: dName,
          stateCode: stMeta?.code || stCode,
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
  }, [locationDealers, lgdRevision]);

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
        dealers: linkedDealers,
      });
    });
    return Array.from(seen.values());
  }, [locationVillages, dealerMappingIndex, lgdRevision]);

  // District summaries for selected State (or All)
  const districtSummaries = useMemo(() => {
    if (!selectedState) return [];
    const baseDistricts = getDistrictsForState(selectedState === 'all' ? 'all' : selectedState);
    return baseDistricts.map((d) => {
      const distMetricKey = `${d.stateCode}|${normalizeLocationKey(d.name)}`;
      const officialVillagesCount = getOfficialDistrictVillageCountSync(d.stateCode, d.code);
      const customCount = customVillageRows.filter(
        (cv) => cv.stateCode === d.stateCode && normalizeLocationKey(cv.district) === normalizeLocationKey(d.name)
      ).length;
      const officialTalukas = getTalukaMetasForDistrict(d.code, d.stateCode);
      const customTals = locationTalukas.filter(
        (lt) => !lt.isArchived && normalizeLocationKey(lt.district) === normalizeLocationKey(d.name)
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
  }, [selectedState, customVillageRows, locationTalukas, dealerMappingIndex, lgdRevision]);

  const selectedDistrictMeta = useMemo(() => {
    if (selectedDistrict === 'all') return undefined;
    return getDistrictMeta(selectedDistrict, selectedStateMeta?.code);
  }, [selectedDistrict, selectedStateMeta?.code]);

  // Talukas for selected District
  const talukaSummaries = useMemo(() => {
    if (!selectedState || selectedDistrict === 'all') return [];
    const stCode = selectedDistrictMeta?.stateCode || selectedStateMeta?.code || '';
    const dName = selectedDistrictMeta?.name || canonicalizeDistrictName(selectedDistrict);
    const officialTalukas = getTalukaMetasForDistrict(selectedDistrictMeta?.code || dName, stCode);

    const map = new Map<
      string,
      { code: string; taluka: string; villageCount: number; dealerCount: number }
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
      });
    });

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
        });
      }
    });

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
        });
      }
    });

    return Array.from(map.values()).sort((a, b) => a.taluka.localeCompare(b.taluka));
  }, [
    selectedState,
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

  // Filtered Village Rows
  const villageQueryResult = useMemo(() => {
    if (!selectedState) return { items: [] as VillageRow[], totalCount: 0 };

    const q = searchQuery.trim().toLowerCase();
    const stateFilterCode = selectedState === 'all' ? 'all' : selectedStateMeta?.code || '';
    const distFilterCode = selectedDistrict !== 'all' ? selectedDistrictMeta?.code || '' : 'all';
    const talFilterCode = selectedTaluka !== 'all' ? selectedTalukaMeta?.code || '' : 'all';

    const matchesText = (row: {
      village: string;
      pinCode: string;
      taluka: string;
      district: string;
      dealers: LocationDealerItem[];
    }) => {
      if (!q) return true;
      if (
        row.village.toLowerCase().includes(q) ||
        row.pinCode.toLowerCase().includes(q) ||
        row.taluka.toLowerCase().includes(q) ||
        row.district.toLowerCase().includes(q)
      ) {
        return true;
      }
      return row.dealers.some(
        (d) =>
          (d.firmName || '').toLowerCase().includes(q) ||
          (d.proprietorName || '').toLowerCase().includes(q) ||
          (d.contactNumber || '').toLowerCase().includes(q) ||
          (d.category || '').toLowerCase().includes(q)
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

    const extraRows = [...customVillageRows, ...dealerMappingIndex.unmappedBuckets]
      .filter(matchesScope)
      .filter((r) => (!onlyWithDealers || r.dealers.length > 0) && matchesText(r));

    if (onlyWithDealers) {
      const dealerOfficialRows: VillageRow[] = [];
      dealerMappingIndex.dealersByVillageKey.forEach((dList, key) => {
        if (!key.startsWith('code:')) return;
        const vCode = key.slice(5);
        const ov = findOfficialLgdVillageSync({ villageCode: vCode });
        if (!ov) return;
        const row: VillageRow = {
          id: `v_${ov.villageCode}`,
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

    const isCustomSelectedTaluka = selectedTaluka !== 'all' && !talFilterCode;
    if (isCustomSelectedTaluka) {
      return {
        items: extraRows.slice(0, visibleLimit),
        totalCount: extraRows.length,
      };
    }

    const toRow = (ov: OfficialLgdVillage): VillageRow => ({
      id: `v_${ov.villageCode}`,
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

    const dealerMatchedOfficial: VillageRow[] = [];
    const seenOfficialCodes = new Set<string>();
    if (q) {
      dealerMappingIndex.dealersByVillageKey.forEach((dList, key) => {
        if (!key.startsWith('code:')) return;
        const hitDealer = dList.some(
          (d) =>
            (d.firmName || '').toLowerCase().includes(q) ||
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

  // Filtered flat list of Location Dealers for the active State / District / Taluka / Search
  const filteredLocationDealers = useMemo(() => {
    if (!selectedState) return [] as LocationDealerItem[];
    const q = searchQuery.trim().toLowerCase();
    return locationDealers.filter((d) => {
      if (selectedState !== 'all') {
        const stMeta = getStateMeta(d.stateCode || d.state);
        if ((stMeta?.name || d.state) !== selectedState) return false;
      }
      if (
        selectedDistrict !== 'all' &&
        normalizeLocationKey(d.district) !== normalizeLocationKey(selectedDistrictMeta?.name || selectedDistrict)
      ) {
        return false;
      }
      if (
        selectedTaluka !== 'all' &&
        normalizeLocationKey(d.taluka) !== normalizeLocationKey(selectedTalukaMeta?.name || selectedTaluka)
      ) {
        return false;
      }
      if (!q) return true;
      return (
        (d.firmName || '').toLowerCase().includes(q) ||
        (d.proprietorName || '').toLowerCase().includes(q) ||
        (d.contactNumber || '').toLowerCase().includes(q) ||
        (d.village || '').toLowerCase().includes(q) ||
        (d.taluka || '').toLowerCase().includes(q) ||
        (d.district || '').toLowerCase().includes(q) ||
        (d.pinCode || '').toLowerCase().includes(q)
      );
    });
  }, [
    selectedState,
    selectedDistrict,
    selectedDistrictMeta,
    selectedTaluka,
    selectedTalukaMeta,
    searchQuery,
    locationDealers,
  ]);

  // Summary metrics
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

  // Cascading dropdown data inside Location Dealer Form
  const formDistricts = useMemo(() => getDistrictsForState(dealerStateInput), [dealerStateInput]);
  const formTalukas = useMemo(() => {
    const base = getTalukaMetasForDistrict(dealerDistrictInput, dealerStateInput).map((t) => t.name);
    const dKey = normalizeLocationKey(canonicalizeDistrictName(dealerDistrictInput, dealerStateInput));
    locationTalukas.forEach((lt) => {
      if (!lt.isArchived && normalizeLocationKey(lt.district) === dKey) {
        if (!base.some((b) => normalizeLocationKey(b) === normalizeLocationKey(lt.taluka))) {
          base.push(lt.taluka);
        }
      }
    });
    return base.sort((a, b) => a.localeCompare(b));
  }, [dealerDistrictInput, dealerStateInput, locationTalukas]);

  const formOfficialVillages = useMemo(() => {
    const stMeta = getStateMeta(dealerStateInput);
    const dMeta = getDistrictMeta(dealerDistrictInput, stMeta?.code);
    const tMeta = getTalukaMeta(dMeta?.code || dealerDistrictInput, dealerTalukaInput, stMeta?.code);
    if (!stMeta?.code || !tMeta?.code) return [] as OfficialLgdVillage[];
    return getOfficialVillagesByTalukaSync(stMeta.code, tMeta.code);
  }, [dealerStateInput, dealerDistrictInput, dealerTalukaInput, lgdRevision]);

  const openDealerForm = (preset?: {
    dealer?: LocationDealerItem;
    state?: string;
    district?: string;
    taluka?: string;
    village?: string;
    villageCode?: string;
    pinCode?: string;
  }) => {
    if (preset?.dealer) {
      const existing = preset.dealer;
      const stMeta = getStateMeta(existing.stateCode || existing.state || DEFAULT_STATE);
      setEditingDealerId(existing.id);
      setDealerStateInput(stMeta?.name || DEFAULT_STATE);
      setDealerDistrictInput(existing.district || 'Sangli');
      setDealerTalukaInput(existing.taluka || '');
      setDealerVillageInput(existing.village || '');
      setDealerVillageCodeInput(existing.villageCode || '');
      setDealerPinCodeInput(existing.pinCode || '');
      setDealerFirmNameInput(existing.firmName || '');
      setDealerProprietorInput(existing.proprietorName || '');
      setDealerMobileInput(existing.contactNumber || '');
      setDealerCategoryInput(existing.category || 'Agro Center');
      setDealerAddressInput(existing.address || '');
      setDealerNotesInput(existing.notes || '');
      setShowDealerFormModal(true);
      return;
    }

    const activeState =
      preset?.state ||
      (selectedState && selectedState !== 'all' ? selectedState : DEFAULT_STATE);
    const stateDists = getDistrictsForState(activeState);
    const dist =
      preset?.district && preset.district !== 'all'
        ? canonicalizeDistrictName(preset.district, activeState)
        : selectedDistrict !== 'all'
          ? canonicalizeDistrictName(selectedDistrict, activeState)
          : stateDists[0]?.name || 'Sangli';
    const talList = getTalukaMetasForDistrict(dist, activeState).map((t) => t.name);
    const tal =
      preset?.taluka && preset.taluka !== 'all'
        ? canonicalizeTalukaName(dist, preset.taluka, activeState)
        : selectedTaluka !== 'all'
          ? canonicalizeTalukaName(dist, selectedTaluka, activeState)
          : talList[0] || '';

    setEditingDealerId(null);
    setDealerStateInput(activeState);
    setDealerDistrictInput(dist);
    setDealerTalukaInput(tal);
    setDealerVillageInput(preset?.village || '');
    setDealerVillageCodeInput(preset?.villageCode || '');
    setDealerPinCodeInput(preset?.pinCode || '');
    setDealerFirmNameInput('');
    setDealerProprietorInput('');
    setDealerMobileInput('');
    setDealerCategoryInput('Agro Center');
    setDealerAddressInput('');
    setDealerNotesInput('');
    setShowDealerFormModal(true);
  };

  const handleDealerVillageChange = (val: string) => {
    setDealerVillageInput(val);
    const match = formOfficialVillages.find(
      (v) => v.villageName.toLowerCase() === val.trim().toLowerCase()
    );
    if (match) {
      setDealerVillageCodeInput(match.villageCode);
      if (match.pinCode) {
        setDealerPinCodeInput(match.pinCode);
      }
    } else {
      setDealerVillageCodeInput('');
    }
  };

  const handleSaveLocationDealer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingDealer) return;

    const cleanFirm = dealerFirmNameInput.trim();
    const stMeta = getStateMeta(dealerStateInput) || getStateMeta(DEFAULT_STATE)!;
    const dMeta = getDistrictMeta(dealerDistrictInput, stMeta.code);
    const cleanDist = dMeta?.name || canonicalizeDistrictName(dealerDistrictInput, stMeta.name);
    const tMeta = getTalukaMeta(dMeta?.code || cleanDist, dealerTalukaInput, stMeta.code);
    const cleanTal =
      tMeta?.name ||
      canonicalizeTalukaName(cleanDist, dealerTalukaInput, stMeta.name) ||
      dealerTalukaInput.trim();
    const cleanVil = dealerVillageInput.trim();

    if (!cleanFirm || !cleanDist || !cleanTal || !cleanVil) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'माहिती अपूर्ण आहे',
        message: 'कृपया फर्मचे नाव, जिल्हा, तालुका आणि गाव भरा.',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
      return;
    }

    setIsSavingDealer(true);
    try {
      const nowIso = new Date().toISOString();
      const existing = editingDealerId
        ? locationDealers.find((d) => d.id === editingDealerId)
        : undefined;
      const docId =
        existing?.id ||
        `loc_d_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      const matchedOfficial =
        dealerVillageCodeInput
          ? findOfficialLgdVillageSync({ villageCode: dealerVillageCodeInput })
          : findOfficialLgdVillageSync({
              stateCode: stMeta.code,
              talukaCode: tMeta?.code,
              villageName: cleanVil,
            });

      const record: LocationDealerItem = {
        ...(existing || {}),
        id: docId,
        firmName: toTitleCase(cleanFirm),
        proprietorName: toTitleCase(dealerProprietorInput.trim()),
        contactNumber: dealerMobileInput.replace(/\D/g, '').slice(0, 10),
        category: dealerCategoryInput || 'Agro Center',
        state: stMeta.name,
        stateCode: stMeta.code,
        district: cleanDist,
        districtCode: dMeta?.code || '',
        taluka: cleanTal,
        talukaCode: tMeta?.code || '',
        village: toTitleCase(cleanVil),
        villageCode: matchedOfficial?.villageCode || dealerVillageCodeInput || '',
        pinCode: dealerPinCodeInput.replace(/\D/g, '').slice(0, 6) || matchedOfficial?.pinCode || '',
        address: dealerAddressInput.trim(),
        notes: dealerNotesInput.trim(),
        userId: existing?.userId || profile.uid || '',
        ownerId: existing?.ownerId || profile.uid || '',
        createdByUid: existing?.createdByUid || profile.uid || '',
        createdByName: existing?.createdByName || profile.fullName || profile.loginId || '',
        updatedByUid: profile.uid || '',
        updatedByName: profile.fullName || profile.loginId || '',
        createdAt: existing?.createdAt || nowIso,
        updatedAt: nowIso,
        isArchived: false,
      };

      setLocationDealersOptimistic((prev) => [record, ...prev.filter((item) => item.id !== record.id)]);
      await safeFirestoreSet('location_dealers', record.id, record, { merge: true });
      void logAudit(
        existing ? 'UPDATE' : 'CREATE',
        'location_dealers',
        record.id,
        `Location Mapping Dealer: ${record.firmName} (${record.village}, ${record.taluka}, ${record.district})`,
        profile
      ).catch(() => {});

      if (!selectedState) {
        setSelectedState(stMeta.name);
      }
      setShowDealerFormModal(false);
      setEditingDealerId(null);
      setStatusBanner(existing ? 'डीलर नोंद अपडेट केली' : 'नवीन लोकेशन डीलर नोंद सेव्ह केली');
      setTimeout(() => setStatusBanner(null), 3000);
    } catch {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'सेव्ह त्रुटी',
        message: 'डीलर नोंद सेव्ह करताना अडचण आली. कृपया पुन्हा प्रयत्न करा.',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
    } finally {
      setIsSavingDealer(false);
    }
  };

  const handleDeleteLocationDealer = (dealer: LocationDealerItem) => {
    const canDelete = userIsAdmin || isUserRecord(dealer, profile);
    if (!canDelete) return;
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'डीलर नोंद काढायची का?',
      message: `"${toTitleCase(dealer.firmName)}" (${dealer.village}, ${dealer.taluka}) ही लोकेशन डीलर नोंद काढायची आहे का?`,
      confirmText: 'होय, काढा',
      cancelText: 'रद्द करा',
      onConfirm: async () => {
        setDialogConfig((p) => ({ ...p, isOpen: false }));
        setLocationDealersOptimistic((prev) => prev.filter((item) => item.id !== dealer.id));
        await safeFirestoreDelete('location_dealers', dealer.id, { softDelete: true, user: profile });
      },
      onCancel: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
    });
  };

  const getOfficerLabel = (d: LocationDealerItem) => {
    const uid = d.createdByUid || d.userId || d.ownerId;
    const raw = (uid && usersMap[uid]) || d.createdByName || '';
    return toTitleCase(raw);
  };

  const isDistrictOverviewMode =
    Boolean(selectedState) &&
    selectedDistrict === 'all' &&
    !searchQuery.trim() &&
    !onlyWithDealers &&
    viewFocus === 'overview';

  return (
    <div className="space-y-3 pb-24">
      {/* Header & Compact State Controls */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3.5 sm:p-4 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center shrink-0">
              <MapPin className="w-4 h-4" />
            </div>
            <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
              Location Master
            </h2>
          </div>

          <button
            type="button"
            onClick={() => openDealerForm()}
            className="inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-xl text-xs font-bold shadow-xs active:scale-95 transition cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>डीलर फॉर्म</span>
          </button>
        </div>

        {/* Compact State Switcher Buttons: Maharashtra | Karnataka | All */}
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
                  setOnlyWithDealers(false);
                  setViewFocus('overview');
                }}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition cursor-pointer active:scale-95 ${
                  active
                    ? 'bg-red-600 text-white border-red-600 shadow-2xs'
                    : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200/70'
                }`}
              >
                {st.name}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              setSelectedState('all');
              setSelectedDistrict('all');
              setSelectedTaluka('all');
              setOnlyWithDealers(false);
              setViewFocus('overview');
            }}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition cursor-pointer active:scale-95 ${
              selectedState === 'all'
                ? 'bg-slate-900 text-white border-slate-900 shadow-2xs'
                : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200/70'
            }`}
          >
            All
          </button>

          {loadingDirectory && (
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold text-orange-700 bg-orange-50 px-2 py-0.5 rounded-md">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>लोड होत आहे...</span>
            </span>
          )}
        </div>

        {/* Compact Districts / Talukas / Villages / Dealers Buttons — Shown ONLY after State / All is selected */}
        {selectedState && (
          <div className="grid grid-cols-4 gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => {
                setSelectedDistrict('all');
                setSelectedTaluka('all');
                setOnlyWithDealers(false);
                setViewFocus('overview');
              }}
              className={`rounded-lg px-2 py-1.5 text-center border transition cursor-pointer active:scale-95 ${
                viewFocus === 'overview' && !onlyWithDealers && selectedDistrict === 'all'
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-slate-50 border-slate-200 text-slate-800 hover:bg-slate-100'
              }`}
            >
              <div
                className={`text-[9px] font-bold uppercase leading-tight ${
                  viewFocus === 'overview' && !onlyWithDealers && selectedDistrict === 'all'
                    ? 'text-slate-300'
                    : 'text-slate-500'
                }`}
              >
                Districts
              </div>
              <div className="text-xs font-black leading-tight mt-0.5">{totalStats.districts}</div>
            </button>

            <button
              type="button"
              onClick={() => {
                setOnlyWithDealers(false);
                setViewFocus('overview');
              }}
              className="rounded-lg px-2 py-1.5 text-center bg-blue-50/70 border border-blue-200/80 hover:bg-blue-100/70 transition cursor-pointer active:scale-95"
            >
              <div className="text-[9px] font-bold text-blue-700 uppercase leading-tight">Talukas</div>
              <div className="text-xs font-black text-blue-900 leading-tight mt-0.5">{totalStats.talukas}</div>
            </button>

            <button
              type="button"
              onClick={() => {
                setOnlyWithDealers(false);
                setViewFocus('villages');
              }}
              className={`rounded-lg px-2 py-1.5 text-center border transition cursor-pointer active:scale-95 ${
                viewFocus === 'villages' && !onlyWithDealers
                  ? 'bg-amber-600 text-white border-amber-600'
                  : 'bg-amber-50/70 border-amber-200/80 text-amber-900 hover:bg-amber-100/70'
              }`}
            >
              <div
                className={`text-[9px] font-bold uppercase leading-tight ${
                  viewFocus === 'villages' && !onlyWithDealers ? 'text-amber-100' : 'text-amber-700'
                }`}
              >
                Villages
              </div>
              <div className="text-xs font-black leading-tight mt-0.5">
                {totalStats.villages.toLocaleString('en-IN')}
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setOnlyWithDealers(true);
                setViewFocus('dealers');
              }}
              className={`rounded-lg px-2 py-1.5 text-center border transition cursor-pointer active:scale-95 ${
                viewFocus === 'dealers' || onlyWithDealers
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'bg-emerald-50/70 border-emerald-200/80 text-emerald-900 hover:bg-emerald-100/70'
              }`}
            >
              <div
                className={`text-[9px] font-bold uppercase leading-tight ${
                  viewFocus === 'dealers' || onlyWithDealers ? 'text-emerald-100' : 'text-emerald-700'
                }`}
              >
                Dealers
              </div>
              <div className="text-xs font-black leading-tight mt-0.5">{totalStats.dealers}</div>
            </button>
          </div>
        )}
      </div>

      {statusBanner && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl flex items-center justify-between animate-fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="font-bold">{statusBanner}</span>
          </div>
          <button type="button" onClick={() => setStatusBanner(null)} className="text-emerald-700 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Initial guidance before user selects Maharashtra, Karnataka, or All */}
      {!selectedState && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 text-center space-y-2 shadow-2xs">
          <MapPin className="w-7 h-7 text-orange-500 mx-auto" />
          <p className="text-xs font-bold text-slate-700">
            माहिती पाहण्यासाठी वरीलपैकी <span className="text-red-600">Maharashtra</span>,{' '}
            <span className="text-red-600">Karnataka</span> किंवा <span className="text-slate-900">All</span> निवडा.
          </p>
          <p className="text-[11px] font-medium text-slate-500">
            क्षेत्रातील स्थानिक डीलर नोंदवण्यासाठी <span className="font-bold text-slate-700">डीलर फॉर्म</span> वापरा.
          </p>
        </div>
      )}

      {/* Search & Hierarchy Filter Bar (Visible after State / All selected) */}
      {selectedState && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3.5 space-y-3">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3.5 top-3 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="गाव, तालुका, जिल्हा, पिनकोड किंवा डीलर शोधा..."
              className="w-full pl-10 pr-9 py-2.5 text-xs sm:text-sm rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 font-medium"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 cursor-pointer"
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
                <option value="all">सर्व जिल्हे (All {districtSummaries.length})</option>
                {districtSummaries.map((d) => (
                  <option key={`${d.stateCode}-${d.code}`} value={d.district}>
                    {d.label} — {d.villageCount.toLocaleString('en-IN')} गावे
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
                    ? 'प्रथम जिल्हा निवडा'
                    : `सर्व तालुके (${talukaSummaries.length})`}
                </option>
                {talukaSummaries.map((t) => (
                  <option key={`${t.code}-${t.taluka}`} value={t.taluka}>
                    {t.taluka} — {t.villageCount.toLocaleString('en-IN')} गावे
                    {t.dealerCount > 0 ? `, ${t.dealerCount} डीलर` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Quick Toggle Filter */}
            <div className="flex flex-col justify-end">
              <button
                type="button"
                onClick={() => {
                  setOnlyWithDealers((v) => {
                    const next = !v;
                    setViewFocus(next ? 'dealers' : 'overview');
                    return next;
                  });
                }}
                className={`w-full px-3 py-2 rounded-xl text-xs font-bold border flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  onlyWithDealers
                    ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <Filter className="w-3.5 h-3.5" />
                <span>{onlyWithDealers ? 'फक्त डीलर नोंदी (Active)' : 'फक्त डीलर नोंदी पहा'}</span>
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
                setOnlyWithDealers(false);
                setViewFocus('overview');
              }}
              className={`px-2 py-0.5 rounded-lg transition cursor-pointer ${
                selectedDistrict === 'all'
                  ? 'bg-orange-100 text-orange-800'
                  : 'hover:bg-slate-100 text-slate-700'
              }`}
            >
              {selectedState === 'all' ? 'All States' : selectedState}
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
                </button>
              </>
            )}

            {selectedTaluka !== 'all' && (
              <>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                <span className="px-2 py-0.5 rounded-lg bg-emerald-100 text-emerald-800">
                  {selectedTaluka}
                </span>
              </>
            )}

            {(selectedDistrict !== 'all' || searchQuery || onlyWithDealers || viewFocus !== 'overview') && (
              <button
                type="button"
                onClick={() => {
                  setSelectedDistrict('all');
                  setSelectedTaluka('all');
                  setSearchQuery('');
                  setOnlyWithDealers(false);
                  setViewFocus('overview');
                }}
                className="ml-auto text-[11px] text-red-600 hover:underline font-bold cursor-pointer"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      )}

      {/* DEDICATED DEALERS DIRECTORY PANEL (When user taps Dealers button / filter) */}
      {selectedState && (viewFocus === 'dealers' || onlyWithDealers) && (
        <div className="bg-white rounded-2xl border border-emerald-200 shadow-sm overflow-hidden">
          <div className="bg-emerald-900 text-white px-4 py-2.5 flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs font-black uppercase tracking-wide flex items-center gap-2">
              <Store className="w-4 h-4 text-emerald-300" />
              <span>लोकेशन डीलर नोंदी ({filteredLocationDealers.length})</span>
            </div>
            <button
              type="button"
              onClick={() => openDealerForm()}
              className="text-[11px] font-bold bg-white text-emerald-900 hover:bg-emerald-50 px-2.5 py-1 rounded-lg flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>नवीन डीलर जोडा</span>
            </button>
          </div>

          {filteredLocationDealers.length === 0 ? (
            <div className="p-6 text-center space-y-2.5">
              <Store className="w-7 h-7 text-slate-300 mx-auto" />
              <p className="text-xs font-bold text-slate-600">
                या निवडलेल्या भागात अद्याप डीलर नोंद नाही.
              </p>
              <button
                type="button"
                onClick={() => openDealerForm()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-xl shadow-xs cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>डीलर फॉर्म भरा</span>
              </button>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredLocationDealers.map((d, idx) => {
                const canModify = userIsAdmin || isUserRecord(d, profile);
                const officer = getOfficerLabel(d);
                return (
                  <div
                    key={d.id}
                    className="p-3 sm:p-3.5 hover:bg-emerald-50/40 transition flex items-start justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center flex-wrap gap-1.5">
                        <span className="text-[10px] font-mono font-black text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                          {idx + 1}.
                        </span>
                        <span className="text-xs sm:text-sm font-black text-slate-900">
                          {toTitleCase(d.firmName)}
                        </span>
                        {d.category && (
                          <span className="text-[10px] font-bold bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded">
                            {d.category}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-semibold text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        {d.proprietorName && (
                          <span className="inline-flex items-center gap-1">
                            <UserCheck className="w-3 h-3 text-slate-400" />
                            {toTitleCase(d.proprietorName)}
                          </span>
                        )}
                        {d.contactNumber && (
                          <span className="inline-flex items-center gap-1 font-mono text-slate-800">
                            <Phone className="w-3 h-3 text-emerald-700" />
                            {d.contactNumber}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-semibold text-slate-500">
                        {toTitleCase(d.village)} → {d.taluka} → {getDistrictDisplayLabel(d.district)} ({d.state})
                        {d.pinCode ? ` • ${d.pinCode}` : ''}
                        {officer ? ` • ${officer}` : ''}
                      </div>
                      {(d.address || d.notes) && (
                        <div className="text-[10px] text-slate-500">
                          {[d.address, d.notes].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </div>

                    {canModify && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => openDealerForm({ dealer: d })}
                          className="p-1.5 rounded-lg text-slate-500 hover:text-blue-600 hover:bg-blue-50 cursor-pointer"
                          title="Edit"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteLocationDealer(d)}
                          className="p-1.5 rounded-lg text-slate-500 hover:text-red-600 hover:bg-red-50 cursor-pointer"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* MODE A: DISTRICT DIRECTORY OVERVIEW */}
      {isDistrictOverviewMode && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3.5 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-orange-600" />
              <span>
                {selectedState === 'all' ? 'All' : selectedState} Districts ({districtSummaries.length}) — जिल्हा निवडा
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
                        #{String(idx + 1).padStart(2, '0')}
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
      {selectedState && selectedDistrict !== 'all' && selectedTaluka === 'all' && !searchQuery.trim() && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3.5 space-y-2.5">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider">
              {getDistrictDisplayLabel(selectedDistrict)} — Talukas ({talukaSummaries.length})
            </h3>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {talukaSummaries.map((t, idx) => (
              <button
                key={`${t.code}-${t.taluka}`}
                type="button"
                onClick={() => setSelectedTaluka(t.taluka)}
                className={`p-2 rounded-xl border transition text-left cursor-pointer active:scale-95 ${
                  t.dealerCount > 0
                    ? 'bg-blue-50/50 border-blue-200 hover:border-blue-400'
                    : 'bg-slate-50 border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[10px] font-mono font-bold text-slate-500">{idx + 1}.</span>
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
            ))}
          </div>
        </div>
      )}

      {/* VILLAGE -> LOCATION DEALERS LIST */}
      {selectedState && !isDistrictOverviewMode && viewFocus !== 'dealers' && !onlyWithDealers && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-slate-900 text-white px-4 py-2.5 flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs font-black uppercase tracking-wide flex items-center gap-2">
              <Users className="w-4 h-4 text-orange-400" />
              <span>Villages ({villageQueryResult.totalCount.toLocaleString('en-IN')})</span>
            </div>
          </div>

          {villageQueryResult.items.length === 0 ? (
            <div className="p-8 text-center space-y-2">
              <MapPin className="w-8 h-8 text-slate-300 mx-auto" />
              <div className="text-sm font-bold text-slate-700">
                या निवडलेल्या लोकेशनसाठी गावे सापडली नाहीत.
              </div>
            </div>
          ) : (
            <>
              <div className="divide-y divide-slate-100">
                {villageQueryResult.items.map((b, index) => (
                  <div
                    key={`${b.id}_${index}`}
                    className="p-3 sm:p-3.5 hover:bg-slate-50/80 transition flex flex-col sm:flex-row sm:items-start gap-3"
                  >
                    {/* Left: Serial + Village + Pincode + Hierarchy */}
                    <div className="sm:w-72 shrink-0 space-y-1">
                      <div className="flex items-center flex-wrap gap-1.5">
                        <span className="text-[11px] font-mono font-black text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                          {index + 1}.
                        </span>
                        <span className="text-sm font-black text-slate-900">
                          {toTitleCase(b.village)}
                        </span>
                        {b.pinCode && (
                          <span className="text-[10px] font-mono font-bold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">
                            {b.pinCode}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 font-semibold pl-7">
                        {b.taluka} → {getDistrictDisplayLabel(b.district)} ({b.state})
                      </div>
                    </div>

                    {/* Right: Recorded Location Dealers for this Village + Add Dealer button */}
                    <div className="flex-1 min-w-0 flex flex-wrap items-center justify-between gap-2">
                      {b.dealers.length === 0 ? (
                        <span className="text-[11px] text-slate-400 font-semibold italic">
                          अद्याप डीलर नोंद नाही
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {b.dealers.map((d) => {
                            const canModify = userIsAdmin || isUserRecord(d, profile);
                            const officer = getOfficerLabel(d);
                            return (
                              <div
                                key={d.id}
                                className="bg-emerald-50/70 border border-emerald-200 rounded-xl px-2.5 py-1.5 flex items-start gap-2 max-w-full"
                              >
                                <div className="min-w-0">
                                  <div className="text-xs font-black text-slate-900 flex items-center gap-1.5 flex-wrap">
                                    <span>{toTitleCase(d.firmName) || 'Unnamed Firm'}</span>
                                    {d.category && (
                                      <span className="text-[9px] font-bold bg-white text-emerald-800 border border-emerald-200 px-1 py-0.2 rounded">
                                        {d.category}
                                      </span>
                                    )}
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
                                {canModify && (
                                  <div className="flex items-center gap-0.5 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => openDealerForm({ dealer: d })}
                                      className="p-1 rounded text-slate-400 hover:text-blue-600 cursor-pointer"
                                      title="Edit"
                                    >
                                      <Edit3 className="w-3 h-3" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteLocationDealer(d)}
                                      className="p-1 rounded text-slate-400 hover:text-red-600 cursor-pointer"
                                      title="Delete"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() =>
                          openDealerForm({
                            state: b.state,
                            district: b.district,
                            taluka: b.taluka,
                            village: b.village,
                            villageCode: b.villageCode,
                            pinCode: b.pinCode,
                          })
                        }
                        className="text-[10px] font-bold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 px-2 py-1 rounded-lg inline-flex items-center gap-1 shrink-0 cursor-pointer"
                      >
                        <Plus className="w-3 h-3" />
                        <span>डीलर</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {villageQueryResult.items.length < villageQueryResult.totalCount && (
                <div className="p-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[11px] font-bold text-slate-600">
                    दाखवलेली गावे: {villageQueryResult.items.length} /{' '}
                    {villageQueryResult.totalCount.toLocaleString('en-IN')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setVisibleLimit((prev) => prev + PAGE_STEP)}
                    className="px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold shadow-xs cursor-pointer active:scale-95 transition"
                  >
                    पुढील {Math.min(PAGE_STEP, villageQueryResult.totalCount - villageQueryResult.items.length)}{' '}
                    गावे पहा
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* SEPARATE LOCATION DEALER FORM MODAL (NOT LINKED TO DEALER MANAGEMENT) */}
      {showDealerFormModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-5 space-y-4 border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-red-100 text-red-700 flex items-center justify-center shrink-0">
                  <Store className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900">
                    {editingDealerId ? 'डीलर नोंद अपडेट करा' : 'डीलर फॉर्म (Location Mapping)'}
                  </h3>
                  <p className="text-[11px] font-semibold text-slate-500">
                    त्या भागातील अचूक डीलर नोंद (Dealer Management पासून स्वतंत्र)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowDealerFormModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveLocationDealer} className="space-y-3">
              {/* Location Hierarchy */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    State (राज्य) *
                  </label>
                  <select
                    value={dealerStateInput}
                    onChange={(e) => {
                      const nextSt = e.target.value;
                      setDealerStateInput(nextSt);
                      const nextDists = getDistrictsForState(nextSt);
                      const firstDist = nextDists[0]?.name || '';
                      setDealerDistrictInput(firstDist);
                      const firstTal = getTalukaMetasForDistrict(firstDist, nextSt)[0]?.name || '';
                      setDealerTalukaInput(firstTal);
                      setDealerVillageInput('');
                      setDealerVillageCodeInput('');
                    }}
                    className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  >
                    {LGD_STATES.map((st) => (
                      <option key={st.code} value={st.name}>
                        {st.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    District (जिल्हा) *
                  </label>
                  <select
                    value={dealerDistrictInput}
                    onChange={(e) => {
                      const nextDist = e.target.value;
                      setDealerDistrictInput(nextDist);
                      const nextTals = getTalukaMetasForDistrict(nextDist, dealerStateInput).map(
                        (t) => t.name
                      );
                      setDealerTalukaInput(nextTals[0] || '');
                      setDealerVillageInput('');
                      setDealerVillageCodeInput('');
                    }}
                    required
                    className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  >
                    {formDistricts.map((d) => (
                      <option key={d.code} value={d.name}>
                        {getDistrictDisplayLabel(d.name)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Taluka (तालुका) *
                  </label>
                  {formTalukas.length > 0 ? (
                    <select
                      value={dealerTalukaInput}
                      onChange={(e) => {
                        setDealerTalukaInput(e.target.value);
                        setDealerVillageInput('');
                        setDealerVillageCodeInput('');
                      }}
                      required
                      className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                    >
                      <option value="">-- तालुका निवडा --</option>
                      {formTalukas.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={dealerTalukaInput}
                      onChange={(e) => setDealerTalukaInput(e.target.value)}
                      placeholder="तालुक्याचे नाव"
                      required
                      className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                    />
                  )}
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Village (गाव) *
                  </label>
                  <input
                    type="text"
                    list="location-dealer-villages-list"
                    value={dealerVillageInput}
                    onChange={(e) => handleDealerVillageChange(e.target.value)}
                    placeholder="गावाचे नाव लिहा किंवा निवडा"
                    required
                    className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                  <datalist id="location-dealer-villages-list">
                    {formOfficialVillages.map((v) => (
                      <option key={v.villageCode} value={v.villageName} />
                    ))}
                  </datalist>
                </div>
              </div>

              {/* Dealer Identity Details */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Firm / Shop Name (दुकानाचे नाव) *
                  </label>
                  <input
                    type="text"
                    value={dealerFirmNameInput}
                    onChange={(e) => setDealerFirmNameInput(e.target.value)}
                    placeholder="उदा. श्री कृषी सेवा केंद्र"
                    required
                    className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Proprietor / Contact Name (मालकाचे नाव)
                  </label>
                  <input
                    type="text"
                    value={dealerProprietorInput}
                    onChange={(e) => setDealerProprietorInput(e.target.value)}
                    placeholder="उदा. रमेश पाटील"
                    className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Mobile Number
                  </label>
                  <input
                    type="tel"
                    value={dealerMobileInput}
                    onChange={(e) =>
                      setDealerMobileInput(e.target.value.replace(/\D/g, '').slice(0, 10))
                    }
                    placeholder="10 अंकी नंबर"
                    className="w-full px-3 py-2 text-xs font-mono font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Pincode (पिनकोड)
                  </label>
                  <input
                    type="text"
                    value={dealerPinCodeInput}
                    onChange={(e) =>
                      setDealerPinCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))
                    }
                    placeholder="416405"
                    className="w-full px-3 py-2 text-xs font-mono font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Category (प्रकार)
                  </label>
                  <select
                    value={dealerCategoryInput}
                    onChange={(e) => setDealerCategoryInput(e.target.value)}
                    className="w-full px-2.5 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  >
                    {LOCATION_DEALER_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Address / Landmark (पत्ता / परिसर)
                </label>
                <input
                  type="text"
                  value={dealerAddressInput}
                  onChange={(e) => setDealerAddressInput(e.target.value)}
                  placeholder="मेन रोड / बाजारपेठ..."
                  className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Notes / Remark (नोंद / शेरा)
                </label>
                <textarea
                  rows={2}
                  value={dealerNotesInput}
                  onChange={(e) => setDealerNotesInput(e.target.value)}
                  placeholder="अतिरिक्त माहिती..."
                  className="w-full px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowDealerFormModal(false)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  रद्द करा
                </button>
                <button
                  type="submit"
                  disabled={isSavingDealer}
                  className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
                >
                  {isSavingDealer ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  <span>{isSavingDealer ? 'Saving...' : 'सेव्ह करा'}</span>
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
