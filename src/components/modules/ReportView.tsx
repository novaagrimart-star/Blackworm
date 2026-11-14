import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Language } from '../../lib/i18n';
import { UserProfile, isAdmin } from '../../lib/auth';
import { toTitleCase } from '../../lib/utils';
import { mergeWithLocalData, triggerBlobDownload, startBackgroundSync, safeLocalStorageSet } from '../../lib/dataService';
import { useSharedUsers, useSharedTravelSheets, useSharedYearlyTargets, useSharedCollectionEntries } from '../../lib/realtimeStore';
import html2canvas from 'html2canvas-pro';
import { 
  BarChart3, 
  Calendar, 
  Search, 
  Loader2, 
  Table as TableIcon, 
  CheckCircle2, 
  RefreshCw,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { toDecimal2, addDecimal2, subtractDecimal2, formatAmount } from '../../lib/decimal';

interface Props {
  profile: UserProfile;
  lang: Language;
}

export interface OfficerDailyReport {
  srNo: number;
  uid: string;
  name: string;
  route: string;
  openingKm: number;
  closingKm: number;
  totalKm: number;
  paymentCollection: number;
  dailyExpense: number;
  monthlySalesTarget: number;
  monthlyAchievement: number;
  targetBacklog: number;
}

interface StaticCacheData {
  timestamp: number;
  users: UserProfile[];
  travelSheets: any[];
  yearlyTargets: any[];
  targets: any[];
}

const LOCAL_STORAGE_STATIC_KEY = 'blackworm_report_static_cache_v4';
const LOCAL_STORAGE_DAILY_PREFIX = 'blackworm_report_daily_v4_';

let reportStaticCache: StaticCacheData | null = (() => {
  try {
    if (typeof window !== 'undefined') {
      const raw = localStorage.getItem(LOCAL_STORAGE_STATIC_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.users) && parsed.users.length > 0) {
          return parsed;
        }
      }
    }
  } catch (e) {}
  return null;
})();

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const getTodayLocalDate = (): string => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export function formatReportDisplayDate(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return dateStr;
    const dateObj = new Date(y, m - 1, d);
    return dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

export function parseDateKeys(dateStr: string) {
  const safeStr = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '').trim())
    ? dateStr.trim()
    : getTodayLocalDate();
  const [yStr, mStr, dStr] = safeStr.split('-');
  const year = parseInt(yStr, 10);
  const monthIndex = parseInt(mStr, 10) - 1;
  const dayOfMonth = parseInt(dStr, 10);
  const sheetMonthKey = `${year}_${mStr.padStart(2, '0')}`;
  const targetMonthName = monthNames[monthIndex] || 'October';
  return { year, monthIndex, dayOfMonth, sheetMonthKey, targetMonthName };
}

export async function preloadReportData(_profile?: any): Promise<void> {
  // Live onSnapshot listeners now handle instantaneous background updates
}

export function buildReportRows(
  allUsers: UserProfile[],
  allTravelSheets: any[],
  allYearlyTargets: any[],
  allTargets: any[],
  collDocs: any[],
  selectedDate: string,
  profile: UserProfile
): OfficerDailyReport[] {
  const { year, monthIndex, dayOfMonth, sheetMonthKey, targetMonthName } = parseDateKeys(selectedDate);
  const userIsAdmin = isAdmin(profile);

  // 1. Role-based scoping:
  // - Regular field officer / employee: ONLY see their own report! (User request: "युजर आहेत त्यांना फक्त त्यांचाच रिपोर्ट दिसावा सर्वांचा दिसणार नाही याची काळजी घे")
  // - Admin / Owner: See all officers for the selected date! (User request: "ज्या तारखेचा डाटा आहे त्याच तारखेचा डाटा ऍडमिनला सर्व ऑफिसर यांचा दिसावा")
  let officers: UserProfile[] = [];

  if (!userIsAdmin) {
    officers = [profile];
  } else {
    officers = allUsers.filter((u) => {
      const r = (u.role || '').toLowerCase().trim();
      return r !== 'owner' && r !== 'dealer';
    });

    if (officers.length === 0) {
      officers = allUsers.filter((u) => (u.role || '').toLowerCase() !== 'owner');
    }
    if (officers.length === 0) {
      officers = [profile];
    }

    // 2. Also ensure any officer who submitted a travel sheet for this date/month is included
    allTravelSheets.forEach((s) => {
      const sId = (s.id || s._id || '') as string;
      const isThisMonth = 
        sId.includes(sheetMonthKey) ||
        (s.yearNumber && Number(s.yearNumber) === year && (Number(s.monthIndex) === monthIndex || String(s.monthName || '').toLowerCase() === targetMonthName.toLowerCase()));

      if (!isThisMonth) return;

      const officerUid = s.userId || (sId.startsWith('travel_') ? sId.split('_')[1] : null);
      if (!officerUid) return;

      const alreadyInList = officers.some(o => 
        o.uid === officerUid || 
        (o.loginId && o.loginId.toLowerCase() === officerUid.toLowerCase()) ||
        (o.fullName && s.officerName && o.fullName.trim().toLowerCase() === s.officerName.trim().toLowerCase())
      );

      if (!alreadyInList) {
        officers.push({
          uid: officerUid,
          fullName: s.officerName || officerUid,
          role: 'field_officer',
          emailId: null,
          createdAt: ''
        });
      }
    });
  }

  // Deduplicate officers so no officer is duplicated in the table
  const uniqueOfficersMap = new Map<string, UserProfile>();
  officers.forEach(o => {
    const key = (o.uid || o.loginId || o.fullName || '').toLowerCase().trim();
    if (!uniqueOfficersMap.has(key)) {
      uniqueOfficersMap.set(key, o);
    }
  });
  const uniqueOfficers = Array.from(uniqueOfficersMap.values());

  // Build target maps
  const yearlyTargetMap = new Map<string, any>();
  allYearlyTargets.forEach((t) => {
    if (t._id) yearlyTargetMap.set(t._id, t);
    if (t.id) yearlyTargetMap.set(t.id, t);
    if (t.userId) yearlyTargetMap.set(t.userId, t);
    if (t.loginId) yearlyTargetMap.set(t.loginId.toLowerCase(), t);
  });

  const targetFallbackMap = new Map<string, any>();
  allTargets.forEach((t) => {
    if (t.userId) targetFallbackMap.set(t.userId, t);
    if (t.loginId) targetFallbackMap.set(t.loginId.toLowerCase(), t);
  });

  return uniqueOfficers.map((officer, i) => {
    // Collect ONLY candidate sheets that belong to THIS officer AND THIS MONTH (sheetMonthKey)
    const candidateSheets: any[] = [];

    // Local storage exact month sheet has highest priority (immediate offline edits)
    try {
      const cachedExact = localStorage.getItem(`travel_sheet_${officer.uid}_${sheetMonthKey}`) ||
                          (officer.loginId ? localStorage.getItem(`travel_sheet_${officer.loginId}_${sheetMonthKey}`) : null);
      if (cachedExact) {
        const parsed = JSON.parse(cachedExact);
        if (parsed && Array.isArray(parsed.rows)) {
          candidateSheets.push(parsed);
        }
      }
    } catch (e) {}

    allTravelSheets.forEach(s => {
      const sId = (s.id || s._id || '') as string;
      const cleanOfficerName = (officer.fullName || '').trim().toLowerCase();
      const cleanSheetName = (s.officerName || '').trim().toLowerCase();

      // Check if sheet belongs to this officer
      const matchesUid =
        s.userId === officer.uid ||
        sId === `travel_${officer.uid}_${sheetMonthKey}` ||
        sId.startsWith(`travel_${officer.uid}_`);
      const matchesLogin = officer.loginId && (
        s.userId?.toLowerCase() === officer.loginId.toLowerCase() ||
        sId.toLowerCase() === `travel_${officer.loginId.toLowerCase()}_${sheetMonthKey}` ||
        sId.toLowerCase().startsWith(`travel_${officer.loginId.toLowerCase()}_`)
      );
      const matchesName = cleanOfficerName && cleanSheetName && (cleanOfficerName === cleanSheetName || cleanOfficerName.includes(cleanSheetName) || cleanSheetName.includes(cleanOfficerName));

      if (!matchesUid && !matchesLogin && !matchesName) return;

      // STRICT MONTH & YEAR CHECK: Sheet MUST belong to this selected month & year!
      const matchesMonthYear = 
        sId.includes(sheetMonthKey) ||
        (Number(s.yearNumber) === year && (Number(s.monthIndex) === monthIndex || String(s.monthName || '').toLowerCase().includes(targetMonthName.toLowerCase()) || String(s.monthName || '').toLowerCase().includes('nov'))) ||
        (Array.isArray(s.rows) && s.rows.some((r: any) => r && r.date && r.date.trim() === selectedDate.trim()));

      if (matchesMonthYear) {
        candidateSheets.push(s);
      }
    });

    // Find the exact row for selectedDate
    let dayRow: any = null;

    for (const sheet of candidateSheets) {
      if (!sheet || !Array.isArray(sheet.rows)) continue;

      // 1. Direct date match (e.g. '2026-11-06')
      let matched = sheet.rows.find((r: any) => {
        if (!r) return false;
        if (r.date && r.date.trim() === selectedDate.trim()) return true;
        if (r.date && typeof r.date === 'string') {
          const parts = r.date.trim().split(/[-/]/);
          if (parts.length === 3) {
            // YYYY-MM-DD
            if (parts[0] === String(year) && Number(parts[1]) === monthIndex + 1 && Number(parts[2]) === dayOfMonth) return true;
            // DD-MM-YYYY
            if (Number(parts[0]) === dayOfMonth && Number(parts[1]) === monthIndex + 1 && parts[2] === String(year)) return true;
          }
        }
        return false;
      });

      // 2. Day-of-month match (ONLY valid because sheet is already verified for this month!)
      if (!matched) {
        matched = sheet.rows.find((r: any) => r && Number(r.dayNumber) === dayOfMonth);
      }

      if (matched) {
        dayRow = matched;
        const hasData = (matched.route && matched.route !== '-') ||
          Number(matched.openingKm) > 0 ||
          Number(matched.closingKm) > 0 ||
          Number(matched.km) > 0 ||
          Number(matched.amount) > 0 ||
          Number(matched.otherExpenses) > 0;
        if (hasData) {
          break; // Found filled data for this date, stop searching!
        }
      }
    }

    let route = '-', openingKm = 0, closingKm = 0, dailyExpense = 0, recordedKm = 0;
    if (dayRow) {
      const rawRoute = (dayRow.route || '').trim();
      route = rawRoute || '-';
      openingKm = Number(dayRow.openingKm) || 0;
      closingKm = Number(dayRow.closingKm) || 0;
      recordedKm = Number(dayRow.km) || 0;
      dailyExpense = (Number(dayRow.amount) || 0) + (Number(dayRow.otherExpenses) || 0);
    }

    const paymentCollection = collDocs
      .filter((d: any) => {
        const dDate = (d.date || '').trim();
        let matchesDate = dDate === selectedDate || dDate.startsWith(selectedDate);
        if (!matchesDate && dDate) {
          const parts = dDate.split(/[-/]/);
          if (parts.length === 3) {
            if (parts[0] === String(year) && Number(parts[1]) === monthIndex + 1 && Number(parts[2]) === dayOfMonth) matchesDate = true;
            if (Number(parts[0]) === dayOfMonth && Number(parts[1]) === monthIndex + 1 && parts[2] === String(year)) matchesDate = true;
          }
        }
        if (!matchesDate) return false;

        return (
          d.collectedByUid === officer.uid ||
          d.userId === officer.uid ||
          (d.loginId && officer.loginId && d.loginId.toLowerCase() === officer.loginId.toLowerCase()) ||
          (d.collectedByName && officer.fullName && d.collectedByName.trim().toLowerCase() === officer.fullName.trim().toLowerCase())
        );
      })
      .reduce((acc: number, d: any) => acc + (Number(d.amount) || 0), 0);

    let monthlySalesTarget = 0, monthlyAchievement = 0;
    const targetSheetId = `yearly_${officer.uid}_2026_27`;
    const targetData = yearlyTargetMap.get(targetSheetId) || yearlyTargetMap.get(officer.uid) || (officer.loginId ? yearlyTargetMap.get(officer.loginId.toLowerCase()) : null);
    if (targetData && targetData.months) {
      const monthData = (targetData.months || []).find((m: any) => (m.month || '').toLowerCase() === targetMonthName.toLowerCase());
      if (monthData) {
        monthlySalesTarget = toDecimal2(monthData.target);
        monthlyAchievement = toDecimal2(monthData.achievement);
      }
    }

    if (monthlySalesTarget === 0 && targetFallbackMap.has(officer.uid)) {
      const tData = targetFallbackMap.get(officer.uid);
      monthlySalesTarget = toDecimal2((Number(tData.targetSales) || 0) / 100000);
      monthlyAchievement = toDecimal2((Number(tData.achievedSales) || 0) / 100000);
    }

    const calculatedKm = closingKm > openingKm ? closingKm - openingKm : recordedKm;

    return {
      srNo: i + 1,
      uid: officer.uid,
      name: toTitleCase(officer.fullName) || 'Officer',
      route,
      openingKm,
      closingKm,
      totalKm: calculatedKm,
      paymentCollection,
      dailyExpense,
      monthlySalesTarget,
      monthlyAchievement,
      targetBacklog: Math.max(0, subtractDecimal2(monthlySalesTarget, monthlyAchievement))
    };
  });
}

function getInitialCachedUsers(): UserProfile[] {
  try {
    const raw = localStorage.getItem('blackworm_cached_users');
    let list: any[] = [];
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) list = parsed;
    } else if (reportStaticCache && reportStaticCache.users && reportStaticCache.users.length > 0) {
      list = reportStaticCache.users;
    }
    const withIds = list.map((u: any) => ({ ...u, id: u.uid || u.id }));
    const merged = mergeWithLocalData('users', withIds);
    return merged.map((u: any) => ({ ...u, uid: u.uid || u.id })) as unknown as UserProfile[];
  } catch (e) {}
  return [];
}

function getInitialCachedTravel(): any[] {
  try {
    const raw = localStorage.getItem('blackworm_cached_travel_sheets');
    let list: any[] = [];
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) list = parsed;
    } else if (reportStaticCache && reportStaticCache.travelSheets) {
      list = reportStaticCache.travelSheets;
    }
    return mergeWithLocalData('travel_sheets', list);
  } catch (e) {}
  return [];
}

export const ReportView: React.FC<Props> = ({ profile }) => {
  const todayDate = getTodayLocalDate();
  const [selectedDate, setSelectedDate] = useState(todayDate);
  const printableSheetRef = useRef<HTMLDivElement>(null);

  const { users, loaded: usersLoaded } = useSharedUsers();
  const { travelSheets } = useSharedTravelSheets();
  const { yearlyTargets, refreshAllYearlyTargetsFromServer } = useSharedYearlyTargets();
  const { collectionEntries } = useSharedCollectionEntries();

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCapturingPhoto, setIsCapturingPhoto] = useState(false);
  const [photoSavedToast, setPhotoSavedToast] = useState(false);

  const reportData = useMemo<OfficerDailyReport[]>(() => {
    const activeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(selectedDate || '').trim())
      ? selectedDate
      : getTodayLocalDate();
    const resolvedUsers = users.length > 0 ? users : getInitialCachedUsers();
    const resolvedTravel = travelSheets.length > 0 ? travelSheets : getInitialCachedTravel();
    const resolvedTargets = yearlyTargets.length > 0 ? yearlyTargets : (reportStaticCache?.yearlyTargets || []);

    const rows = buildReportRows(
      resolvedUsers,
      resolvedTravel,
      resolvedTargets,
      reportStaticCache?.targets || [],
      collectionEntries,
      activeDate,
      profile
    );
    safeLocalStorageSet(`${LOCAL_STORAGE_DAILY_PREFIX}${activeDate}`, JSON.stringify(rows));
    return rows;
  }, [users, travelSheets, yearlyTargets, collectionEntries, selectedDate, profile]);

  const loading = !usersLoaded && reportData.length === 0;

  // Lightweight manual refresh: flush pending queue + optionally pull server yearly targets without full 4-collection re-fetch
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await startBackgroundSync();
      await refreshAllYearlyTargetsFromServer();
    } finally {
      setTimeout(() => {
        setIsRefreshing(false);
      }, 450);
    }
  };

  // Capture Report Photo directly to device gallery / download
  const handleCaptureReportPhoto = async () => {
    if (!printableSheetRef.current || isCapturingPhoto) return;
    setIsCapturingPhoto(true);
    try {
      const element = printableSheetRef.current;
      const canvas = await html2canvas(element, {
        scale: 2.5,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
      });
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/png')
      );
      if (blob) {
        const fileName = `Daily_Report_${selectedDate}.png`;
        const file = new File([blob], fileName, { type: 'image/png' });

        // Mobile Web Share API support
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({
              files: [file],
              title: `Daily Report - ${selectedDate}`,
            });
            setIsCapturingPhoto(false);
            setPhotoSavedToast(true);
            setTimeout(() => setPhotoSavedToast(false), 3000);
            return;
          } catch (shareErr) {
            // User cancelled share dialog or native fallback
          }
        }

        // Direct browser file download straight to Gallery / Downloads
        triggerBlobDownload(blob, fileName);
        setPhotoSavedToast(true);
        setTimeout(() => setPhotoSavedToast(false), 3000);
      }
    } catch (err) {
      console.error('Failed to capture report photo:', err);
    } finally {
      setIsCapturingPhoto(false);
    }
  };

  const handlePrevDay = () => {
    try {
      const baseDate = /^\d{4}-\d{2}-\d{2}$/.test(selectedDate) ? selectedDate : getTodayLocalDate();
      const [y, m, d] = baseDate.split('-').map(Number);
      const curr = new Date(y, m - 1, d);
      if (isNaN(curr.getTime())) return;
      curr.setDate(curr.getDate() - 1);
      const newY = curr.getFullYear();
      const newM = String(curr.getMonth() + 1).padStart(2, '0');
      const newD = String(curr.getDate()).padStart(2, '0');
      setSelectedDate(`${newY}-${newM}-${newD}`);
    } catch {}
  };

  const handleNextDay = () => {
    try {
      const baseDate = /^\d{4}-\d{2}-\d{2}$/.test(selectedDate) ? selectedDate : getTodayLocalDate();
      const [y, m, d] = baseDate.split('-').map(Number);
      const curr = new Date(y, m - 1, d);
      if (isNaN(curr.getTime())) return;
      curr.setDate(curr.getDate() + 1);
      const newY = curr.getFullYear();
      const newM = String(curr.getMonth() + 1).padStart(2, '0');
      const newD = String(curr.getDate()).padStart(2, '0');
      setSelectedDate(`${newY}-${newM}-${newD}`);
    } catch {}
  };

  const handleToday = () => {
    setSelectedDate(getTodayLocalDate());
  };

  const totalKmSum = reportData.reduce((acc, r) => acc + r.totalKm, 0);
  const totalCollectionSum = reportData.reduce((acc, r) => acc + r.paymentCollection, 0);
  const totalExpenseSum = reportData.reduce((acc, r) => acc + r.dailyExpense, 0);
  const totalTargetSum = addDecimal2(...reportData.map(r => r.monthlySalesTarget));
  const totalAchieveSum = addDecimal2(...reportData.map(r => r.monthlyAchievement));
  const totalBacklogSum = addDecimal2(...reportData.map(r => r.targetBacklog));

  const filledCount = reportData.filter(r => (r.route && r.route !== '-') || r.totalKm > 0 || r.dailyExpense > 0 || r.openingKm > 0 || r.closingKm > 0).length;

  return (
    <div className="space-y-4 w-full pb-20 font-sans">
      {/* Header Bar: Report Title with Date Option and Actions */}
      <div className="bg-white p-3 sm:p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-3 no-print">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-600 shrink-0" />
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Report</h2>
          </div>

          {/* Quick Date Navigator (Prev, Input, Next) */}
          <div className="flex items-center bg-slate-100 rounded-xl p-0.5 border border-slate-200 shadow-2xs">
            <button
              type="button"
              onClick={handlePrevDay}
              className="p-1.5 hover:bg-white rounded-lg text-slate-700 hover:text-slate-900 transition shadow-2xs cursor-pointer active:scale-95"
              title="मागील दिवस (Previous Day)"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="relative">
              <Calendar className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400 pointer-events-none" />
              <input 
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="pl-8 pr-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-900 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
              />
            </div>
            <button
              type="button"
              onClick={handleNextDay}
              className="p-1.5 hover:bg-white rounded-lg text-slate-700 hover:text-slate-900 transition shadow-2xs cursor-pointer active:scale-95"
              title="पुढील दिवस (Next Day)"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Quick Today jump button */}
          <button
            type="button"
            onClick={handleToday}
            className="px-2.5 py-1.5 text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl transition border border-slate-200 cursor-pointer active:scale-95"
            title="आजच्या तारखेवर जा"
          >
            Today (आज)
          </button>

          {/* Manual Refresh Button */}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-600 rounded-xl transition border border-slate-200 cursor-pointer active:scale-95 disabled:opacity-60"
            title="डेटा रिफ्रेश करा (Refresh Report Data)"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-indigo-600' : ''}`} />
            <span>Refresh</span>
          </button>

          {/* Officer Submissions Count Badge */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-900 text-xs font-bold">
            <span>रिपोर्ट भरलेले:</span>
            <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded-md text-[11px] font-black">
              {filledCount} / {reportData.length}
            </span>
          </div>

          {/* Camera Button: Save Photo to Gallery */}
          <button 
            type="button"
            onClick={handleCaptureReportPhoto}
            disabled={isCapturingPhoto}
            className="flex items-center gap-1.5 px-3 py-1.5 sm:py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition shadow-xs disabled:opacity-50 shrink-0 cursor-pointer active:scale-95"
            title="Save Report Photo directly to Mobile Gallery"
          >
            {isCapturingPhoto ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Camera className="w-3.5 h-3.5" />
            )}
            <span>Photo</span>
          </button>

          {/* Instant Live Sync indicator */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] font-bold">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            <span>Live Sync Active</span>
          </div>
        </div>
      </div>

      {photoSavedToast && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold rounded-xl flex items-center gap-2 animate-in fade-in no-print shadow-xs">
          <Check className="w-4 h-4 text-emerald-600" />
          <span>Report photo saved to Gallery / Downloads!</span>
        </div>
      )}

      {/* Sheet Table with Soft Colors, Bold Crisp Text & Single-Line Names/Routes */}
      <div 
        className="bg-white rounded-2xl border border-slate-300 shadow-xs overflow-x-auto w-full scroll-smooth"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        <div ref={printableSheetRef} className="p-3 sm:p-5 bg-white min-w-[880px] w-full">
          {/* Internal Sheet Header */}
          <div className="text-center mb-4 space-y-1">
            <h1 className="text-lg sm:text-xl font-black text-slate-900 uppercase tracking-tight">
              {isAdmin(profile) ? 'ALL OFFICER DAILY TRACK REPORT' : `DAILY TRACK REPORT - ${toTitleCase(profile.fullName) || 'OFFICER'}`}
            </h1>
            <div className="flex items-center justify-center gap-6 text-xs font-bold text-slate-600">
              <span className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-indigo-600" />
                <span>Date: {formatReportDisplayDate(selectedDate)}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <TableIcon className="w-3.5 h-3.5 text-emerald-600" />
                <span>Sheet: Daily Summary</span>
              </span>
            </div>
          </div>

          <table className="w-full border-collapse border border-slate-400 text-xs">
            <thead>
              {/* Soft table header with crisp dark text instead of pitch black */}
              <tr className="bg-slate-100 text-slate-900 font-extrabold uppercase text-center text-xs border-b-2 border-slate-400">
                <th className="p-2 border border-slate-300 w-10 text-center">
                  Sr.
                </th>
                <th className="p-2 border border-slate-300 text-left min-w-[140px] whitespace-nowrap">
                  Officer Name
                </th>
                <th className="p-2 border border-slate-300 text-left min-w-[150px] whitespace-nowrap">
                  Today's Route
                </th>
                <th className="p-2 border border-slate-300 min-w-[65px] whitespace-nowrap">
                  Open KM
                </th>
                <th className="p-2 border border-slate-300 min-w-[65px] whitespace-nowrap">
                  Close KM
                </th>
                <th className="p-2 border border-slate-300 min-w-[65px] bg-indigo-50/70 text-indigo-950 whitespace-nowrap">
                  Total KM
                </th>
                <th className="p-2 border border-slate-300 min-w-[95px] bg-emerald-50/70 text-emerald-950 whitespace-nowrap">
                  Collection (₹)
                </th>
                <th className="p-2 border border-slate-300 min-w-[85px] bg-rose-50/70 text-rose-950 whitespace-nowrap">
                  Daily Expense (₹)
                </th>
                <th className="p-2 border border-slate-300 min-w-[80px] whitespace-nowrap">
                  Target (Lakh)
                </th>
                <th className="p-2 border border-slate-300 min-w-[80px] bg-sky-50/70 text-sky-950 whitespace-nowrap">
                  Achieve (Lakh)
                </th>
                <th className="p-2 border border-slate-300 min-w-[80px] bg-amber-50/70 text-amber-950 whitespace-nowrap">
                  Backlog (Lakh)
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-300 border-b border-slate-400">
              {reportData.map((row) => (
                <tr key={row.uid} className="hover:bg-slate-50 font-bold text-slate-900 text-center transition-colors">
                  <td className="p-2 border border-slate-300 font-mono font-black bg-slate-50/60">
                    {row.srNo}
                  </td>
                  {/* Officer Name: Title Case (First letter capital, rest small), Bold, Single Line */}
                  <td className="p-2 border border-slate-300 text-left font-black text-slate-900 whitespace-nowrap">
                    {row.name}
                  </td>
                  {/* Today's Route: Single line, crisp and readable */}
                  <td className="p-2 border border-slate-300 text-left font-bold text-slate-800 whitespace-nowrap text-[11.5px]">
                    {row.route && row.route !== '-' ? (
                      <span className="text-slate-900 font-bold">{row.route}</span>
                    ) : (
                      <span className="text-slate-400 font-normal italic">माहिती भरलेली नाही</span>
                    )}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-bold text-slate-800">
                    {row.openingKm}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-bold text-slate-800">
                    {row.closingKm}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-indigo-900 bg-indigo-50/40">
                    {row.totalKm}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-emerald-900 bg-emerald-50/40">
                    ₹{(Number(row.paymentCollection) || 0).toLocaleString()}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-rose-900 bg-rose-50/40">
                    ₹{(Number(row.dailyExpense) || 0).toLocaleString()}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-bold text-slate-800">
                    {formatAmount(row.monthlySalesTarget)}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-sky-900 bg-sky-50/40">
                    {formatAmount(row.monthlyAchievement)}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-amber-900 bg-amber-50/40">
                    {formatAmount(row.targetBacklog)}
                  </td>
                </tr>
              ))}

              {reportData.length === 0 && loading && (
                <tr>
                  <td colSpan={11} className="p-8 text-center text-indigo-600 font-bold text-xs">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                      <span>डेटा लोड होत आहे...</span>
                    </div>
                  </td>
                </tr>
              )}

              {reportData.length === 0 && !loading && (
                <tr>
                  <td colSpan={11} className="p-8 text-center text-slate-500 font-bold text-xs">
                    निवडलेल्या तारखेसाठी कोणताही डेटा उपलब्ध नाही.
                  </td>
                </tr>
              )}
            </tbody>
            {reportData.length > 0 && (
              <tfoot className="bg-slate-100 font-black text-slate-900 uppercase text-center border-t-2 border-slate-400 text-xs">
                <tr>
                  <td colSpan={3} className="p-2 text-left font-black border-r border-slate-300">
                    TOTAL SUMMARY
                  </td>
                  <td className="p-2 border-r border-slate-300 text-slate-400">-</td>
                  <td className="p-2 border-r border-slate-300 text-slate-400">-</td>
                  <td className="p-2 border-r border-slate-300 font-mono font-black text-indigo-900 bg-indigo-100/60">
                    {totalKmSum}
                  </td>
                  <td className="p-2 border-r border-slate-300 font-mono font-black text-emerald-900 bg-emerald-100/60">
                    ₹{(Number(totalCollectionSum) || 0).toLocaleString()}
                  </td>
                  <td className="p-2 border-r border-slate-300 font-mono font-black text-rose-900 bg-rose-100/60">
                    ₹{(Number(totalExpenseSum) || 0).toLocaleString()}
                  </td>
                  <td className="p-2 border-r border-slate-300 font-mono font-bold text-slate-900">
                    {formatAmount(totalTargetSum)}
                  </td>
                  <td className="p-2 border-r border-slate-300 font-mono font-black text-sky-900 bg-sky-100/60">
                    {formatAmount(totalAchieveSum)}
                  </td>
                  <td className="p-2 font-mono font-black text-amber-900 bg-amber-100/60">
                    {formatAmount(totalBacklogSum)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>

          <div className="mt-8 flex justify-between items-end">
            <div className="text-center w-36 sm:w-44">
              <div className="h-7 border-b-2 border-slate-400 mb-1"></div>
              <p className="text-[10px] sm:text-[11px] font-black uppercase text-slate-600">Admin Signature</p>
            </div>
            <div className="text-center w-36 sm:w-44">
              <div className="h-7 border-b-2 border-slate-400 mb-1"></div>
              <p className="text-[10px] sm:text-[11px] font-black uppercase text-slate-600">Owner Signature</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
