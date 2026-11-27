import React, { useState, useMemo, useEffect } from 'react';
import {
  MapPin,
  Plus,
  Phone,
  X,
  CheckCircle2,
  Trash2,
  Loader2,
  Save,
  Edit3,
  Store,
  UserCheck,
  Check,
} from 'lucide-react';
import { UserProfile, isAdmin, isUserRecord } from '../../lib/auth';
import { Language } from '../../lib/i18n';
import { getRecordUpdateMs } from '../../lib/moduleUpdates';
import { useModuleRecordHighlights } from '../ModuleUpdateBanner';
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
  findOfficialLgdVillageSync,
  getOfficialVillagesByTalukaSync,
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

  const {
    unreadRecords: locationUnreadRecords,
    unreadById: locationUnreadById,
    markViewed: markLocationViewed,
    markManyViewed: markManyLocationViewed,
  } = useModuleRecordHighlights(profile, 'location', {
    locationDealers: rawLocationDealers,
    locationVillages,
    locationTalukas,
  });

  // Auto-mark background taluka/village directory items viewed so Location Master never leaves un-clearable ghost badges
  useEffect(() => {
    const metaUnread = locationUnreadRecords
      .filter((r) => r.subType === 'village' || r.subType === 'taluka')
      .map((r) => ({ id: r.id, ts: r.updatedAtMs }));
    if (metaUnread.length > 0) {
      markManyLocationViewed(metaUnread);
    }
  }, [locationUnreadRecords, markManyLocationViewed]);

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

  // Clean cascading dropdown selection states: State -> District -> Taluka -> Village -> Dealer
  const [selectedState, setSelectedState] = useState<string>('');
  const [selectedDistrict, setSelectedDistrict] = useState<string>('');
  const [selectedTaluka, setSelectedTaluka] = useState<string>('');
  const [selectedVillage, setSelectedVillage] = useState<string>('');
  const [selectedDealerId, setSelectedDealerId] = useState<string>('');

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

  const selectedStateMeta = useMemo(
    () => (!selectedState ? undefined : getStateMeta(selectedState)),
    [selectedState]
  );

  // Index Location Mapping Dealers onto villages for counts & row display
  const dealerMappingIndex = useMemo(() => {
    const dealersByVillageKey = new Map<string, LocationDealerItem[]>();
    const unmappedBuckets = new Map<string, VillageRow>();

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

  // Step 2: Districts for selected State
  const districtOptions = useMemo(() => {
    if (!selectedState) return [];
    return getDistrictsForState(selectedState).map((d) => ({
      code: d.code,
      stateCode: d.stateCode,
      stateName: d.stateName,
      district: d.name,
      label: getDistrictDisplayLabel(d.name),
    }));
  }, [selectedState]);

  const selectedDistrictMeta = useMemo(() => {
    if (!selectedDistrict) return undefined;
    return getDistrictMeta(selectedDistrict, selectedStateMeta?.code);
  }, [selectedDistrict, selectedStateMeta?.code]);

  // Step 3: Talukas for selected District
  const talukaOptions = useMemo(() => {
    if (!selectedState || !selectedDistrict) return [];
    const stCode = selectedDistrictMeta?.stateCode || selectedStateMeta?.code || '';
    const dName = selectedDistrictMeta?.name || canonicalizeDistrictName(selectedDistrict, selectedState);
    const officialTalukas = getTalukaMetasForDistrict(selectedDistrictMeta?.code || dName, stCode);

    const map = new Map<string, { code: string; taluka: string }>();

    officialTalukas.forEach((t) => {
      map.set(normalizeLocationKey(t.name), {
        code: t.code,
        taluka: t.name,
      });
    });

    locationTalukas.forEach((lt) => {
      if (lt.isArchived) return;
      if (normalizeLocationKey(lt.district) !== normalizeLocationKey(dName)) return;
      const tk = normalizeLocationKey(lt.taluka);
      if (!map.has(tk)) {
        map.set(tk, {
          code: lt.talukaCode,
          taluka: lt.taluka,
        });
      }
    });

    dealerMappingIndex.unmappedBuckets.forEach((ub) => {
      if (normalizeLocationKey(ub.district) !== normalizeLocationKey(dName)) return;
      const tk = normalizeLocationKey(ub.taluka);
      if (!map.has(tk)) {
        map.set(tk, {
          code: ub.talukaCode || '',
          taluka: ub.taluka,
        });
      }
    });

    return Array.from(map.values()).sort((a, b) => a.taluka.localeCompare(b.taluka));
  }, [
    selectedState,
    selectedDistrict,
    selectedDistrictMeta,
    selectedStateMeta?.code,
    locationTalukas,
    dealerMappingIndex,
  ]);

  const selectedTalukaMeta = useMemo(() => {
    if (!selectedTaluka || !selectedDistrict) return undefined;
    return getTalukaMeta(
      selectedDistrictMeta?.code || selectedDistrict,
      selectedTaluka,
      selectedDistrictMeta?.stateCode || selectedStateMeta?.code
    );
  }, [selectedTaluka, selectedDistrict, selectedDistrictMeta, selectedStateMeta?.code]);

  // Step 4: Villages for selected Taluka
  const villageOptions = useMemo(() => {
    if (!selectedState || !selectedDistrict || !selectedTaluka) return [] as VillageRow[];

    const stCode = selectedStateMeta?.code || '';
    const distName = selectedDistrictMeta?.name || selectedDistrict;
    const talName = selectedTalukaMeta?.name || selectedTaluka;

    const officialList =
      stCode && selectedTalukaMeta?.code
        ? getOfficialVillagesByTalukaSync(stCode, selectedTalukaMeta.code)
        : [];

    const rowsByKey = new Map<string, VillageRow>();

    officialList.forEach((ov) => {
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
        dealers: dealerMappingIndex.dealersByVillageKey.get(`code:${ov.villageCode}`) || [],
      };
      rowsByKey.set(normalizeLocationKey(ov.villageName), row);
    });

    const matchesScope = (row: VillageRow) =>
      (!stCode || row.stateCode === stCode) &&
      normalizeLocationKey(row.district) === normalizeLocationKey(distName) &&
      normalizeLocationKey(row.taluka) === normalizeLocationKey(talName);

    [...customVillageRows, ...dealerMappingIndex.unmappedBuckets]
      .filter(matchesScope)
      .forEach((extra) => {
        const vKey = normalizeLocationKey(extra.village);
        const existing = rowsByKey.get(vKey);
        if (existing) {
          if (extra.dealers.length > 0) {
            const existingIds = new Set(existing.dealers.map((d) => d.id));
            extra.dealers.forEach((d) => {
              if (!existingIds.has(d.id)) existing.dealers.push(d);
            });
          }
          if (!existing.pinCode && extra.pinCode) existing.pinCode = extra.pinCode;
        } else {
          rowsByKey.set(vKey, extra);
        }
      });

    return Array.from(rowsByKey.values()).sort((a, b) => a.village.localeCompare(b.village));
  }, [
    selectedState,
    selectedStateMeta?.code,
    selectedDistrict,
    selectedDistrictMeta?.name,
    selectedTaluka,
    selectedTalukaMeta,
    customVillageRows,
    dealerMappingIndex,
    lgdRevision,
  ]);

  const selectedVillageObj = useMemo(
    () => villageOptions.find((v) => v.id === selectedVillage),
    [villageOptions, selectedVillage]
  );

  // Step 5: Dealers for selected Village
  const dealersForSelectedVillage = useMemo(
    () => (selectedVillageObj ? selectedVillageObj.dealers : []),
    [selectedVillageObj]
  );

  const selectedDealerObj = useMemo(
    () => dealersForSelectedVillage.find((d) => d.id === selectedDealerId),
    [dealersForSelectedVillage, selectedDealerId]
  );

  // Track which states/districts/talukas have unread location_dealers so dropdowns guide the user without a banner
  const unreadHierarchy = useMemo(() => {
    const states = new Set<string>();
    const districts = new Set<string>();
    const talukas = new Set<string>();
    if (locationUnreadById.size === 0) return { states, districts, talukas };

    locationDealers.forEach((d) => {
      if (!locationUnreadById.has(d.id)) return;
      const stMeta = getStateMeta(d.stateCode || d.state || resolveStateFromDistrict(d.district) || DEFAULT_STATE);
      const stName = stMeta?.name || normalizeStateName(d.state || DEFAULT_STATE);
      const dMeta = getDistrictMeta(d.districtCode || d.district, stMeta?.code);
      const dName = dMeta?.name || canonicalizeDistrictName(d.district || '', stName);
      const tMeta = getTalukaMeta(dMeta?.code || dName, d.talukaCode || d.taluka, stMeta?.code);
      const tName = tMeta?.name || canonicalizeTalukaName(dName, d.taluka || '', stName) || d.taluka || '';
      if (stName) states.add(normalizeLocationKey(stName));
      if (dName) districts.add(normalizeLocationKey(dName));
      if (dName && tName) talukas.add(`${normalizeLocationKey(dName)}|${normalizeLocationKey(tName)}`);
    });
    return { states, districts, talukas };
  }, [locationDealers, locationUnreadById]);

  // Mark unread dealers visible in the current selected village card as viewed after brief inspection
  useEffect(() => {
    if (!selectedVillageObj || dealersForSelectedVillage.length === 0) return;
    const targetList = selectedDealerObj ? [selectedDealerObj] : dealersForSelectedVillage;
    const toMark = targetList
      .map((d) => {
        const meta = locationUnreadById.get(d.id);
        return meta ? { id: d.id, ts: meta.updatedAtMs } : null;
      })
      .filter((x): x is { id: string; ts: number } => Boolean(x));
    if (toMark.length === 0) return;
    const timer = window.setTimeout(() => {
      markManyLocationViewed(toMark);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [selectedVillageObj, selectedDealerObj, dealersForSelectedVillage, locationUnreadById, markManyLocationViewed]);

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
    if (!stMeta?.code || !tMeta?.code) return [];
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
      markLocationViewed(existing.id, getRecordUpdateMs(existing));
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

    const activeState = preset?.state || selectedState || DEFAULT_STATE;
    const stateDists = getDistrictsForState(activeState);
    const dist =
      preset?.district
        ? canonicalizeDistrictName(preset.district, activeState)
        : selectedDistrict
          ? canonicalizeDistrictName(selectedDistrict, activeState)
          : stateDists[0]?.name || 'Sangli';
    const talList = getTalukaMetasForDistrict(dist, activeState).map((t) => t.name);
    const tal =
      preset?.taluka
        ? canonicalizeTalukaName(dist, preset.taluka, activeState)
        : selectedTaluka
          ? canonicalizeTalukaName(dist, selectedTaluka, activeState)
          : talList[0] || '';

    setEditingDealerId(null);
    setDealerStateInput(activeState);
    setDealerDistrictInput(dist);
    setDealerTalukaInput(tal);
    setDealerVillageInput(preset?.village ?? selectedVillageObj?.village ?? '');
    setDealerVillageCodeInput(preset?.villageCode ?? selectedVillageObj?.villageCode ?? '');
    setDealerPinCodeInput(preset?.pinCode ?? selectedVillageObj?.pinCode ?? '');
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

  const resolveVillageRowIdForDealer = (dealer: {
    stateCode?: string;
    state?: string;
    districtCode?: string;
    district: string;
    talukaCode?: string;
    taluka: string;
    villageCode?: string;
    village: string;
  }) => {
    const stMeta = getStateMeta(dealer.stateCode || dealer.state || resolveStateFromDistrict(dealer.district) || DEFAULT_STATE);
    const stCode = stMeta?.code || '';
    const stName = stMeta?.name || DEFAULT_STATE;
    const dMeta = getDistrictMeta(dealer.districtCode || dealer.district, stCode);
    const dName = dMeta?.name || canonicalizeDistrictName(dealer.district || '', stName);
    const tMeta = getTalukaMeta(dMeta?.code || dName, dealer.talukaCode || dealer.taluka, stCode);
    const tName = tMeta?.name || canonicalizeTalukaName(dName, dealer.taluka || '', stName) || dealer.taluka;

    const officialHit = findOfficialLgdVillageSync({
      stateCode: stCode,
      talukaCode: tMeta?.code,
      villageCode: dealer.villageCode,
      villageName: dealer.village,
    });
    if (officialHit) {
      return {
        state: stName,
        district: dName,
        taluka: tName,
        villageId: `v_${officialHit.villageCode}`,
      };
    }

    const customMatch = customVillageRows.find(
      (cv) =>
        (!stCode || cv.stateCode === stCode) &&
        normalizeLocationKey(cv.district) === normalizeLocationKey(dName) &&
        normalizeLocationKey(cv.taluka) === normalizeLocationKey(tName) &&
        normalizeLocationKey(cv.village) === normalizeLocationKey(dealer.village)
    );
    if (customMatch) {
      return {
        state: stName,
        district: dName,
        taluka: tName,
        villageId: customMatch.id,
      };
    }

    const customKey = `${stCode || normalizeLocationKey(stName)}|${normalizeLocationKey(dName)}|${normalizeLocationKey(tName)}|${normalizeLocationKey(dealer.village)}`;
    return {
      state: stName,
      district: dName,
      taluka: tName,
      villageId: `loc_dealer_bucket_${customKey}`,
    };
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
      markLocationViewed(record.id);
      await safeFirestoreSet('location_dealers', record.id, record, { merge: true });
      void logAudit(
        existing ? 'UPDATE' : 'CREATE',
        'location_dealers',
        record.id,
        `Location Mapping Dealer: ${record.firmName} (${record.village}, ${record.taluka}, ${record.district})`,
        profile
      ).catch(() => {});

      const resolved = resolveVillageRowIdForDealer(record);
      setSelectedState(resolved.state);
      setSelectedDistrict(resolved.district);
      setSelectedTaluka(resolved.taluka);
      setSelectedVillage(resolved.villageId);
      setSelectedDealerId(record.id);

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
        if (selectedDealerId === dealer.id) {
          setSelectedDealerId('');
        }
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

  const renderDealerCard = (d: LocationDealerItem) => {
    const canModify = userIsAdmin || isUserRecord(d, profile);
    const officer = getOfficerLabel(d);
    const unreadMeta = locationUnreadById.get(d.id);
    return (
      <div
        key={d.id}
        className={`p-3.5 rounded-xl border transition flex items-start justify-between gap-3 ${
          unreadMeta
            ? 'bg-amber-50/75 border-amber-200'
            : 'bg-emerald-50/50 border-emerald-200'
        }`}
      >
        <div className="min-w-0 space-y-1">
          <div className="flex items-center flex-wrap gap-1.5">
            <span className="text-xs sm:text-sm font-black text-slate-900">
              {toTitleCase(d.firmName) || 'Unnamed Firm'}
            </span>
            {d.category && (
              <span className="text-[10px] font-bold bg-white text-emerald-800 border border-emerald-200 px-1.5 py-0.5 rounded">
                {d.category}
              </span>
            )}
          </div>
          <div className="text-[11px] font-semibold text-slate-700 flex flex-wrap items-center gap-x-3 gap-y-0.5">
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
          {unreadMeta && (
            <div className="text-[10px] font-bold text-amber-800">
              {unreadMeta.actorName} · {unreadMeta.actionLabel}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {unreadMeta && (
            <button
              type="button"
              onClick={() => markLocationViewed(d.id, unreadMeta.updatedAtMs)}
              className="inline-flex items-center gap-0.5 px-2 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 text-[10px] font-bold transition whitespace-nowrap cursor-pointer"
              title="पाहिले (Mark Viewed)"
            >
              <Check className="w-3 h-3" />
              <span>पाहिले</span>
            </button>
          )}
          {canModify && (
            <>
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
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3 pb-24">
      {/* Clean Header & Cascading Dropdowns: State -> District -> Taluka -> Village -> Dealer */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center shrink-0">
              <MapPin className="w-4 h-4" />
            </div>
            <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
              Location Master
            </h2>
            {loadingDirectory && (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-orange-600" />
            )}
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

        {/* Cascading Dropdown Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {/* 1. State Dropdown (Maharashtra / Karnataka) */}
          <div>
            <label className="block text-[11px] font-black text-slate-600 uppercase mb-1">
              State (राज्य)
            </label>
            <select
              value={selectedState}
              onChange={(e) => {
                setSelectedState(e.target.value);
                setSelectedDistrict('');
                setSelectedTaluka('');
                setSelectedVillage('');
                setSelectedDealerId('');
              }}
              className="w-full px-3 py-2.5 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
            >
              <option value="">-- राज्य निवडा --</option>
              {LGD_STATES.map((st) => (
                <option key={st.code} value={st.name}>
                  {st.name}
                  {unreadHierarchy.states.has(normalizeLocationKey(st.name)) ? ' • नवीन' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* 2. District Dropdown (Shown after State selected) */}
          {selectedState && (
            <div>
              <label className="block text-[11px] font-black text-slate-600 uppercase mb-1">
                District (जिल्हा)
              </label>
              <select
                value={selectedDistrict}
                onChange={(e) => {
                  setSelectedDistrict(e.target.value);
                  setSelectedTaluka('');
                  setSelectedVillage('');
                  setSelectedDealerId('');
                }}
                className="w-full px-3 py-2.5 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
              >
                <option value="">-- जिल्हा निवडा --</option>
                {districtOptions.map((d) => (
                  <option key={`${d.stateCode}-${d.code}`} value={d.district}>
                    {d.label}
                    {unreadHierarchy.districts.has(normalizeLocationKey(d.district)) ? ' • नवीन' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 3. Taluka Dropdown (Shown after District selected) */}
          {selectedState && selectedDistrict && (
            <div>
              <label className="block text-[11px] font-black text-slate-600 uppercase mb-1">
                Taluka (तालुका)
              </label>
              <select
                value={selectedTaluka}
                onChange={(e) => {
                  setSelectedTaluka(e.target.value);
                  setSelectedVillage('');
                  setSelectedDealerId('');
                }}
                className="w-full px-3 py-2.5 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
              >
                <option value="">-- तालुका निवडा --</option>
                {talukaOptions.map((t) => {
                  const dKey = normalizeLocationKey(selectedDistrictMeta?.name || selectedDistrict);
                  const hasUnread = unreadHierarchy.talukas.has(`${dKey}|${normalizeLocationKey(t.taluka)}`);
                  return (
                    <option key={`${t.code}-${t.taluka}`} value={t.taluka}>
                      {t.taluka}
                      {hasUnread ? ' • नवीन' : ''}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {/* 4. Village Dropdown (Shown after Taluka selected) */}
          {selectedState && selectedDistrict && selectedTaluka && (
            <div>
              <label className="block text-[11px] font-black text-slate-600 uppercase mb-1">
                Village (गाव)
              </label>
              <select
                value={selectedVillage}
                onChange={(e) => {
                  setSelectedVillage(e.target.value);
                  setSelectedDealerId('');
                }}
                className="w-full px-3 py-2.5 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
              >
                <option value="">-- गाव निवडा --</option>
                {villageOptions.map((v) => {
                  const hasUnread = v.dealers.some((d) => locationUnreadById.has(d.id));
                  return (
                    <option key={v.id} value={v.id}>
                      {toTitleCase(v.village)}
                      {v.pinCode ? ` (${v.pinCode})` : ''}
                      {v.dealers.length > 0 ? ` • ${v.dealers.length} डीलर` : ''}
                      {hasUnread ? ' • नवीन' : ''}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {/* 5. Dealer Dropdown (Shown after Village selected) */}
          {selectedState && selectedDistrict && selectedTaluka && selectedVillageObj && (
            <div>
              <label className="block text-[11px] font-black text-slate-600 uppercase mb-1">
                Dealer (डीलर)
              </label>
              <select
                value={selectedDealerId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedDealerId(id);
                  if (id) {
                    const meta = locationUnreadById.get(id);
                    if (meta) markLocationViewed(id, meta.updatedAtMs);
                  }
                }}
                className="w-full px-3 py-2.5 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
              >
                <option value="">
                  {dealersForSelectedVillage.length > 0
                    ? `-- डीलर निवडा (${dealersForSelectedVillage.length}) --`
                    : '-- डीलर नोंद नाही --'}
                </option>
                {dealersForSelectedVillage.map((d) => (
                  <option key={d.id} value={d.id}>
                    {toTitleCase(d.firmName) || 'Unnamed Firm'}
                    {d.contactNumber ? ` (${d.contactNumber})` : ''}
                    {locationUnreadById.has(d.id) ? ' • नवीन' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
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

      {/* Selected Village & Dealer Details Section */}
      {selectedVillageObj && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="bg-slate-900 text-white px-4 py-2.5 flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs font-black tracking-wide flex items-center gap-2 flex-wrap">
              <Store className="w-4 h-4 text-orange-400 shrink-0" />
              <span>{toTitleCase(selectedVillageObj.village)}</span>
              {selectedVillageObj.pinCode && (
                <span className="text-[10px] font-mono bg-slate-800 text-blue-300 px-1.5 py-0.5 rounded">
                  {selectedVillageObj.pinCode}
                </span>
              )}
              <span className="text-[11px] font-semibold text-slate-300">
                • {selectedVillageObj.taluka} → {getDistrictDisplayLabel(selectedVillageObj.district)} ({selectedVillageObj.state})
              </span>
            </div>

            <button
              type="button"
              onClick={() =>
                openDealerForm({
                  state: selectedVillageObj.state,
                  district: selectedVillageObj.district,
                  taluka: selectedVillageObj.taluka,
                  village: selectedVillageObj.village,
                  villageCode: selectedVillageObj.villageCode,
                  pinCode: selectedVillageObj.pinCode,
                })
              }
              className="text-[11px] font-bold bg-red-600 hover:bg-red-700 text-white px-2.5 py-1 rounded-lg flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>नवीन डीलर जोडा</span>
            </button>
          </div>

          <div className="p-3.5 space-y-2.5">
            {dealersForSelectedVillage.length === 0 ? (
              <div className="py-5 text-center space-y-2.5">
                <Store className="w-7 h-7 text-slate-300 mx-auto" />
                <p className="text-xs font-bold text-slate-600">
                  या गावात अद्याप डीलर नोंद नाही.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    openDealerForm({
                      state: selectedVillageObj.state,
                      district: selectedVillageObj.district,
                      taluka: selectedVillageObj.taluka,
                      village: selectedVillageObj.village,
                      villageCode: selectedVillageObj.villageCode,
                      pinCode: selectedVillageObj.pinCode,
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-xl shadow-xs cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>डीलर फॉर्म भरा</span>
                </button>
              </div>
            ) : selectedDealerObj ? (
              renderDealerCard(selectedDealerObj)
            ) : (
              <div className="space-y-2.5">
                {dealersForSelectedVillage.map((d) => renderDealerCard(d))}
              </div>
            )}
          </div>
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
