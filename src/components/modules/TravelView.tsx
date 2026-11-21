import React, { useState, useEffect, useRef } from 'react';
import { UserProfile, isAdmin } from '../../lib/auth';
import { logAudit, safeFirestoreSet, getLocalDateStr, getPendingSyncMap, toTimestampMs, safeLocalStorageSet } from '../../lib/dataService';
import { loadCollectionFromVault } from '../../lib/localVault';
import { isRecordDeleted, isTravelRowPopulated, mergeTravelSheetDocs } from '../../lib/travelMerge';
import { useSharedUsers, useSharedTravelSheets } from '../../lib/realtimeStore';
import { Language, translations } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { useBranding } from '../../lib/branding';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { 
  Navigation,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  User as UserIcon,
  Save,
  CheckCircle2,
  Download,
  Loader2,
  Phone,
  Mail,
  X,
  Calendar
} from 'lucide-react';

export interface TravelRow {
  dayNumber: number;
  date: string;
  days: string; // Day of week (Mon, Tue, Wed...)
  route: string;
  openingKm: number;
  closingKm: number;
  km: number;
  amount: number;
  otherExpenses: number;
  subtotal: number;
  rowUpdatedAtMs?: number;
  rowClearedAtMs?: number;
}

export interface TravelSheetData {
  id: string;
  userId: string;
  officerName: string;
  designation: string;
  date: string; // Selected date / month-year
  monthName: string;
  yearNumber: number;
  ratePerKm: number;
  rows: TravelRow[];
  totalKm: number;
  totalAmount: number;
  totalOtherExpenses: number;
  subtotalAmount: number;
  averageCostPerKm: number;
  totalExpensesAmount: number;
  updatedAt?: string;
  createdAt?: string;
}

interface Props {
  profile: UserProfile;
  lang: Language;
}

// Generate rows for all days in month strictly (28, 29, 30, or 31 days)
export const generateMonthRows = (
  year: number, 
  monthIdx: number, 
  rate: number = 3.5,
  existingRows: TravelRow[] = []
): TravelRow[] => {
  const totalDays = new Date(year, monthIdx + 1, 0).getDate();
  const rows: TravelRow[] = [];
  const existingMap = new Map<number, TravelRow>();
  existingRows.forEach(r => {
    if (r.dayNumber && r.dayNumber <= totalDays) {
      existingMap.set(r.dayNumber, r);
    }
  });

  for (let d = 1; d <= totalDays; d++) {
    const dayDate = new Date(year, monthIdx, d);
    const dayString = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayOfWeek = dayDate.toLocaleDateString('en-US', { weekday: 'short' });

    if (existingMap.has(d)) {
      const ext = existingMap.get(d)!;
      const km = ext.closingKm >= ext.openingKm && ext.openingKm > 0 ? ext.closingKm - ext.openingKm : (ext.km || 0);
      const amount = ext.amount !== undefined && ext.amount !== null ? Number(ext.amount) || 0 : 0;
      const otherExpenses = Number(ext.otherExpenses) || 0;
      const subtotal = Math.round((amount + otherExpenses) * 100) / 100;

      rows.push({
        dayNumber: d,
        date: dayString,
        days: dayOfWeek,
        route: ext.route || '',
        openingKm: ext.openingKm || 0,
        closingKm: ext.closingKm || 0,
        km,
        amount,
        otherExpenses,
        subtotal,
        ...(typeof ext.rowUpdatedAtMs === 'number' && Number.isFinite(ext.rowUpdatedAtMs)
          ? { rowUpdatedAtMs: ext.rowUpdatedAtMs }
          : {}),
        ...(typeof ext.rowClearedAtMs === 'number' && Number.isFinite(ext.rowClearedAtMs)
          ? { rowClearedAtMs: ext.rowClearedAtMs }
          : {}),
      });
    } else {
      rows.push({
        dayNumber: d,
        date: dayString,
        days: dayOfWeek,
        route: '',
        openingKm: 0,
        closingKm: 0,
        km: 0,
        amount: 0,
        otherExpenses: 0,
        subtotal: 0
      });
    }
  }
  return rows;
};

const normalizeTravelSheet = (
  raw: any,
  yearNumber: number,
  monthIndex: number,
  monthName: string,
  targetUid: string,
  defaultOfficerName: string,
  defaultDesignation: string
): TravelSheetData => {
  const rate = Number(raw?.ratePerKm) || 3.5;
  const fullRows = generateMonthRows(
    yearNumber,
    monthIndex,
    rate,
    Array.isArray(raw?.rows) ? raw.rows : []
  );
  const totalKm = fullRows.reduce((acc, r) => acc + (Number(r.km) || 0), 0);
  const totalAmount = fullRows.reduce((acc, r) => acc + (Number(r.amount) || 0), 0);
  const totalOtherExpenses = fullRows.reduce((acc, r) => acc + (Number(r.otherExpenses) || 0), 0);
  const subtotalAmount = Math.round((totalAmount + totalOtherExpenses) * 100) / 100;
  const totalExpensesAmount = subtotalAmount;
  const averageCostPerKm = totalKm > 0 ? Math.round((totalExpensesAmount / totalKm) * 100) / 100 : 0;

  return {
    ...(raw && typeof raw === 'object' ? raw : {}),
    id: String(raw?.id || `travel_${targetUid}_${yearNumber}_${String(monthIndex + 1).padStart(2, '0')}`),
    userId: String(raw?.userId || targetUid),
    officerName: String(raw?.officerName || defaultOfficerName || targetUid),
    designation: String(raw?.designation || defaultDesignation || 'FIELD OFFICER'),
    date: String(raw?.date || ''),
    monthName: String(raw?.monthName || monthName || ''),
    yearNumber: Number(raw?.yearNumber) || yearNumber,
    ratePerKm: rate,
    rows: fullRows,
    totalKm,
    totalAmount,
    totalOtherExpenses,
    subtotalAmount,
    averageCostPerKm,
    totalExpensesAmount,
  };
};

export const TravelView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const userIsAdmin = isAdmin(profile);
  const { fieldOfficers: users } = useSharedUsers();
  const { travelSheets: sharedTravelSheets, loaded: sharedTravelLoaded, setTravelSheetsOptimistic } = useSharedTravelSheets();
  const usersRef = useRef<UserProfile[]>(users);
  usersRef.current = users;
  const [selectedUserId, setSelectedUserId] = useState<string>(() => {
    if (profile.role === 'owner') {
      try {
        const cached = localStorage.getItem('blackworm_cached_users');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed)) {
            const firstOfficer = parsed.find((u: any) => u.role !== 'owner');
            if (firstOfficer) return firstOfficer.uid;
          }
        }
      } catch {}
      return '';
    }
    return profile.uid;
  });
  const [isUserDropdownOpen, setIsUserDropdownOpen] = useState(false);
  
  // Current date by default
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    return getLocalDateStr();
  });

  // For non-admin (officers), strictly lock selectedUserId to logged-in user's uid
  useEffect(() => {
    if (!userIsAdmin && profile.role !== 'owner') {
      setSelectedUserId(profile.uid);
    }
  }, [userIsAdmin, profile.uid, profile.role]);

  // Accurate Year and Month parser from YYYY-MM-DD string
  const parseYearMonth = (dateStr: string) => {
    if (dateStr && dateStr.includes('-')) {
      const parts = dateStr.split('-');
      if (parts.length >= 2) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        if (!isNaN(y) && !isNaN(m) && m >= 0 && m <= 11) {
          return { year: y, monthIndex: m };
        }
      }
    }
    const d = new Date();
    return { year: d.getFullYear(), monthIndex: d.getMonth() };
  };

  const { year: selectedYearNumber, monthIndex: selectedMonthIndex } = parseYearMonth(selectedDate);

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const selectedMonthName = monthNames[selectedMonthIndex];

  const handlePrevMonth = () => {
    const d = new Date(selectedYearNumber, selectedMonthIndex, 1);
    d.setMonth(d.getMonth() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    setSelectedDate(`${y}-${m}-01`);
  };

  const handleNextMonth = () => {
    const d = new Date(selectedYearNumber, selectedMonthIndex, 1);
    d.setMonth(d.getMonth() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    setSelectedDate(`${y}-${m}-01`);
  };

  const [ratePerKm, setRatePerKm] = useState<number>(3.5);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

  // Instant sheet initialization from localStorage cache or clean default rows (never blank/null for officers)
  const [sheet, setSheet] = useState<TravelSheetData | null>(() => {
    if (profile.role === 'owner' && (!selectedUserId || selectedUserId === profile.uid)) {
      return null;
    }
    const sheetMonthKey = `${selectedYearNumber}_${(selectedMonthIndex + 1).toString().padStart(2, '0')}`;
    const targetUid = selectedUserId || profile.uid;
    const cacheKey = `travel_sheet_${targetUid}_${sheetMonthKey}`;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && !isRecordDeleted(parsed) && Array.isArray(parsed.rows) && parsed.rows.length > 0) {
          return normalizeTravelSheet(
            parsed,
            selectedYearNumber,
            selectedMonthIndex,
            selectedMonthName,
            targetUid,
            profile.fullName || profile.uid,
            profile.designation || 'FIELD OFFICER'
          );
        }
      }
    } catch {}

    const fullRows = generateMonthRows(selectedYearNumber, selectedMonthIndex, 3.5, []);
    return {
      id: `travel_${targetUid}_${sheetMonthKey}`,
      userId: targetUid,
      officerName: profile.fullName || profile.uid,
      designation: profile.designation || 'FIELD OFFICER',
      date: selectedDate,
      monthName: selectedMonthName,
      yearNumber: selectedYearNumber,
      ratePerKm: 3.5,
      rows: fullRows,
      totalKm: 0,
      totalAmount: 0,
      totalOtherExpenses: 0,
      subtotalAmount: 0,
      averageCostPerKm: 0,
      totalExpensesAmount: 0
    };
  });

  // Selected user photo
  const [selectedUserPhoto, setSelectedUserPhoto] = useState<string>('');

  const printableSheetRef = useRef<HTMLDivElement>(null);
  const suppressedCommaMap = useRef<Record<number, boolean>>({});
  const hasUnsavedEditsRef = useRef(false);
  const lastLocalEditAtRef = useRef(0);
  const latestSheetRef = useRef<TravelSheetData | null>(sheet);
  const dirtyDaysRef = useRef<Set<number>>(new Set());
  const autoSaveTimerRef = useRef<number | null>(null);
  latestSheetRef.current = sheet;

  const getMonthKeyForSheet = (targetSheet: TravelSheetData) => {
    const idParts = String(targetSheet.id || '').split('_');
    if (idParts.length >= 2) {
      const maybeYear = idParts[idParts.length - 2];
      const maybeMonth = idParts[idParts.length - 1];
      if (/^\d{4}$/.test(maybeYear) && /^\d{2}$/.test(maybeMonth)) {
        return `${maybeYear}_${maybeMonth}`;
      }
    }
    const monthIdxFromName = monthNames.findIndex(
      (m) => m.toLowerCase() === String(targetSheet.monthName || '').toLowerCase()
    );
    const mIdx = monthIdxFromName >= 0 ? monthIdxFromName : selectedMonthIndex;
    return `${targetSheet.yearNumber || selectedYearNumber}_${String(mIdx + 1).padStart(2, '0')}`;
  };

  const writeSheetToLocalCaches = (sheetObj: TravelSheetData) => {
    try {
      const sheetMonthKey = getMonthKeyForSheet(sheetObj);
      const cacheKey = `travel_sheet_${sheetObj.userId}_${sheetMonthKey}`;
      safeLocalStorageSet(cacheKey, JSON.stringify(sheetObj));
      safeLocalStorageSet(`travel_sheet_${sheetObj.userId}`, JSON.stringify(sheetObj));
      const cachedAllRaw = localStorage.getItem('blackworm_cached_travel_sheets');
      let cachedAll: any[] = cachedAllRaw ? JSON.parse(cachedAllRaw) : [];
      if (!Array.isArray(cachedAll)) cachedAll = [];
      const idx = cachedAll.findIndex((s: any) => s && (s.id === sheetObj.id || s._id === sheetObj.id));
      if (idx >= 0) {
        cachedAll[idx] = mergeTravelSheetDocs(cachedAll[idx], sheetObj);
      } else {
        cachedAll.push(sheetObj);
      }
      safeLocalStorageSet('blackworm_cached_travel_sheets', JSON.stringify(cachedAll));
    } catch {}
  };

  const persistTravelSheet = async (
    targetSheet: TravelSheetData,
    options: { showToast?: boolean; logAuditEntry?: boolean; isAutoSave?: boolean } = {}
  ) => {
    if (!targetSheet || !targetSheet.id) return;
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    const rawTargetTs = Number((targetSheet as any)._syncUpdatedAtMs) || 0;
    const nowMs = Date.now();
    const saveTs = Math.max(nowMs, rawTargetTs);
    const saveIso = new Date(saveTs).toISOString();
    const sheetToSave: TravelSheetData = {
      ...targetSheet,
      isArchived: false,
      is_deleted: false,
      updatedAt: saveIso,
      _syncUpdatedAtMs: saveTs,
    } as any;

    writeSheetToLocalCaches(sheetToSave);

    setTravelSheetsOptimistic((prev) => {
      const idx = prev.findIndex((s: any) => s && (s.id === sheetToSave.id || s._id === sheetToSave.id));
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = mergeTravelSheetDocs(prev[idx], sheetToSave);
        return next;
      }
      return [sheetToSave, ...prev];
    });

    try {
      await safeFirestoreSet('travel_sheets', sheetToSave.id, sheetToSave, { merge: true });

      if (options.logAuditEntry) {
        void logAudit(
          'UPDATE',
          'travel_sheets',
          sheetToSave.id,
          `Saved Travelling Sheet for ${sheetToSave.officerName} (${sheetToSave.monthName} ${sheetToSave.yearNumber})`,
          profile
        ).catch(() => {});
      }

      // Clear dirty markers only for days not subsequently modified while this save ran
      const currentSheet = latestSheetRef.current;
      if (!currentSheet || currentSheet.id !== sheetToSave.id) {
        hasUnsavedEditsRef.current = false;
        dirtyDaysRef.current.clear();
      } else {
        const currentRows = Array.isArray(currentSheet.rows) ? currentSheet.rows : [];
        dirtyDaysRef.current.forEach((dayNum) => {
          const matchingRow = currentRows.find((r) => Number(r.dayNumber) === dayNum);
          if (!matchingRow || (Number(matchingRow.rowUpdatedAtMs) || 0) <= rawTargetTs) {
            dirtyDaysRef.current.delete(dayNum);
          }
        });
        const currentTs = Number((currentSheet as any)._syncUpdatedAtMs) || 0;
        if (dirtyDaysRef.current.size === 0 && currentTs <= rawTargetTs) {
          hasUnsavedEditsRef.current = false;
          lastLocalEditAtRef.current = 0;
        }
      }

      if (options.showToast) {
        setShowSuccess(true);
        setTimeout(() => setShowSuccess(false), 3000);
      }
    } catch (err) {
      console.warn('Travel sheet save notice:', err);
      if (options.showToast) {
        setShowSuccess(true);
        setTimeout(() => setShowSuccess(false), 3000);
      }
    }
  };

  const persistTravelSheetRef = useRef(persistTravelSheet);
  persistTravelSheetRef.current = persistTravelSheet;

  const scheduleAutoSave = (targetSheet: TravelSheetData) => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      const toFlush = latestSheetRef.current && latestSheetRef.current.id === targetSheet.id
        ? latestSheetRef.current
        : targetSheet;
      void persistTravelSheetRef.current(toFlush, {
        showToast: false,
        logAuditEntry: false,
        isAutoSave: true,
      });
    }, 900);
  };

  // Lifecycle flush: guarantee edits survive tab hide, APK minimize, browser close, or component unmount
  useEffect(() => {
    const flushDirtySheet = () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      if (hasUnsavedEditsRef.current && latestSheetRef.current) {
        const snapshot = latestSheetRef.current;
        writeSheetToLocalCaches(snapshot);
        void persistTravelSheetRef.current(snapshot, {
          showToast: false,
          logAuditEntry: false,
          isAutoSave: true,
        });
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushDirtySheet();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', flushDirtySheet);
    window.addEventListener('beforeunload', flushDirtySheet);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', flushDirtySheet);
      window.removeEventListener('beforeunload', flushDirtySheet);
      flushDirtySheet();
    };
  }, []);

  // Village name formatter: First letter Capital, rest lowercase (Title Case)
  const formatRouteVillages = (str: string): string => {
    return str.replace(/\b[a-zA-Z]+/g, (match) => {
      return match.charAt(0).toUpperCase() + match.slice(1).toLowerCase();
    });
  };

  // Route input handler: Auto-inserts comma on space after word, but remembers if comma was deleted
  const handleRouteKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const cursorPos = input.selectionStart || 0;
    const val = input.value;

    if (e.key === 'Backspace') {
      const textBefore = val.slice(0, cursorPos);
      // If user deletes a comma or comma-space, suppress auto-comma so subsequent space does not re-add comma
      if (textBefore.endsWith(',') || textBefore.endsWith(', ')) {
        suppressedCommaMap.current[idx] = true;
      }
      return;
    }

    if (e.key === ' ') {
      // If user previously deleted the comma, allow standard space without adding comma
      if (suppressedCommaMap.current[idx]) {
        return;
      }

      // If typed space immediately following a word (letter or digit), auto-insert comma and space
      const textBefore = val.slice(0, cursorPos);
      if (/[A-Za-z0-9]$/.test(textBefore)) {
        e.preventDefault();
        const textAfter = val.slice(cursorPos);
        const formattedBefore = formatRouteVillages(textBefore);
        const newVal = formattedBefore + ', ' + textAfter;
        updateRow(idx, { route: newVal });
        setTimeout(() => {
          input.setSelectionRange(cursorPos + 2, cursorPos + 2);
        }, 0);
        return;
      }
    }

    // Typing a new word character resets suppression for the subsequent word
    if (e.key.length === 1 && /[A-Za-z0-9]/.test(e.key)) {
      suppressedCommaMap.current[idx] = false;
    }
  };

  // User photo listener
  useEffect(() => {
    const user = users.find(u => u.uid === selectedUserId) || profile;
    if (user && (user as any).photoUrl) {
      setSelectedUserPhoto((user as any).photoUrl);
    } else {
      setSelectedUserPhoto('');
    }
  }, [selectedUserId, users, profile]);

  // Branding
  const { logoUrl, logoSize } = useBranding();

  // Auto-select first field officer for Owner login without touching blackworm_cached_users
  useEffect(() => {
    if (users.length === 0) return;
    if (profile.role === 'owner' || !selectedUserId) {
      setSelectedUserId((prev) => {
        if (!prev || (profile.role === 'owner' && prev === profile.uid)) {
          return users[0].uid;
        }
        const exists = users.some((u) => u.uid === prev);
        return exists ? prev : users[0].uid;
      });
    }
  }, [users, profile.role, profile.uid, selectedUserId]);

  const sharedTravelSheetsRef = useRef<any[]>(sharedTravelSheets);
  sharedTravelSheetsRef.current = sharedTravelSheets;

  const hasPopulatedRows = (s?: Partial<TravelSheetData> | null) =>
    Boolean(
      s &&
        Array.isArray(s.rows) &&
        s.rows.some((r) => isTravelRowPopulated(r))
    );

  // Hydrate and reactively sync sheet from shared real-time store + localStorage + IndexedDB Vault
  useEffect(() => {
    let cancelled = false;
    const currentUsers = usersRef.current;
    // Strictly prevent creating or loading travel sheets for Owner
    const isOwnerTarget = (profile.role === 'owner' && (!selectedUserId || selectedUserId === profile.uid)) ||
                          currentUsers.some(u => u.uid === selectedUserId && u.role === 'owner');
    if (isOwnerTarget || !selectedUserId) {
      setSheet(null);
      latestSheetRef.current = null;
      setLoading(false);
      return;
    }

    hasUnsavedEditsRef.current = false;
    lastLocalEditAtRef.current = 0;
    dirtyDaysRef.current.clear();

    const targetUid = selectedUserId;
    const sheetMonthKey = `${selectedYearNumber}_${(selectedMonthIndex + 1).toString().padStart(2, '0')}`;
    const sheetId = `travel_${targetUid}_${sheetMonthKey}`;
    const cacheKey = `travel_sheet_${targetUid}_${sheetMonthKey}`;
    const selectedUser = currentUsers.find(u => u.uid === targetUid) || profile;

    let cachedSheetObj: TravelSheetData | null = null;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && !isRecordDeleted(parsed) && Array.isArray(parsed.rows) && parsed.rows.length > 0) {
          cachedSheetObj = normalizeTravelSheet(
            parsed,
            selectedYearNumber,
            selectedMonthIndex,
            selectedMonthName,
            targetUid,
            parsed.officerName || selectedUser.fullName || targetUid,
            parsed.designation || selectedUser.designation || 'FIELD OFFICER'
          );
        }
      }
    } catch {}

    // Also inspect bulk local travel cache if per-month key was missing
    if (!cachedSheetObj) {
      try {
        const bulkRaw = localStorage.getItem('blackworm_cached_travel_sheets');
        if (bulkRaw) {
          const bulkArr = JSON.parse(bulkRaw);
          if (Array.isArray(bulkArr)) {
            const bulkMatch = bulkArr.find((s: any) => s && !isRecordDeleted(s) && (s.id === sheetId || s._id === sheetId));
            if (bulkMatch && Array.isArray(bulkMatch.rows) && bulkMatch.rows.length > 0) {
              cachedSheetObj = normalizeTravelSheet(
                bulkMatch,
                selectedYearNumber,
                selectedMonthIndex,
                selectedMonthName,
                targetUid,
                bulkMatch.officerName || selectedUser.fullName || targetUid,
                bulkMatch.designation || selectedUser.designation || 'FIELD OFFICER'
              );
            }
          }
        }
      } catch {}
    }

    const sharedMatchRaw = sharedTravelSheetsRef.current.find(
      (s) => s && !isRecordDeleted(s) && (s.id === sheetId || s._id === sheetId)
    );
    const sharedSheetObj =
      sharedMatchRaw && Array.isArray(sharedMatchRaw.rows)
        ? normalizeTravelSheet(
            sharedMatchRaw,
            selectedYearNumber,
            selectedMonthIndex,
            selectedMonthName,
            targetUid,
            sharedMatchRaw.officerName || selectedUser.fullName || targetUid,
            sharedMatchRaw.designation || selectedUser.designation || 'FIELD OFFICER'
          )
        : null;

    if (cachedSheetObj && sharedSheetObj) {
      const merged = normalizeTravelSheet(
        mergeTravelSheetDocs(cachedSheetObj, sharedSheetObj),
        selectedYearNumber,
        selectedMonthIndex,
        selectedMonthName,
        targetUid,
        sharedSheetObj.officerName || cachedSheetObj.officerName || selectedUser.fullName || targetUid,
        sharedSheetObj.designation || cachedSheetObj.designation || selectedUser.designation || 'FIELD OFFICER'
      );
      latestSheetRef.current = merged;
      setSheet(merged);
      setRatePerKm(merged.ratePerKm || 3.5);
      writeSheetToLocalCaches(merged);

      // Recover unsynced local rows to backend automatically if merged differs from server snapshot
      const cachedHadDataNotInServer = cachedSheetObj.rows.some((cr) => {
        if (!isTravelRowPopulated(cr)) return false;
        const sr = sharedSheetObj.rows.find((r) => r.dayNumber === cr.dayNumber);
        return !sr || !isTravelRowPopulated(sr) || (Number(cr.rowUpdatedAtMs) || 0) > (Number(sr.rowUpdatedAtMs) || 0);
      });
      if (cachedHadDataNotInServer) {
        void persistTravelSheetRef.current(merged, { showToast: false, logAuditEntry: false, isAutoSave: true });
      }
      setLoading(false);
    } else if (sharedSheetObj) {
      latestSheetRef.current = sharedSheetObj;
      setSheet(sharedSheetObj);
      setRatePerKm(sharedSheetObj.ratePerKm || 3.5);
      writeSheetToLocalCaches(sharedSheetObj);
      setLoading(false);
    } else if (cachedSheetObj) {
      latestSheetRef.current = cachedSheetObj;
      setSheet(cachedSheetObj);
      setRatePerKm(cachedSheetObj.ratePerKm || 3.5);
      if (hasPopulatedRows(cachedSheetObj)) {
        void persistTravelSheetRef.current(cachedSheetObj, { showToast: false, logAuditEntry: false, isAutoSave: true });
      }
      setLoading(false);
    } else {
      const fullRows = generateMonthRows(selectedYearNumber, selectedMonthIndex, 3.5);
      const emptySheet: TravelSheetData = {
        id: sheetId,
        userId: targetUid,
        officerName: selectedUser.fullName || targetUid,
        designation: selectedUser.designation || 'FIELD OFFICER',
        date: selectedDate,
        monthName: selectedMonthName,
        yearNumber: selectedYearNumber,
        ratePerKm: 3.5,
        rows: fullRows,
        totalKm: 0,
        totalAmount: 0,
        totalOtherExpenses: 0,
        subtotalAmount: 0,
        averageCostPerKm: 0,
        totalExpensesAmount: 0,
      };
      latestSheetRef.current = emptySheet;
      setSheet(emptySheet);
      setLoading(false);

      // Asynchronously check IndexedDB Vault for offline fallback data if neither localStorage nor memory store had it yet
      void loadCollectionFromVault('travel_sheets').then((vaultMap) => {
        if (cancelled || !vaultMap) return;
        const vaultDoc = vaultMap[sheetId];
        if (!vaultDoc || isRecordDeleted(vaultDoc) || !Array.isArray(vaultDoc.rows)) return;
        const normalizedVault = normalizeTravelSheet(
          vaultDoc,
          selectedYearNumber,
          selectedMonthIndex,
          selectedMonthName,
          targetUid,
          vaultDoc.officerName || selectedUser.fullName || targetUid,
          vaultDoc.designation || selectedUser.designation || 'FIELD OFFICER'
        );
        if (!hasPopulatedRows(normalizedVault)) return;
        const currentBase = latestSheetRef.current && latestSheetRef.current.id === sheetId
          ? latestSheetRef.current
          : emptySheet;
        const mergedVault = normalizeTravelSheet(
          mergeTravelSheetDocs(currentBase, normalizedVault, { dirtyDays: dirtyDaysRef.current }),
          selectedYearNumber,
          selectedMonthIndex,
          selectedMonthName,
          targetUid,
          normalizedVault.officerName || selectedUser.fullName || targetUid,
          normalizedVault.designation || selectedUser.designation || 'FIELD OFFICER'
        );
        latestSheetRef.current = mergedVault;
        setSheet(mergedVault);
        setRatePerKm(mergedVault.ratePerKm || 3.5);
        writeSheetToLocalCaches(mergedVault);
      });
    }

    return () => {
      cancelled = true;
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      // Flush dirty edits for the officer/month before switching to another officer/month
      if (hasUnsavedEditsRef.current && latestSheetRef.current && latestSheetRef.current.id === sheetId) {
        const snapshot = latestSheetRef.current;
        writeSheetToLocalCaches(snapshot);
        void persistTravelSheetRef.current(snapshot, {
          showToast: false,
          logAuditEntry: false,
          isAutoSave: true,
        });
      }
    };
  }, [selectedUserId, selectedYearNumber, selectedMonthIndex, profile.role, profile.uid]);

  // Apply live updates from sharedTravelSheets cleanly with non-destructive per-day row merging
  useEffect(() => {
    const isOwnerTarget = (profile.role === 'owner' && (!selectedUserId || selectedUserId === profile.uid)) ||
                          usersRef.current.some(u => u.uid === selectedUserId && u.role === 'owner');
    if (isOwnerTarget || !selectedUserId) return;
    const targetUid = selectedUserId;
    const sheetMonthKey = `${selectedYearNumber}_${(selectedMonthIndex + 1).toString().padStart(2, '0')}`;
    const sheetId = `travel_${targetUid}_${sheetMonthKey}`;
    const cacheKey = `travel_sheet_${targetUid}_${sheetMonthKey}`;

    const sharedMatch = sharedTravelSheets.find(
      (s) => s && !isRecordDeleted(s) && (s.id === sheetId || s._id === sheetId)
    );
    if (!sharedMatch || !Array.isArray(sharedMatch.rows)) return;

    const incomingTs = Math.max(Number(sharedMatch._syncUpdatedAtMs) || 0, toTimestampMs(sharedMatch.updatedAt));
    const pendingMeta = getPendingSyncMap('travel_sheets').get(sheetId);
    const pendingNewer = Boolean(pendingMeta && pendingMeta.ts > incomingTs);

    const selectedUser = usersRef.current.find(u => u.uid === targetUid) || profile;
    const normalizedIncoming = normalizeTravelSheet(
      sharedMatch,
      selectedYearNumber,
      selectedMonthIndex,
      selectedMonthName,
      targetUid,
      selectedUser.fullName || sharedMatch.officerName || targetUid,
      selectedUser.designation || sharedMatch.designation || 'FIELD OFFICER'
    );

    const currentBase =
      latestSheetRef.current && latestSheetRef.current.id === sheetId
        ? latestSheetRef.current
        : null;

    let nextSheet: TravelSheetData;
    if (currentBase) {
      const prevTs = Math.max(Number((currentBase as any)._syncUpdatedAtMs) || 0, toTimestampMs(currentBase.updatedAt));
      const merged = mergeTravelSheetDocs(currentBase, normalizedIncoming, {
        dirtyDays: dirtyDaysRef.current,
        preferIncomingMeta: !hasUnsavedEditsRef.current && !pendingNewer && incomingTs >= prevTs,
      });
      nextSheet = normalizeTravelSheet(
        merged,
        selectedYearNumber,
        selectedMonthIndex,
        selectedMonthName,
        targetUid,
        merged.officerName || selectedUser.fullName || targetUid,
        merged.designation || selectedUser.designation || 'FIELD OFFICER'
      );

      // Skip state churn if rows, rate, and timestamp are identical
      const nextTs = Number((nextSheet as any)._syncUpdatedAtMs) || 0;
      if (
        prevTs === nextTs &&
        Number(currentBase.ratePerKm) === Number(nextSheet.ratePerKm) &&
        JSON.stringify(currentBase.rows) === JSON.stringify(nextSheet.rows)
      ) {
        return;
      }
    } else {
      nextSheet = normalizedIncoming;
    }

    latestSheetRef.current = nextSheet;
    setRatePerKm(nextSheet.ratePerKm || 3.5);
    setSheet(nextSheet);
    safeLocalStorageSet(cacheKey, JSON.stringify(nextSheet));
    setLoading(false);
  }, [sharedTravelSheets, sharedTravelLoaded, selectedUserId, selectedYearNumber, selectedMonthIndex, profile.role, profile.uid]);

  const updateRow = (index: number, updates: Partial<TravelRow>) => {
    const baseSheet = latestSheetRef.current || sheet;
    if (!baseSheet) return;
    const nowEditMs = Date.now();
    hasUnsavedEditsRef.current = true;
    lastLocalEditAtRef.current = nowEditMs;
    const newRows = [...baseSheet.rows];
    const currentRow = newRows[index];
    const wasPopulated = isTravelRowPopulated(currentRow);
    const updated: TravelRow = { ...currentRow, ...updates };

    // Auto-calculate KM (Closing KM - Opening KM)
    if ('openingKm' in updates || 'closingKm' in updates) {
      updated.openingKm = Math.max(0, Number(updated.openingKm) || 0);
      updated.closingKm = Math.max(0, Number(updated.closingKm) || 0);
      if (updated.closingKm >= updated.openingKm && updated.openingKm > 0) {
        updated.km = updated.closingKm - updated.openingKm;
      } else if (updated.closingKm === 0 && updated.openingKm === 0) {
        updated.km = 0;
      }
    }

    // Manual Amount: strictly set by user input, not auto-calculated from KM
    if ('amount' in updates) {
      updated.amount = updates.amount !== undefined && updates.amount !== null ? Math.max(0, Number(updated.amount) || 0) : 0;
    }

    if ('otherExpenses' in updates) {
      updated.otherExpenses = Math.max(0, Number(updated.otherExpenses) || 0);
    }

    // Auto-calculate Subtotal (Manual Amount + Other Expenses)
    const amount = Math.max(0, Number(updated.amount) || 0);
    const other = Math.max(0, Number(updated.otherExpenses) || 0);
    updated.subtotal = Math.round((amount + other) * 100) / 100;

    // Stamp row-level edit / clear timestamp so per-day merging never clobbers or loses entries
    updated.rowUpdatedAtMs = nowEditMs;
    if (isTravelRowPopulated(updated)) {
      delete updated.rowClearedAtMs;
    } else if (wasPopulated) {
      updated.rowClearedAtMs = nowEditMs;
    }

    if (updated.dayNumber) {
      dirtyDaysRef.current.add(updated.dayNumber);
    }

    newRows[index] = updated;

    // Recalculate Totals
    const totalKm = newRows.reduce((acc, r) => acc + (r.km || 0), 0);
    const totalAmount = newRows.reduce((acc, r) => acc + (r.amount || 0), 0);
    const totalOtherExpenses = newRows.reduce((acc, r) => acc + (r.otherExpenses || 0), 0);
    const subtotalAmount = Math.round((totalAmount + totalOtherExpenses) * 100) / 100;
    const totalExpensesAmount = subtotalAmount;
    const averageCostPerKm = totalKm > 0 ? Math.round((totalExpensesAmount / totalKm) * 100) / 100 : 0;

    const updatedSheet: TravelSheetData = {
      ...baseSheet,
      rows: newRows,
      totalKm,
      totalAmount,
      totalOtherExpenses,
      subtotalAmount,
      averageCostPerKm,
      totalExpensesAmount,
      updatedAt: new Date(nowEditMs).toISOString(),
      _syncUpdatedAtMs: nowEditMs,
    } as any;

    latestSheetRef.current = updatedSheet;
    setSheet(updatedSheet);
    writeSheetToLocalCaches(updatedSheet);
    scheduleAutoSave(updatedSheet);
  };

  const handleRateChange = (newRate: number) => {
    const baseSheet = latestSheetRef.current || sheet;
    if (!baseSheet) return;
    const nowEditMs = Date.now();
    hasUnsavedEditsRef.current = true;
    lastLocalEditAtRef.current = nowEditMs;
    setRatePerKm(newRate);
    const updatedSheet: TravelSheetData = {
      ...baseSheet,
      ratePerKm: newRate,
      updatedAt: new Date(nowEditMs).toISOString(),
      _syncUpdatedAtMs: nowEditMs,
    } as any;
    latestSheetRef.current = updatedSheet;
    setSheet(updatedSheet);
    writeSheetToLocalCaches(updatedSheet);
    scheduleAutoSave(updatedSheet);
  };

  const handleSave = async () => {
    const currentSheet = latestSheetRef.current || sheet;
    if (!currentSheet || saving) return;
    setSaving(true);
    try {
      await persistTravelSheet(currentSheet, {
        showToast: true,
        logAuditEntry: true,
        isAutoSave: false,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!printableSheetRef.current) return;
    try {
      setIsGeneratingPdf(true);
      const element = printableSheetRef.current;
      
      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        width: 980,
        windowWidth: 1200,
        scrollX: 0,
        scrollY: 0,
        onclone: (clonedDoc) => {
          const clonedSheet = clonedDoc.querySelector('[data-printable-sheet="true"]') as HTMLElement;
          if (clonedSheet) {
            clonedSheet.style.width = '980px';
            clonedSheet.style.minWidth = '980px';
            clonedSheet.style.maxWidth = '980px';
            clonedSheet.style.overflow = 'visible';
            clonedSheet.style.margin = '0';
            clonedSheet.style.boxSizing = 'border-box';
          }

          // Replace inputs in the clone with styled divs so html2canvas renders complete text without input clipping
          const inputs = clonedDoc.querySelectorAll('input');
          inputs.forEach((input) => {
            const textDiv = clonedDoc.createElement('div');
            const val = input.value || input.placeholder || '';
            textDiv.textContent = val;
            textDiv.style.width = '100%';
            textDiv.style.textAlign = 'center';
            textDiv.style.whiteSpace = 'nowrap';
            textDiv.style.overflow = 'visible';
            textDiv.style.display = 'block';
            textDiv.style.fontWeight = '900';
            textDiv.style.textTransform = 'uppercase';
            textDiv.style.color = '#000000';
            textDiv.style.lineHeight = '1.2';
            textDiv.style.padding = '2px 3px';

            const role = input.getAttribute('data-role');
            if (role === 'route') {
              textDiv.style.padding = '2px 3px 2px 6px';
              textDiv.style.textAlign = 'left';
              const len = val.length;
              // Precise font scaling for Route column so even very long village chains fit in a single line!
              const fontSize = len > 50 ? '7.5px' : len > 38 ? '8.5px' : len > 26 ? '9.5px' : '10.5px';
              textDiv.style.fontSize = fontSize;
              textDiv.style.letterSpacing = '-0.02em';
            } else if (role === 'officerName') {
              textDiv.style.fontSize = '12px';
              textDiv.style.textAlign = 'left';
            } else if (role === 'designation') {
              textDiv.style.fontSize = '9.5px';
              textDiv.style.textAlign = 'left';
            } else {
              textDiv.style.fontSize = '10px';
            }

            input.parentNode?.replaceChild(textDiv, input);
          });
        }
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.98);
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
        compress: true,
      });

      const pageWidth = 210;
      const pageHeight = 297;
      const marginX = 5;
      const marginY = 5;
      const maxContentWidth = pageWidth - (marginX * 2); // 200 mm
      const maxContentHeight = pageHeight - (marginY * 2); // 287 mm

      let finalWidth = maxContentWidth;
      let finalHeight = (canvas.height * finalWidth) / canvas.width;

      if (finalHeight > maxContentHeight) {
        finalHeight = maxContentHeight;
        finalWidth = (canvas.width * finalHeight) / canvas.height;
      }

      const posX = (pageWidth - finalWidth) / 2;
      const posY = marginY;

      pdf.addImage(imgData, 'JPEG', posX, posY, finalWidth, finalHeight, undefined, 'FAST');
      const sanitizedName = (sheet?.officerName ? `Traveling_Sheet_${sheet.officerName}_${sheet.monthName}` : 'Traveling_Sheet').replace(/[^a-zA-Z0-9_-]/g, '_');
      pdf.save(`${sanitizedName}.pdf`);
    } catch (err: any) {
      console.error('PDF download error:', err);
      window.print();
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  if (!sheet) {
    if (profile.role === 'owner' && users.length === 0) {
      return (
        <div className="bg-white p-8 rounded-2xl border border-slate-200 text-center space-y-2">
          <p className="text-slate-800 font-black text-sm">कोणतेही फील्ड ऑफिसर्स उपलब्ध नाहीत.</p>
          <p className="text-slate-500 text-xs font-medium">ट्रॅव्हलिंग सीट केवळ फील्ड ऑफिसर्ससाठी तयार केली जाते.</p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-white rounded-2xl border border-slate-200">
        <div className="w-8 h-8 border-4 border-red-600 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-slate-600 font-bold text-sm">
          {profile.role === 'owner' ? 'फील्ड ऑफिसर्सची ट्रॅव्हलिंग सीट लोड होत आहे...' : 'ट्रॅव्हलिंग शीट तयार होत आहे...'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 font-sans pb-12">
      {/* Top Action Toolbar */}
      <div className="bg-white p-2.5 sm:p-3 rounded-2xl border border-slate-200 shadow-md flex flex-wrap items-center justify-between gap-2.5 no-print">
        
        {/* User & Date / Month Selectors */}
        <div className="flex flex-wrap items-center gap-2">
          {/* User Selector: Dropdown for Admin, Locked Badge for Non-Admin */}
          {userIsAdmin ? (
            <div className="relative flex-1 min-w-[130px] sm:w-60">
              <button
                type="button"
                onClick={() => setIsUserDropdownOpen(!isUserDropdownOpen)}
                className="w-full bg-slate-50 border border-slate-300 text-slate-800 py-1.5 px-2 xs:px-2.5 rounded-lg text-left flex items-center justify-between gap-1.5 cursor-pointer hover:bg-slate-100 transition shadow-2xs min-w-0"
              >
                <div className="min-w-0 flex-1 flex items-center gap-1.5 overflow-x-auto">
                  <UserIcon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <span className="text-[11px] sm:text-xs font-bold text-slate-900 leading-tight whitespace-nowrap">
                    {users.find(u => u.uid === selectedUserId)?.fullName || (profile.role !== 'owner' ? profile.fullName : 'अधिकारी निवडा')}
                  </span>
                </div>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              </button>

              {isUserDropdownOpen && (
                <>
                  <div 
                    className="fixed inset-0 z-[90] bg-black/40 backdrop-blur-xs transition-opacity" 
                    onClick={() => setIsUserDropdownOpen(false)} 
                  />
                  <div className="fixed left-3 right-3 top-28 sm:top-auto sm:left-0 sm:right-auto sm:absolute sm:mt-1 sm:w-80 md:w-96 z-[100] bg-white border border-slate-300 rounded-2xl shadow-2xl overflow-hidden ring-1 ring-black/10">
                    <div className="p-3 bg-slate-100 border-b border-slate-200 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <UserIcon className="w-4 h-4 text-slate-700" />
                        <span className="text-xs font-bold text-slate-800 uppercase tracking-wide">
                          अधिकारी निवडा ({users.length})
                        </span>
                      </div>
                      <button 
                        type="button" 
                        onClick={() => setIsUserDropdownOpen(false)} 
                        className="p-1 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-200 cursor-pointer"
                        title="Close"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="max-h-64 sm:max-h-80 overflow-y-auto p-1.5 divide-y divide-slate-100">
                      {users.map((u) => (
                        <div
                          key={u.uid}
                          onClick={() => {
                            setSelectedUserId(u.uid);
                            setIsUserDropdownOpen(false);
                          }}
                          className={cn(
                            "p-2.5 px-3 rounded-xl cursor-pointer transition flex items-center justify-between gap-3 text-xs sm:text-sm",
                            selectedUserId === u.uid 
                              ? "bg-blue-50 text-blue-900 font-bold border border-blue-200" 
                              : "hover:bg-slate-50 text-slate-800 font-medium"
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-slate-900 whitespace-normal break-words">{u.fullName || u.uid}</p>
                            <p className="text-[10px] text-slate-500 uppercase mt-0.5">
                              {u.designation || u.role || 'FIELD OFFICER'}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-100 border border-slate-200 rounded-lg text-[11px] sm:text-xs font-black uppercase text-slate-800 max-w-full overflow-x-auto">
              <UserIcon className="w-3 h-3 text-slate-500 shrink-0" />
              <span className="font-black text-slate-900 whitespace-nowrap">{profile.fullName || 'OFFICER'}</span>
              <span className="text-[9px] font-bold text-slate-500 bg-white border border-slate-200 px-1 py-0.2 rounded shrink-0 whitespace-nowrap">
                ({profile.designation || 'OFFICER'})
              </span>
            </div>
          )}

          {/* Unified Month / Date Box with Calendar Icon & Arrows */}
          <div className="flex items-center gap-1 bg-slate-50 border border-slate-300 px-2 py-1 rounded-lg">
            <Calendar className="w-3.5 h-3.5 text-red-600 shrink-0" />
            <button
              type="button"
              onClick={handlePrevMonth}
              className="p-0.5 rounded hover:bg-slate-200 text-slate-700 transition active:scale-95 cursor-pointer"
              title="Previous Month"
            >
              <ChevronLeft className="w-3.5 h-3.5 stroke-[2.5]" />
            </button>
            <span className="text-[11px] sm:text-xs font-black text-slate-900 px-0.5 whitespace-nowrap">
              {selectedMonthName} {selectedYearNumber}
            </span>
            <button
              type="button"
              onClick={handleNextMonth}
              className="p-0.5 rounded hover:bg-slate-200 text-slate-700 transition active:scale-95 cursor-pointer"
              title="Next Month"
            >
              <ChevronRight className="w-3.5 h-3.5 stroke-[2.5]" />
            </button>
          </div>

          {/* Action Buttons: Compact Save & PDF to fit on mobile alongside date selector */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button 
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1 rounded-lg text-xs font-black transition flex items-center gap-1 shadow-xs active:scale-95 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              title="Save Travelling Sheet"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              <span>{saving ? '...' : 'Save'}</span>
            </button>

            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={isGeneratingPdf}
              className="bg-blue-600 hover:bg-blue-700 text-white px-1.5 py-0.5 sm:px-2 sm:py-1 rounded text-[9px] sm:text-[10px] font-black transition flex items-center gap-0.5 shadow-xs active:scale-95 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              title="Save PDF"
            >
              {isGeneratingPdf ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Download className="w-2.5 h-2.5" />}
              <span>PDF</span>
            </button>
          </div>
        </div>
      </div>

      {showSuccess && (
        <div className="fixed bottom-6 right-6 z-50 bg-emerald-700 text-white p-3.5 px-5 rounded-2xl shadow-2xl flex items-center justify-between gap-3 text-xs font-black animate-in fade-in slide-in-from-bottom-5 no-print border border-emerald-500">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-white shrink-0" />
            <span>Saved</span>
          </div>
          <button onClick={() => setShowSuccess(false)} className="text-white/80 hover:text-white p-1 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ======================= STRICT OFFICIAL TRAVELLING SHEET FORM ======================= */}
      <div className="bg-white rounded-2xl border-2 border-slate-300 shadow-xl overflow-x-auto print:border-none print:shadow-none print:m-0 print:p-0">
        <div ref={printableSheetRef} data-printable-sheet="true" className="border-2 border-black bg-white shadow-sm w-[980px] min-w-[980px]">
          
          {/* 1. Header Section - Logo (Left) and Company Details (Center) */}
          <div className="p-3 relative bg-white border-b-2 border-black">
            <div className="flex items-center justify-between gap-4">
              {/* Logo */}
              <div className="w-20 h-20 flex items-center justify-center shrink-0">
                {logoUrl ? (
                  <img 
                    src={logoUrl} 
                    alt="Logo" 
                    style={{ width: `${logoSize}px`, height: `${logoSize}px` }} 
                    className="object-contain" 
                  />
                ) : (
                  <img 
                    src="/logo.jpg" 
                    alt="Logo" 
                    className="w-16 h-16 object-contain" 
                  />
                )}
              </div>

              {/* Company Info */}
              <div className="flex-1 text-center space-y-1">
                <h1 className="text-2xl font-black text-red-600 uppercase tracking-tight leading-none">
                  BLACKWORM AGRITECH PVT LTD
                </h1>
                <div className="text-[8px] text-slate-700 font-bold leading-tight mt-1">
                  <p>CIN : U01409PN2022PTC217246, GST No. 27AALCB3069J1ZC</p>
                  <p>Address - Gat No. 17 Vijaynagar (Mhaisal), Tal - Miraj, Dist - Sangli. 416409.</p>
                  <p className="flex items-center justify-center gap-4 mt-0.5">
                    <span className="flex items-center gap-1 text-red-600"><Phone className="w-2.5 h-2.5" /> +91 7798716201</span>
                    <span className="flex items-center gap-1 text-red-600 underline"><Mail className="w-2.5 h-2.5" /> blackwormagritechpvtltd@gmail.com</span>
                  </p>
                </div>
              </div>

              {/* Travel Allowance Badge or User Photo */}
              <div className="w-20 h-20 flex flex-col items-center justify-center border-2 border-black bg-white shrink-0 overflow-hidden">
                {selectedUserPhoto ? (
                  <img src={selectedUserPhoto} alt="User" className="w-full h-full object-cover" />
                ) : (
                  <div className="flex flex-col items-center justify-center p-1 bg-red-50 w-full h-full">
                    <Navigation className="w-6 h-6 text-red-600 mb-0.5" />
                    <span className="text-[8px] font-black text-slate-900 leading-tight text-center uppercase">TRAVEL STATEMENT</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 2. Banner: Month & Year Full Statement */}
          <div className="bg-slate-900 text-white font-black px-2 py-2 flex items-center justify-center border-b-2 border-black">
            <span className="text-xs sm:text-sm tracking-widest uppercase whitespace-nowrap text-center">
              MONTHLY TRAVEL EXPENSE STATEMENT - {String(sheet.monthName || selectedMonthName || '').toUpperCase()} {sheet.yearNumber || selectedYearNumber}
            </span>
          </div>

          {/* 3. Header Fields: Officer Name, Designation, Date */}
          <div className="grid grid-cols-[1.9fr_0.85fr_0.75fr] divide-x-2 divide-black border-b-2 border-black bg-white text-[11px] font-black">
            
            {/* Officer Name - Fully visible with expanded width */}
            <div className="flex items-center p-0 min-h-10">
              <span className="font-black text-black shrink-0 px-2 uppercase tracking-tighter text-xs">Officer Name -</span>
              <div className="flex-1 border-l-2 border-black min-h-10 flex items-center px-2 min-w-0">
                <input 
                  type="text" 
                  data-role="officerName"
                  value={sheet.officerName} 
                  onChange={e => setSheet({ ...sheet, officerName: e.target.value.toUpperCase() })} 
                  placeholder="OFFICER NAME"
                  className="w-full bg-transparent font-black text-black uppercase focus:outline-none text-left text-xs sm:text-[12.5px] tracking-tight" 
                />
              </div>
            </div>

            {/* Designation - Compressed and compact */}
            <div className="flex items-center p-0 min-h-10 bg-slate-50/40">
              <span className="font-black text-slate-800 shrink-0 px-2 uppercase tracking-tighter whitespace-nowrap text-[9px] sm:text-[9.5px]">Designation -</span>
              <div className="flex-1 border-l-2 border-black min-h-10 flex items-center px-2 min-w-0">
                <input 
                  type="text" 
                  data-role="designation"
                  value={sheet.designation} 
                  onChange={e => setSheet({ ...sheet, designation: e.target.value.toUpperCase() })} 
                  placeholder="DESIGNATION"
                  className="w-full bg-transparent font-black text-slate-800 uppercase focus:outline-none text-left text-[9px] sm:text-[9.5px] tracking-tight" 
                />
              </div>
            </div>

            {/* Date */}
            <div className="flex items-center p-0 min-h-10 bg-slate-50">
              <span className="font-black text-black shrink-0 px-2 uppercase tracking-tighter whitespace-nowrap">Date -</span>
              <div className="flex-1 border-l-2 border-black min-h-10 flex items-center justify-center px-2 min-w-0">
                <span className="font-black text-black text-center uppercase whitespace-nowrap">
                  {sheet.monthName} {sheet.yearNumber}
                </span>
              </div>
            </div>
          </div>

          {/* 4. Strict Table Columns: Date, Days, Route, Opening KM, Closing KM, KM, Amount, Other Expenses, Subtotal */}
          <div className="overflow-x-auto bg-white">
            <table className="w-full text-left border-collapse text-[10.5px]">
              <thead>
                <tr className="bg-slate-900 text-white font-black uppercase text-center border-b-2 border-black">
                  <th className="p-1.5 border-r-2 border-black w-16 text-center whitespace-nowrap">Date</th>
                  <th className="p-1.5 border-r-2 border-black w-12 text-center whitespace-nowrap">Days</th>
                  <th className="p-1.5 pl-3 border-r-2 border-black w-[410px] min-w-[390px] text-left whitespace-nowrap">Route</th>
                  <th className="p-1.5 border-r-2 border-black w-16 text-center whitespace-nowrap">Opening KM</th>
                  <th className="p-1.5 border-r-2 border-black w-16 text-center whitespace-nowrap">Closing KM</th>
                  <th className="p-1.5 border-r-2 border-black w-14 text-center whitespace-nowrap">KM</th>
                  <th className="p-1.5 border-r-2 border-black w-16 text-center whitespace-nowrap">Amount</th>
                  <th className="p-1.5 border-r-2 border-black w-20 text-center whitespace-nowrap">Other Expenses</th>
                  <th className="p-1.5 text-center w-20 bg-slate-800 whitespace-nowrap">Subtotal</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-black text-black font-black">
                {sheet.rows.map((row, idx) => {
                  const isSunday = row.days === 'Sun';
                  const routeLen = (row.route || '').length;
                  return (
                    <tr 
                      key={row.dayNumber} 
                      className={`transition-colors ${isSunday ? 'bg-rose-50/70 font-black' : 'hover:bg-amber-50/40'}`}
                    >
                      {/* Date */}
                      <td className="p-1 border-r-2 border-black text-center font-black align-middle">
                        <span className="font-mono text-[10px] whitespace-nowrap">
                          {String(row.date || '').length >= 10
                            ? `${String(row.date).slice(8, 10)}/${String(row.date).slice(5, 7)}/${String(row.date).slice(0, 4)}`
                            : (row.date || '-')}
                        </span>
                      </td>

                      {/* Days */}
                      <td className="p-1 border-r-2 border-black text-center font-black align-middle">
                        <span className={isSunday ? 'text-red-700' : 'text-slate-800'}>
                          {row.days}
                        </span>
                      </td>

                      {/* Route (Strictly single line, all village names clearly visible without cutting off) */}
                      <td className="p-0 pl-2 pr-1 border-r-2 border-black align-middle w-[410px] min-w-[390px]">
                        <input 
                          type="text" 
                          data-role="route"
                          value={row.route} 
                          title={row.route}
                          onKeyDown={e => handleRouteKeyDown(idx, e)}
                          onChange={e => updateRow(idx, { route: formatRouteVillages(e.target.value) })}
                          placeholder={isSunday ? "SUNDAY / OFF" : ""}
                          className={`w-full p-0 m-0 pl-1 pr-0.5 py-0.5 bg-transparent border-none focus:outline-none font-black text-left block leading-tight whitespace-nowrap tracking-tight ${
                            routeLen > 48
                              ? 'text-[7.5px]'
                              : routeLen > 36
                                ? 'text-[8.5px]'
                                : routeLen > 24
                                  ? 'text-[9.5px]'
                                  : 'text-[10.5px]'
                          }`}
                        />
                      </td>

                      {/* Opening KM */}
                      <td className="p-0.5 border-r-2 border-black align-middle">
                        <input 
                          type="number" 
                          value={row.openingKm || ''} 
                          onChange={e => updateRow(idx, { openingKm: Number(e.target.value) })} 
                          placeholder="0"
                          className="w-full px-1 py-0.5 bg-transparent border-none focus:outline-none font-black font-mono text-center text-[10.5px] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none m-0" 
                        />
                      </td>

                      {/* Closing KM */}
                      <td className="p-0.5 border-r-2 border-black align-middle">
                        <input 
                          type="number" 
                          value={row.closingKm || ''} 
                          onChange={e => updateRow(idx, { closingKm: Number(e.target.value) })} 
                          placeholder="0"
                          className="w-full px-1 py-0.5 bg-transparent border-none focus:outline-none font-black font-mono text-center text-[10.5px] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none m-0" 
                        />
                      </td>

                      {/* KM (Auto calculated: Closing KM - Opening KM) */}
                      <td className="p-1 border-r-2 border-black text-center font-mono font-black text-blue-800 bg-slate-50/70 align-middle">
                        {row.km || 0}
                      </td>

                      {/* Amount (Manual Input - No arrows) */}
                      <td className="p-0.5 border-r-2 border-black align-middle">
                        <input 
                          type="number" 
                          value={row.amount || ''} 
                          onChange={e => updateRow(idx, { amount: e.target.value === '' ? 0 : Number(e.target.value) })} 
                          placeholder="0"
                          className="w-full px-1 py-0.5 bg-transparent border-none focus:outline-none font-black font-mono text-center text-[10.5px] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none m-0" 
                        />
                      </td>

                      {/* Other Expenses (No arrows) */}
                      <td className="p-0.5 border-r-2 border-black align-middle">
                        <input 
                          type="number" 
                          value={row.otherExpenses || ''} 
                          onChange={e => updateRow(idx, { otherExpenses: Number(e.target.value) })} 
                          placeholder="0"
                          className="w-full px-1 py-0.5 bg-transparent border-none focus:outline-none font-black font-mono text-center text-[10.5px] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none m-0" 
                        />
                      </td>

                      {/* Subtotal (Amount + Other Expenses) */}
                      <td className="p-1 text-center font-mono font-black text-emerald-800 bg-emerald-50/50 align-middle whitespace-nowrap">
                        <span className="inline-flex items-center justify-center gap-0.5 whitespace-nowrap tabular-nums">
                          ₹ {(Number(row.subtotal) || 0).toFixed(2)}
                        </span>
                      </td>
                    </tr>
                  );
                })}

                {/* Table Total Summary Row */}
                <tr className="bg-slate-900 text-white font-black text-xs uppercase border-t-2 border-black">
                  <td colSpan={3} className="p-2 text-center tracking-tight border-r-2 border-black font-black whitespace-nowrap">
                    TOTAL
                  </td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black whitespace-nowrap">-</td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black whitespace-nowrap">-</td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black whitespace-nowrap">{Number(sheet.totalKm) || 0}</td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black whitespace-nowrap">
                    <span className="inline-flex items-center justify-center gap-0.5 whitespace-nowrap tabular-nums">
                      ₹ {(Number(sheet.totalAmount) || 0).toFixed(2)}
                    </span>
                  </td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black whitespace-nowrap">
                    <span className="inline-flex items-center justify-center gap-0.5 whitespace-nowrap tabular-nums">
                      ₹ {(Number(sheet.totalOtherExpenses) || 0).toFixed(2)}
                    </span>
                  </td>
                  <td className="p-2 text-center font-mono font-black bg-red-600 text-white whitespace-nowrap">
                    <span className="inline-flex items-center justify-center gap-0.5 whitespace-nowrap tabular-nums">
                      ₹ {(Number(sheet.subtotalAmount) || 0).toFixed(2)}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 5. Bottom Calculation & Summary Section (Exact options: Subtotal, Total Expenses Amount) */}
          <div className="border-t-2 border-black bg-white grid grid-cols-2 divide-x-2 divide-black text-[12px] font-black">
            
            {/* Subtotal */}
            <div className="p-3 bg-slate-50 flex flex-col items-center justify-center text-center">
              <span className="text-[10px] text-slate-700 uppercase tracking-tight">Subtotal</span>
              <span className="text-base font-mono text-slate-900 font-black mt-0.5 whitespace-nowrap inline-flex items-center justify-center gap-1 tabular-nums">
                <span>₹</span>
                <span>{(Number(sheet.subtotalAmount) || 0).toFixed(2)}</span>
              </span>
            </div>

            {/* Total Expenses Amount */}
            <div className="p-3 bg-red-50 flex flex-col items-center justify-center text-center">
              <span className="text-[10px] text-red-700 uppercase tracking-tight">Total Expenses Amount</span>
              <span className="text-lg font-mono text-red-700 font-black mt-0.5 whitespace-nowrap inline-flex items-center justify-center gap-1 tabular-nums">
                <span>₹</span>
                <span>{(Number(sheet.totalExpensesAmount) || 0).toFixed(2)}</span>
              </span>
            </div>
          </div>

          {/* 6. Signatures Footer */}
          <div className="p-4 bg-white border-t-2 border-black flex justify-between items-end">
            <div className="text-center w-64 max-w-[48%]">
              <div className="min-h-[40px] flex items-center justify-center p-1">
                <span className="text-[11px] font-black text-slate-800 uppercase break-words leading-tight text-center">
                  {sheet.officerName}
                </span>
              </div>
              <div className="border-t-2 border-black pt-1">
                <span className="font-black text-black uppercase text-[10px]">Officer Signature</span>
              </div>
            </div>

            <div className="text-center w-64 max-w-[48%]">
              <div className="min-h-[40px] flex items-center justify-center p-1">
                <span className="text-[11px] font-black text-slate-800 uppercase">DIRECTOR / MD</span>
              </div>
              <div className="border-t-2 border-black pt-1">
                <span className="font-black text-black uppercase text-[10px]">Authorized Signatory</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
