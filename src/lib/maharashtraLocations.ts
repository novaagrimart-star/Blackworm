import {
  LGD_DISTRICTS,
  LGD_STATES,
  LGD_TALUKAS,
  LgdDistrict,
  LgdState,
  LgdTaluka,
} from './lgdHierarchyIndex';

export const DEFAULT_STATE = 'Maharashtra';

export type { LgdState, LgdDistrict, LgdTaluka };
export { LGD_STATES, LGD_DISTRICTS, LGD_TALUKAS };

export const SUPPORTED_STATE_NAMES = LGD_STATES.map((s) => s.name);

export const MAHARASHTRA_DISTRICTS: string[] = LGD_DISTRICTS.filter(
  (d) => d.stateCode === '27'
)
  .map((d) => d.name)
  .sort((a, b) => a.localeCompare(b));

export const KARNATAKA_DISTRICTS: string[] = LGD_DISTRICTS.filter(
  (d) => d.stateCode === '29'
)
  .map((d) => d.name)
  .sort((a, b) => a.localeCompare(b));

const DISTRICT_DISPLAY_SYNONYMS: Record<string, string> = {
  'Ahilyanagar': 'Ahilyanagar (Ahmednagar)',
  'Chhatrapati Sambhajinagar': 'Chhatrapati Sambhajinagar (Aurangabad)',
  'Dharashiv': 'Dharashiv (Osmanabad)',
  'Bengaluru South': 'Bengaluru South (Ramanagara)',
  'Belagavi': 'Belagavi (Belgaum)',
  'Vijayapura': 'Vijayapura (Bijapur)',
  'Kalaburagi': 'Kalaburagi (Gulbarga)',
  'Mysuru': 'Mysuru (Mysore)',
  'Ballari': 'Ballari (Bellary)',
  'Shivamogga': 'Shivamogga (Shimoga)',
  'Tumakuru': 'Tumakuru (Tumkur)',
};

const STATE_ALIAS_MAP: Record<string, string> = {
  maharashtra: 'Maharashtra',
  maharastra: 'Maharashtra',
  mh: 'Maharashtra',
  '27': 'Maharashtra',
  karnataka: 'Karnataka',
  karnatak: 'Karnataka',
  ka: 'Karnataka',
  kar: 'Karnataka',
  '29': 'Karnataka',
};

const DISTRICT_ALIAS_MAP: Record<string, { stateCode: string; districtName: string }> = {
  // Maharashtra legacy aliases -> Official LGD names
  ahmednagar: { stateCode: '27', districtName: 'Ahilyanagar' },
  ahmadnagar: { stateCode: '27', districtName: 'Ahilyanagar' },
  ahilyanagar: { stateCode: '27', districtName: 'Ahilyanagar' },
  aurangabad: { stateCode: '27', districtName: 'Chhatrapati Sambhajinagar' },
  sambhajinagar: { stateCode: '27', districtName: 'Chhatrapati Sambhajinagar' },
  chhatrapatisambhajinagar: { stateCode: '27', districtName: 'Chhatrapati Sambhajinagar' },
  osmanabad: { stateCode: '27', districtName: 'Dharashiv' },
  dharashiv: { stateCode: '27', districtName: 'Dharashiv' },
  mumbaicity: { stateCode: '27', districtName: 'Mumbai' },
  mumbai: { stateCode: '27', districtName: 'Mumbai' },
  bid: { stateCode: '27', districtName: 'Beed' },
  gondiya: { stateCode: '27', districtName: 'Gondia' },
  buldana: { stateCode: '27', districtName: 'Buldhana' },
  raigarh: { stateCode: '27', districtName: 'Raigad' },
  // Karnataka legacy aliases -> Official LGD names
  bagalkot: { stateCode: '29', districtName: 'Bagalkote' },
  belgaum: { stateCode: '29', districtName: 'Belagavi' },
  bellary: { stateCode: '29', districtName: 'Ballari' },
  bijapur: { stateCode: '29', districtName: 'Vijayapura' },
  gulbarga: { stateCode: '29', districtName: 'Kalaburagi' },
  mysore: { stateCode: '29', districtName: 'Mysuru' },
  shimoga: { stateCode: '29', districtName: 'Shivamogga' },
  tumkur: { stateCode: '29', districtName: 'Tumakuru' },
  bangalore: { stateCode: '29', districtName: 'Bengaluru Urban' },
  bangaloreurban: { stateCode: '29', districtName: 'Bengaluru Urban' },
  bangalorerural: { stateCode: '29', districtName: 'Bengaluru Rural' },
  ramanagara: { stateCode: '29', districtName: 'Bengaluru South' },
  ramanagar: { stateCode: '29', districtName: 'Bengaluru South' },
  chikmagalur: { stateCode: '29', districtName: 'Chikkamagaluru' },
  chikballapur: { stateCode: '29', districtName: 'Chikkaballapura' },
  chamarajnagar: { stateCode: '29', districtName: 'Chamarajanagar' },
  davangere: { stateCode: '29', districtName: 'Davanagere' },
  mangalore: { stateCode: '29', districtName: 'Dakshina Kannada' },
  karwar: { stateCode: '29', districtName: 'Uttara Kannada' },
  madikeri: { stateCode: '29', districtName: 'Kodagu' },
  hospet: { stateCode: '29', districtName: 'Vijayanagara' },
};

const TALUKA_ALIAS_KEYWORDS: Array<{ districtName?: string; keyword: string; canonical: string }> = [
  { districtName: 'Sangli', keyword: 'islampur', canonical: 'Walwa' },
  { districtName: 'Sangli', keyword: 'walwa', canonical: 'Walwa' },
  { districtName: 'Sangli', keyword: 'vita', canonical: 'Khanapur' },
  { districtName: 'Sangli', keyword: 'khanapur', canonical: 'Khanapur' },
  { districtName: 'Sangli', keyword: 'kavathemahankal', canonical: 'Kavathemahankal' },
  { districtName: 'Sangli', keyword: 'kavthemankal', canonical: 'Kavathemahankal' },
  { districtName: 'Sangli', keyword: 'kavathemahakal', canonical: 'Kavathemahankal' },
  { districtName: 'Sangli', keyword: 'mhaisal', canonical: 'Miraj' },
  { districtName: 'Sangli', keyword: 'jath', canonical: 'Jat' },
  { districtName: 'Satara', keyword: 'vaduj', canonical: 'Khatav' },
  { districtName: 'Satara', keyword: 'dahiwadi', canonical: 'Man' },
  { districtName: 'Satara', keyword: 'medha', canonical: 'Jaoli' },
  { districtName: 'Satara', keyword: 'jawali', canonical: 'Jaoli' },
  { districtName: 'Pune', keyword: 'rajgurunagar', canonical: 'Khed' },
  { districtName: 'Pune', keyword: 'narayangaon', canonical: 'Junnar' },
  { districtName: 'Pune', keyword: 'velhe', canonical: 'Velhe' },
  { districtName: 'Kolhapur', keyword: 'ichalkaranji', canonical: 'Hatkanangle' },
  { districtName: 'Kolhapur', keyword: 'jaysingpur', canonical: 'Shirol' },
  { districtName: 'Kolhapur', keyword: 'ajra', canonical: 'Ajra' },
  { districtName: 'Solapur', keyword: 'akluj', canonical: 'Malshiras' },
  { districtName: 'Solapur', keyword: 'sangola', canonical: 'Sangole' },
  { districtName: 'Solapur', keyword: 'mangalwedha', canonical: 'Mangalvedhe' },
  { districtName: 'Dharashiv', keyword: 'osmanabad', canonical: 'Dharashiv' },
  { districtName: 'Dharashiv', keyword: 'omerga', canonical: 'Omarga' },
  { districtName: 'Nashik', keyword: 'satana', canonical: 'Baglan' },
  { districtName: 'Chhatrapati Sambhajinagar', keyword: 'aurangabad', canonical: 'Chhatrapati Sambhajinagar' },
  { districtName: 'Belagavi', keyword: 'belgaum', canonical: 'Belagavi' },
  { districtName: 'Belagavi', keyword: 'gokak', canonical: 'Gokak' },
  { districtName: 'Belagavi', keyword: 'chikodi', canonical: 'Chikkodi' },
  { districtName: 'Belagavi', keyword: 'nipani', canonical: 'Nippani' },
  { districtName: 'Vijayapura', keyword: 'bijapur', canonical: 'Vijayapura' },
  { districtName: 'Kalaburagi', keyword: 'gulbarga', canonical: 'Kalaburagi' },
  { districtName: 'Mysuru', keyword: 'mysore', canonical: 'Mysuru' },
  { districtName: 'Ballari', keyword: 'bellary', canonical: 'Ballari' },
  { districtName: 'Tumakuru', keyword: 'tumkur', canonical: 'Tumakuru' },
  { districtName: 'Shivamogga', keyword: 'shimoga', canonical: 'Shivamogga' },
];

export function normalizeLocationKey(val: any): string {
  if (!val) return '';
  return String(val)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeStateName(val: any): string {
  const key = normalizeLocationKey(val);
  if (!key) return DEFAULT_STATE;
  if (STATE_ALIAS_MAP[key]) return STATE_ALIAS_MAP[key];
  return String(val).trim();
}

export function getStateMeta(stateNameOrCode?: any): LgdState | undefined {
  if (!stateNameOrCode) return LGD_STATES[0];
  const raw = String(stateNameOrCode).trim();
  const key = normalizeLocationKey(raw);
  const resolvedName = STATE_ALIAS_MAP[key] || raw;
  return (
    LGD_STATES.find(
      (s) => s.code === raw || normalizeLocationKey(s.name) === normalizeLocationKey(resolvedName)
    ) || undefined
  );
}

export function resolveStateFromDistrict(rawDistrict: any): string | undefined {
  const canon = canonicalizeDistrictName(rawDistrict);
  const dObj = getDistrictMeta(canon);
  return dObj?.stateName;
}

export function canonicalizeDistrictName(rawDistrict: any, rawState?: any): string {
  const raw = String(rawDistrict || '').trim();
  if (!raw) return '';
  const key = normalizeLocationKey(raw);
  const alias = DISTRICT_ALIAS_MAP[key];
  if (alias) return alias.districtName;

  const stateMeta = rawState ? getStateMeta(rawState) : undefined;
  const scoped = stateMeta
    ? LGD_DISTRICTS.filter((d) => d.stateCode === stateMeta.code)
    : LGD_DISTRICTS;

  const exact = scoped.find(
    (d) => d.code === raw || normalizeLocationKey(d.name) === key
  );
  if (exact) return exact.name;

  // Fallback across both states if rawState omitted or mismatched
  const anyMatch = LGD_DISTRICTS.find(
    (d) => d.code === raw || normalizeLocationKey(d.name) === key
  );
  if (anyMatch) return anyMatch.name;

  return raw;
}

export function getDistrictMeta(districtNameOrCode: any, stateNameOrCode?: any): LgdDistrict | undefined {
  const raw = String(districtNameOrCode || '').trim();
  if (!raw) return undefined;
  const stateMeta = stateNameOrCode ? getStateMeta(stateNameOrCode) : undefined;
  const canonName = canonicalizeDistrictName(raw, stateNameOrCode);
  const key = normalizeLocationKey(canonName);

  const pool = stateMeta
    ? LGD_DISTRICTS.filter((d) => d.stateCode === stateMeta.code)
    : LGD_DISTRICTS;

  return (
    pool.find((d) => d.code === raw || normalizeLocationKey(d.name) === key) ||
    LGD_DISTRICTS.find((d) => d.code === raw || normalizeLocationKey(d.name) === key)
  );
}

export function getDistrictsForState(stateNameOrCode?: any): LgdDistrict[] {
  if (!stateNameOrCode || stateNameOrCode === 'all') return LGD_DISTRICTS;
  const st = getStateMeta(stateNameOrCode);
  if (!st) return [];
  return LGD_DISTRICTS.filter((d) => d.stateCode === st.code).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

export function getDistrictDisplayLabel(districtNameOrCode: string): string {
  const meta = getDistrictMeta(districtNameOrCode);
  const name = meta?.name || districtNameOrCode;
  return DISTRICT_DISPLAY_SYNONYMS[name] || name;
}

export function getTalukaMetasForDistrict(districtNameOrCode: any, stateNameOrCode?: any): LgdTaluka[] {
  const dMeta = getDistrictMeta(districtNameOrCode, stateNameOrCode);
  if (!dMeta) return [];
  return LGD_TALUKAS.filter((t) => t.districtCode === dMeta.code).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

export function getTalukasForDistrict(rawDistrict: any, rawState?: any): string[] {
  return getTalukaMetasForDistrict(rawDistrict, rawState).map((t) => t.name);
}

export function getTalukaMeta(
  districtNameOrCode: any,
  talukaNameOrCode: any,
  stateNameOrCode?: any
): LgdTaluka | undefined {
  const rawTal = String(talukaNameOrCode || '').trim();
  if (!rawTal) return undefined;
  const tals = getTalukaMetasForDistrict(districtNameOrCode, stateNameOrCode);
  if (tals.length === 0) return undefined;

  const exactByCode = tals.find((t) => t.code === rawTal);
  if (exactByCode) return exactByCode;

  const canonName = canonicalizeTalukaName(districtNameOrCode, rawTal, stateNameOrCode);
  const key = normalizeLocationKey(canonName);
  return tals.find((t) => normalizeLocationKey(t.name) === key);
}

export function canonicalizeTalukaName(rawDistrict: any, rawTaluka: any, rawState?: any): string {
  const tal = String(rawTaluka || '').trim();
  if (!tal) return '';
  const dMeta = getDistrictMeta(rawDistrict, rawState);
  const districtTalukas = dMeta ? getTalukaMetasForDistrict(dMeta.code) : [];
  const key = normalizeLocationKey(tal);
  const baseKey = normalizeLocationKey(tal.replace(/\(.*?\)/g, ''));

  const exact = districtTalukas.find(
    (t) =>
      t.code === tal ||
      normalizeLocationKey(t.name) === key ||
      (baseKey && normalizeLocationKey(t.name) === baseKey)
  );
  if (exact) return exact.name;

  const alias = TALUKA_ALIAS_KEYWORDS.find(
    (a) =>
      (!a.districtName || a.districtName === dMeta?.name) &&
      (a.keyword === key || a.keyword === baseKey)
  );
  if (alias) return alias.canonical;

  const partial = districtTalukas.find((t) => {
    const tk = normalizeLocationKey(t.name);
    return (tk.length >= 4 && key.includes(tk)) || (baseKey.length >= 4 && tk.includes(baseKey));
  });
  if (partial) return partial.name;

  return tal;
}

/**
 * Infers Taluka for legacy dealers that only have (district, village, center) without an explicit taluka.
 */
export function inferTalukaFromLocation(
  rawDistrict: any,
  rawVillage: any,
  rawCenter?: any,
  rawState?: any
): string {
  const dMeta = getDistrictMeta(rawDistrict, rawState);
  if (!dMeta) return '';
  const districtTalukas = getTalukaMetasForDistrict(dMeta.code);
  if (districtTalukas.length === 0) return '';

  const candidates = [rawVillage, rawCenter]
    .map((c) => normalizeLocationKey(c))
    .filter(Boolean);

  for (const ck of candidates) {
    const alias = TALUKA_ALIAS_KEYWORDS.find(
      (a) =>
        (!a.districtName || a.districtName === dMeta.name) &&
        (a.keyword === ck || ck.includes(a.keyword))
    );
    if (alias) return alias.canonical;

    const matched = districtTalukas.find((t) => {
      const tk = normalizeLocationKey(t.name);
      return tk === ck || (tk.length >= 4 && ck.includes(tk));
    });
    if (matched) return matched.name;
  }

  return '';
}

export function getLocationVillageDocId(
  stateRaw: any,
  districtRaw: any,
  talukaRaw: any,
  villageRaw: any,
  villageCodeRaw?: any
): string {
  const vc = String(villageCodeRaw || '').trim();
  if (vc) {
    return `lgd_v_${vc.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  }
  const s = normalizeLocationKey(normalizeStateName(stateRaw)) || 'maharashtra';
  const d = normalizeLocationKey(canonicalizeDistrictName(districtRaw, stateRaw)) || 'general';
  const t = normalizeLocationKey(canonicalizeTalukaName(districtRaw, talukaRaw, stateRaw)) || 'other';
  const v = normalizeLocationKey(villageRaw) || 'unknown';
  return `loc_${s}_${d}_${t}_${v}`;
}

export function getLocationTalukaDocId(
  stateRaw: any,
  districtRaw: any,
  talukaRaw: any,
  talukaCodeRaw?: any
): string {
  const tc = String(talukaCodeRaw || '').trim();
  if (tc) {
    return `lgd_t_${tc.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  }
  const s = normalizeLocationKey(normalizeStateName(stateRaw)) || 'maharashtra';
  const d = normalizeLocationKey(canonicalizeDistrictName(districtRaw, stateRaw)) || 'general';
  const t = normalizeLocationKey(talukaRaw) || 'unknown';
  return `tal_${s}_${d}_${t}`;
}

export interface LocationVillageItem {
  id: string;
  state: string;
  stateCode?: string;
  district: string;
  districtCode?: string;
  taluka: string;
  talukaCode?: string;
  village: string;
  villageCode?: string;
  pinCode?: string;
  isCustom?: boolean;
  createdAt?: string;
  updatedAt?: string;
  createdByUid?: string;
  createdByName?: string;
  updatedByUid?: string;
  updatedByName?: string;
  isArchived?: boolean;
}

export interface LocationTalukaItem {
  id: string;
  state: string;
  stateCode?: string;
  district: string;
  districtCode?: string;
  taluka: string;
  talukaCode: string;
  createdAt?: string;
  updatedAt?: string;
  createdByUid?: string;
  createdByName?: string;
  updatedByUid?: string;
  updatedByName?: string;
  isArchived?: boolean;
}

export function deduplicateLocationVillages(items: any[]): LocationVillageItem[] {
  const map = new Map<string, LocationVillageItem>();
  (items || []).forEach((it) => {
    if (!it || it.isArchived) return;
    const rawState = normalizeStateName(it.state || resolveStateFromDistrict(it.district) || DEFAULT_STATE);
    const stateMeta = getStateMeta(it.stateCode || rawState);
    const state = stateMeta?.name || rawState;
    const districtMeta = getDistrictMeta(it.districtCode || it.district, stateMeta?.code);
    const district = districtMeta?.name || canonicalizeDistrictName(it.district || '', state);
    const talukaMeta = getTalukaMeta(districtMeta?.code || district, it.talukaCode || it.taluka, stateMeta?.code);
    const taluka = talukaMeta?.name || canonicalizeTalukaName(district, it.taluka || '', state);
    const village = String(it.village || '').trim();
    if (!district || !village) return;

    const vCode = String(it.villageCode || '').trim();
    const dedupKey = vCode
      ? `code:${vCode}`
      : `${normalizeLocationKey(state)}|${normalizeLocationKey(district)}|${normalizeLocationKey(taluka || 'other')}|${normalizeLocationKey(village)}`;

    const normalizedItem: LocationVillageItem = {
      ...it,
      id: it.id || getLocationVillageDocId(state, district, taluka, village, vCode),
      state,
      stateCode: String(it.stateCode || stateMeta?.code || ''),
      district,
      districtCode: String(it.districtCode || districtMeta?.code || ''),
      taluka: taluka || 'Other',
      talukaCode: String(it.talukaCode || talukaMeta?.code || ''),
      village,
      villageCode: vCode || undefined,
      pinCode: String(it.pinCode || '').trim(),
    };

    const existing = map.get(dedupKey);
    if (!existing) {
      map.set(dedupKey, normalizedItem);
    } else {
      map.set(dedupKey, {
        ...existing,
        ...normalizedItem,
        pinCode: normalizedItem.pinCode || existing.pinCode || '',
        villageCode: normalizedItem.villageCode || existing.villageCode,
      });
    }
  });

  return Array.from(map.values()).sort((a, b) => {
    const sCmp = a.state.localeCompare(b.state);
    if (sCmp !== 0) return sCmp;
    const dCmp = a.district.localeCompare(b.district);
    if (dCmp !== 0) return dCmp;
    const tCmp = a.taluka.localeCompare(b.taluka);
    if (tCmp !== 0) return tCmp;
    return a.village.localeCompare(b.village);
  });
}

export function deduplicateLocationTalukas(items: any[]): LocationTalukaItem[] {
  const map = new Map<string, LocationTalukaItem>();
  (items || []).forEach((it) => {
    if (!it || it.isArchived) return;
    const rawState = normalizeStateName(it.state || resolveStateFromDistrict(it.district) || DEFAULT_STATE);
    const stateMeta = getStateMeta(it.stateCode || rawState);
    const state = stateMeta?.name || rawState;
    const districtMeta = getDistrictMeta(it.districtCode || it.district, stateMeta?.code);
    const district = districtMeta?.name || canonicalizeDistrictName(it.district || '', state);
    const taluka = String(it.taluka || '').trim();
    const talukaCode = String(it.talukaCode || '').trim();
    if (!district || !taluka) return;

    const dedupKey = `${normalizeLocationKey(state)}|${normalizeLocationKey(district)}|${normalizeLocationKey(taluka)}`;
    const normalizedItem: LocationTalukaItem = {
      ...it,
      id: it.id || getLocationTalukaDocId(state, district, taluka, talukaCode),
      state,
      stateCode: String(it.stateCode || stateMeta?.code || ''),
      district,
      districtCode: String(it.districtCode || districtMeta?.code || ''),
      taluka,
      talukaCode: talukaCode || `CUST-${normalizeLocationKey(taluka).slice(0, 8).toUpperCase()}`,
    };
    map.set(dedupKey, normalizedItem);
  });
  return Array.from(map.values()).sort((a, b) => a.taluka.localeCompare(b.taluka));
}

export interface LocationDealerItem {
  id: string;
  firmName: string;
  proprietorName?: string;
  contactNumber?: string;
  category?: string;
  state: string;
  stateCode?: string;
  district: string;
  districtCode?: string;
  taluka: string;
  talukaCode?: string;
  village: string;
  villageCode?: string;
  pinCode?: string;
  address?: string;
  notes?: string;
  userId?: string;
  ownerId?: string;
  createdByUid?: string;
  createdByName?: string;
  updatedByUid?: string;
  updatedByName?: string;
  createdAt?: string;
  updatedAt?: string;
  isArchived?: boolean;
}

export function deduplicateLocationDealers(items: any[]): LocationDealerItem[] {
  const map = new Map<string, LocationDealerItem>();
  (items || []).forEach((it) => {
    if (!it || it.isArchived) return;
    const firmName = String(it.firmName || '').trim();
    if (!firmName) return;

    const rawState = normalizeStateName(it.state || resolveStateFromDistrict(it.district) || DEFAULT_STATE);
    const stateMeta = getStateMeta(it.stateCode || rawState);
    const state = stateMeta?.name || rawState;
    const districtMeta = getDistrictMeta(it.districtCode || it.district, stateMeta?.code);
    const district = districtMeta?.name || canonicalizeDistrictName(it.district || '', state);
    const talukaMeta = getTalukaMeta(districtMeta?.code || district, it.talukaCode || it.taluka, stateMeta?.code);
    const taluka = talukaMeta?.name || canonicalizeTalukaName(district, it.taluka || '', state) || String(it.taluka || '').trim();
    const village = String(it.village || '').trim();
    const id = String(it.id || '').trim();
    if (!id) return;

    const normalized: LocationDealerItem = {
      ...it,
      id,
      firmName,
      proprietorName: String(it.proprietorName || '').trim(),
      contactNumber: String(it.contactNumber || '').trim(),
      category: String(it.category || '').trim(),
      state,
      stateCode: String(it.stateCode || stateMeta?.code || ''),
      district,
      districtCode: String(it.districtCode || districtMeta?.code || ''),
      taluka,
      talukaCode: String(it.talukaCode || talukaMeta?.code || ''),
      village,
      villageCode: String(it.villageCode || '').trim(),
      pinCode: String(it.pinCode || '').trim(),
      address: String(it.address || '').trim(),
      notes: String(it.notes || '').trim(),
    };
    map.set(id, normalized);
  });

  return Array.from(map.values()).sort((a, b) => {
    const tA = Date.parse(String(a.updatedAt || a.createdAt || '')) || 0;
    const tB = Date.parse(String(b.updatedAt || b.createdAt || '')) || 0;
    if (tA !== tB) return tB - tA;
    return a.firmName.localeCompare(b.firmName);
  });
}
