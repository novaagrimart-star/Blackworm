import React, { useState, useEffect, useRef } from 'react';
import { collection, query, getDocs, where, doc, getDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../../firebase';
import { Language } from '../../lib/i18n';
import { UserProfile, isAdmin } from '../../lib/auth';
import { 
  BarChart3, 
  Calendar,
  Search,
  Loader2,
  Table as TableIcon,
  CheckCircle2,
  RefreshCw,
  AlertCircle
} from 'lucide-react';
import { toDecimal2, addDecimal2, subtractDecimal2, formatAmount } from '../../lib/decimal';
import { useUsers } from '../../lib/UsersContext';

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

const LOCAL_STORAGE_STATIC_KEY = 'blackworm_report_static_cache_v3';
const LOCAL_STORAGE_DAILY_PREFIX = 'blackworm_report_daily_v3_';

// In-memory cache for instant zero-latency access across tab switches
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

export function parseDateKeys(dateStr: string) {
  const [yStr, mStr, dStr] = dateStr.split('-');
  const year = parseInt(yStr, 10);
  const monthIndex = parseInt(mStr, 10) - 1;
  const dayOfMonth = parseInt(dStr, 10);
  const sheetMonthKey = `${year}_${mStr.padStart(2, '0')}`;
  const targetMonthName = monthNames[monthIndex] || 'October';
  return { year, monthIndex, dayOfMonth, sheetMonthKey, targetMonthName };
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
  const userIsAdmin = isAdmin(profile);
  const { dayOfMonth, sheetMonthKey, targetMonthName } = parseDateKeys(selectedDate);

  let officers = userIsAdmin
    ? allUsers.filter((u) => u.role !== 'owner' && u.role !== 'dealer')
    : allUsers.filter((u) => u.uid === profile.uid || (u.loginId && profile.loginId && u.loginId.toLowerCase() === profile.loginId.toLowerCase()));

  if (officers.length === 0) {
    officers = [profile];
  }

  // Build high-performance multi-tier lookup maps for all travel sheets
  const travelMap = new Map<string, any>();
  allTravelSheets.forEach((s) => {
    const docId = s.id || s._id || '';
    if (docId) travelMap.set(docId, s);

    // Compute month key from sheet (Case-insensitive to handle legacy data)
    const sMonthIdx = monthNames.findIndex(m => m.toLowerCase() === String(s.monthName || '').toLowerCase());
    const sMonthKey = s.sheetMonthKey || 
      (s.yearNumber && sMonthIdx !== -1 ? `${s.yearNumber}_${String(sMonthIdx + 1).padStart(2, '0')}` : sheetMonthKey);

    if (s.userId) {
      travelMap.set(`${s.userId}_${sMonthKey}`, s);
      travelMap.set(s.userId, s);
    }
    if (s.userCode) {
      const code = String(s.userCode).trim().toLowerCase();
      travelMap.set(`code_${code}_${sMonthKey}`, s);
      travelMap.set(`code_${code.replace(/^emp-/, '')}_${sMonthKey}`, s);
    }
    if (s.loginId) {
      travelMap.set(`login_${String(s.loginId).trim().toLowerCase()}_${sMonthKey}`, s);
    }
  });

  const yearlyTargetMap = new Map<string, any>();
  allYearlyTargets.forEach((t) => {
    if (t._id) yearlyTargetMap.set(t._id, t);
    if (t.id) yearlyTargetMap.set(t.id, t);
    if (t.userId) yearlyTargetMap.set(t.userId, t);
  });

  const targetFallbackMap = new Map<string, any>();
  // allTargets is kept for internal fallback if yearly_targets is missing
  (allTargets || []).forEach((t) => {
    if (t.userId) targetFallbackMap.set(t.userId, t);
  });

  return officers.map((officer, i) => {
    const officerUid = String(officer.uid || '').trim();
    const officerCode = String(officer.userCode || '').trim().toLowerCase();
    const officerLogin = String(officer.loginId || '').trim().toLowerCase();

    const travelSheetId = `travel_${officer.uid}_${sheetMonthKey}`;

    // Lookup across robust unique matching tiers (UID, Code, Login)
    // Removed name-based fallback to prevent cross-user data leakage if names are identical
    const travelData = 
      travelMap.get(travelSheetId) ||
      travelMap.get(`${officerUid}_${sheetMonthKey}`) ||
      (officerCode ? (travelMap.get(`code_${officerCode}_${sheetMonthKey}`) || travelMap.get(`code_${officerCode.replace(/^emp-/, '')}_${sheetMonthKey}`)) : null) ||
      (officerLogin ? travelMap.get(`login_${officerLogin}_${sheetMonthKey}`) : null) ||
      travelMap.get(officerUid);
    
    let route = '-', openingKm = 0, closingKm = 0, dailyExpense = 0, recordedKm = 0;
    if (travelData && travelData.rows && Array.isArray(travelData.rows)) {
      // Find row for selectedDate:
      // Primary: exact date match (e.g. "2026-10-24")
      let dayRow = travelData.rows.find((r: any) => r.date === selectedDate);
      
      // Secondary: dayNumber match (e.g. 24)
      if (!dayRow) {
        dayRow = travelData.rows.find((r: any) => Number(r.dayNumber) === dayOfMonth);
      }
      
      if (dayRow) {
        const rawRoute = (dayRow.route || '').trim();
        route = rawRoute.length > 0 ? rawRoute : '-';
        openingKm = Number(dayRow.openingKm) || 0;
        closingKm = Number(dayRow.closingKm) || 0;
        recordedKm = Number(dayRow.km) || 0;
        dailyExpense = (Number(dayRow.amount) || 0) + (Number(dayRow.otherExpenses) || 0);
      }
    }

    const paymentCollection = collDocs
      .filter((d: any) => {
        return (
          d.collectedByUid === officer.uid ||
          d.userId === officer.uid ||
          d.dealerOfficerId === officer.uid ||
          (d.loginId && officer.loginId && String(d.loginId).toLowerCase() === officer.loginId.toLowerCase())
        );
      })
      .reduce((acc: number, d: any) => acc + (Number(d.amount) || 0), 0);

    let monthlySalesTarget = 0, monthlyAchievement = 0;
    const targetSheetId = `yearly_${officer.uid}_2026_27`;
    const targetData = yearlyTargetMap.get(targetSheetId) || yearlyTargetMap.get(officer.uid);
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

    const calculatedKm = (closingKm >= openingKm && openingKm > 0) ? (closingKm - openingKm) : recordedKm;

    return {
      srNo: i + 1,
      uid: officer.uid,
      name: officer.fullName || 'Officer',
      route,
      openingKm,
      closingKm,
      totalKm: calculatedKm,
      paymentCollection,
      dailyExpense,
      monthlySalesTarget,
      monthlyAchievement,
      targetBacklog: Math.max(0, subtractDecimal2(monthlySalesTarget, monthlyAchievement)),
    };
  });
}

// Background prefetch function called from Dashboard to warm cache ahead of time
// ... removed preloadReportData as it's redundant with optimized listeners

export const ReportView: React.FC<Props> = ({ profile }) => {
  const { users: allUsersFromContext, loading: usersLoading } = useUsers();
  const todayDate = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(todayDate);
  
  // Instant Initial State: Read immediately from localStorage (0ms latency!)
  const [reportData, setReportData] = useState<OfficerDailyReport[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const cachedDaily = localStorage.getItem(`${LOCAL_STORAGE_DAILY_PREFIX}${todayDate}`);
        if (cachedDaily) {
          const parsed = JSON.parse(cachedDaily);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        }
      } catch (e) {}
    }
    return [];
  });

  const [loading, setLoading] = useState(() => reportData.length === 0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // References to hold live data components
  const liveUsersRef = useRef<UserProfile[]>([]);
  const liveTravelRef = useRef<any[]>([]);
  const liveTargetsRef = useRef<any[]>([]);
  const liveCollRef = useRef<any[]>([]);

  // Function to re-aggregate live report rows from current in-memory snapshots
  const updateReport = (targetDate: string) => {
    const freshRows = buildReportRows(
      liveUsersRef.current,
      liveTravelRef.current,
      liveTargetsRef.current,
      [],
      liveCollRef.current,
      targetDate,
      profile
    );
    setReportData(freshRows);
    try {
      localStorage.setItem(`${LOCAL_STORAGE_DAILY_PREFIX}${targetDate}`, JSON.stringify(freshRows));
    } catch (e) {}
  };

  // Track connection status and quota errors
  const [syncStatus, setSyncStatus] = useState<'online' | 'offline' | 'quota_hit'>('online');

  // Real-time synchronization across Admin and Users for the selected date and month
  useEffect(() => {
    let active = true;
    const { year, targetMonthName } = parseDateKeys(selectedDate);
    const monthKey = `${year}_${targetMonthName}`;

    // Month-level subscription: only resubscribe if year or month changes
    const unsubMonth = onSnapshot(
      query(
        collection(db, 'travel_sheets'),
        where('monthName', '==', targetMonthName),
        where('yearNumber', '==', year)
      ),
      (snap) => {
        if (!active) return;
        const list: any[] = [];
        snap.forEach((d) => {
          list.push({ ...d.data(), id: d.id, _id: d.id });
        });
        liveTravelRef.current = list;
        updateReport(selectedDate);
        setLoading(false);
        setIsRefreshing(false);
        setSyncStatus('online');
      },
      (err: any) => {
        console.warn('Travel sheets listener error:', err);
        if (active) {
          if (err.code === 'resource-exhausted') setSyncStatus('quota_hit');
          else setSyncStatus('offline');
          setLoading(false);
          setIsRefreshing(false);
        }
      }
    );

    // Initial load for static-ish data (Users, Targets)
    const loadStaticData = async () => {
      try {
        const [targetsSnap] = await Promise.all([
          getDocs(collection(db, 'yearly_targets'))
        ]);
        
        if (!active) return;
        
        liveUsersRef.current = allUsersFromContext;

        const targetsList: any[] = [];
        targetsSnap.forEach((d) => {
          targetsList.push({ ...d.data(), id: d.id, _id: d.id });
        });
        liveTargetsRef.current = targetsList;
        
        updateReport(selectedDate);
      } catch (err: any) {
        console.warn('Error loading static report data:', err);
        if (err.code === 'resource-exhausted') setSyncStatus('quota_hit');
      }
    };

    loadStaticData();

    return () => {
      active = false;
      unsubMonth();
    };
  }, [selectedDate.split('-').slice(0, 2).join('-'), profile.uid]); // Depends only on YYYY-MM

  // Date-level subscription: resubscribe on every date change
  useEffect(() => {
    let active = true;
    setIsRefreshing(true);

    const unsubColl = onSnapshot(
      query(
        collection(db, 'collection_entries'),
        where('date', '==', selectedDate)
      ),
      (snap) => {
        if (!active) return;
        const list: any[] = [];
        snap.forEach((d) => {
          list.push({ ...d.data(), id: d.id });
        });
        liveCollRef.current = list;
        updateReport(selectedDate);
        setIsRefreshing(false);
      },
      (err: any) => {
        console.warn('Collection entries listener error:', err);
        if (active) {
          setIsRefreshing(false);
        }
      }
    );

    return () => {
      active = false;
      unsubColl();
    };
  }, [selectedDate]);

  const handleManualRefresh = () => {
    setIsRefreshing(true);
    updateReport(selectedDate);
    setTimeout(() => setIsRefreshing(false), 500);
  };

  const totalKmSum = reportData.reduce((acc, r) => acc + r.totalKm, 0);
  const totalCollectionSum = reportData.reduce((acc, r) => acc + r.paymentCollection, 0);
  const totalExpenseSum = reportData.reduce((acc, r) => acc + r.dailyExpense, 0);
  const totalTargetSum = addDecimal2(...reportData.map(r => r.monthlySalesTarget));
  const totalAchieveSum = addDecimal2(...reportData.map(r => r.monthlyAchievement));
  const totalBacklogSum = addDecimal2(...reportData.map(r => r.targetBacklog));

  return (
    <div className="space-y-4 w-full pb-20">
      {/* Header Bar: Report Title with Date Option right in front of it */}
      <div className="bg-white p-3 sm:p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-600 shrink-0" />
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Report</h2>
          </div>

          {/* Date Option right in front of Report */}
          <div className="relative">
            <Calendar className="w-4 h-4 absolute left-3 top-2.5 text-slate-400 pointer-events-none" />
            <input 
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="pl-9 pr-3 py-1.5 sm:py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
            />
          </div>

          <button 
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 sm:py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-xl text-xs font-bold transition disabled:opacity-50 shrink-0 cursor-pointer active:scale-95"
            title="Refresh Data"
          >
            {isRefreshing ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="hidden sm:inline">Syncing...</span>
              </>
            ) : (
              <>
                <RefreshCw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Refresh</span>
              </>
            )}
          </button>
        </div>

        {/* Live fast status indicator */}
        <div className="flex items-center gap-2">
          {syncStatus === 'quota_hit' ? (
            <span className="flex items-center gap-1 text-[11px] font-bold text-red-700 bg-red-50 px-2.5 py-1 rounded-full border border-red-200">
              <AlertCircle className="w-3 h-3 text-red-600" />
              <span>Quota Exceeded</span>
            </span>
          ) : syncStatus === 'offline' ? (
            <span className="flex items-center gap-1 text-[11px] font-bold text-amber-700 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-200">
              <RefreshCw className="w-3 h-3 text-amber-600 animate-spin" />
              <span>Offline/Connecting...</span>
            </span>
          ) : isRefreshing ? (
            <span className="flex items-center gap-1 text-[11px] font-bold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-200">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Updating live...</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
              <CheckCircle2 className="w-3 h-3 text-emerald-600" />
              <span>Live Synced</span>
            </span>
          )}
        </div>
      </div>

      {/* Sheet Table (Only English, Clean & Professional, Smooth Horizontal Scroll) */}
      <div 
        className="bg-white rounded-2xl border border-slate-300 shadow-xs overflow-x-auto w-full scroll-smooth"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        <div className="p-3 sm:p-5 bg-white min-w-[880px] w-full">
          {/* Internal Sheet Header */}
          <div className="text-center mb-4 space-y-1">
            <h1 className="text-lg sm:text-xl font-black text-slate-900 uppercase tracking-tight">
              {isAdmin(profile) ? 'ALL OFFICER DAILY TRACK REPORT' : `DAILY TRACK REPORT - ${profile.fullName || 'OFFICER'}`}
            </h1>
            <div className="flex items-center justify-center gap-6 text-xs font-bold text-slate-600">
              <span className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-indigo-600" />
                <span>Date: {new Date(selectedDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <TableIcon className="w-3.5 h-3.5 text-emerald-600" />
                <span>Sheet: Daily Summary</span>
              </span>
            </div>
          </div>

          <table className="w-full border-collapse border border-slate-900 text-xs">
            <thead>
              <tr className="bg-slate-900 text-white font-black uppercase text-center text-xs">
                <th className="p-2 border border-slate-700 w-10 text-center">
                  Sr.
                </th>
                <th className="p-2 border border-slate-700 text-left min-w-[140px]">
                  Officer Name
                </th>
                <th className="p-2 border border-slate-700 text-left min-w-[140px] max-w-[220px]">
                  Today's Route
                </th>
                <th className="p-2 border border-slate-700 min-w-[65px]">
                  Open KM
                </th>
                <th className="p-2 border border-slate-700 min-w-[65px]">
                  Close KM
                </th>
                <th className="p-2 border border-slate-700 min-w-[65px] bg-indigo-950 text-indigo-200">
                  Total KM
                </th>
                <th className="p-2 border border-slate-700 min-w-[95px] bg-emerald-950 text-emerald-200">
                  Collection (₹)
                </th>
                <th className="p-2 border border-slate-700 min-w-[85px] bg-rose-950 text-rose-200">
                  Daily Expense (₹)
                </th>
                <th className="p-2 border border-slate-700 min-w-[80px]">
                  Target (Lakh)
                </th>
                <th className="p-2 border border-slate-700 min-w-[80px] bg-blue-950 text-blue-200">
                  Achieve (Lakh)
                </th>
                <th className="p-2 border border-slate-700 min-w-[80px] bg-red-950 text-red-200">
                  Backlog (Lakh)
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-300 border-b border-slate-900">
              {reportData.map((row) => (
                <tr key={row.uid} className="hover:bg-slate-50 font-bold text-slate-900 text-center uppercase tracking-tight transition-colors">
                  <td className="p-2 border border-slate-300 font-mono font-black bg-slate-50/50">
                    {row.srNo}
                  </td>
                  <td className="p-2 border border-slate-300 text-left font-black text-slate-900 break-words max-w-[170px]">
                    {row.name}
                  </td>
                  <td className="p-2 border border-slate-300 text-slate-800 font-bold text-left break-words max-w-[220px] text-[11px] leading-tight">
                    {row.route}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-bold">
                    {row.openingKm}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-bold">
                    {row.closingKm}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-indigo-700 bg-indigo-50/40">
                    {row.totalKm}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-emerald-700 bg-emerald-50/40">
                    ₹{row.paymentCollection.toLocaleString()}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-rose-700 bg-rose-50/40">
                    ₹{row.dailyExpense.toLocaleString()}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-bold">
                    {formatAmount(row.monthlySalesTarget)}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-blue-700 bg-blue-50/40">
                    {formatAmount(row.monthlyAchievement)}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-red-600 bg-red-50/40">
                    {formatAmount(row.targetBacklog)}
                  </td>
                </tr>
              ))}

              {/* Skeleton placeholder ONLY if completely empty and loading first time */}
              {reportData.length === 0 && loading && (
                <>
                  {[1, 2, 3].map((idx) => (
                    <tr key={`skeleton-${idx}`} className="animate-pulse">
                      <td className="p-3 border border-slate-200 text-center"><div className="h-4 bg-slate-200 rounded w-5 mx-auto"></div></td>
                      <td className="p-3 border border-slate-200"><div className="h-4 bg-slate-200 rounded w-28"></div></td>
                      <td className="p-3 border border-slate-200"><div className="h-4 bg-slate-200 rounded w-36"></div></td>
                      <td className="p-3 border border-slate-200"><div className="h-4 bg-slate-200 rounded w-12 mx-auto"></div></td>
                      <td className="p-3 border border-slate-200"><div className="h-4 bg-slate-200 rounded w-12 mx-auto"></div></td>
                      <td className="p-3 border border-slate-200 bg-indigo-50/30"><div className="h-4 bg-indigo-200 rounded w-12 mx-auto"></div></td>
                      <td className="p-3 border border-slate-200 bg-emerald-50/30"><div className="h-4 bg-emerald-200 rounded w-16 mx-auto"></div></td>
                      <td className="p-3 border border-slate-200 bg-rose-50/30"><div className="h-4 bg-rose-200 rounded w-16 mx-auto"></div></td>
                      <td className="p-3 border border-slate-200"><div className="h-4 bg-slate-200 rounded w-12 mx-auto"></div></td>
                      <td className="p-3 border border-slate-200 bg-blue-50/30"><div className="h-4 bg-blue-200 rounded w-12 mx-auto"></div></td>
                      <td className="p-3 border border-slate-200 bg-red-50/30"><div className="h-4 bg-red-200 rounded w-12 mx-auto"></div></td>
                    </tr>
                  ))}
                </>
              )}

              {reportData.length === 0 && !loading && (
                <tr>
                  <td colSpan={11} className="p-8 text-center text-slate-400 font-bold uppercase italic text-xs">
                    No data available for the selected date.
                  </td>
                </tr>
              )}
            </tbody>
            {reportData.length > 0 && (
              <tfoot className="bg-slate-100 font-black text-slate-900 uppercase text-center border-t-2 border-slate-900 text-xs">
                <tr>
                  <td colSpan={3} className="p-2 text-left font-black border-r border-slate-400">
                    TOTAL SUMMARY
                  </td>
                  <td className="p-2 border-r border-slate-300 text-slate-400">-</td>
                  <td className="p-2 border-r border-slate-300 text-slate-400">-</td>
                  <td className="p-2 border-r border-slate-300 font-mono font-black text-indigo-700 bg-indigo-100/60">
                    {totalKmSum}
                  </td>
                  <td className="p-2 border-r border-slate-300 font-mono font-black text-emerald-700 bg-emerald-100/60">
                    ₹{totalCollectionSum.toLocaleString()}
                  </td>
                  <td className="p-2 border-r border-slate-300 font-mono font-black text-rose-700 bg-rose-100/60">
                    ₹{totalExpenseSum.toLocaleString()}
                  </td>
                  <td className="p-2 border-r border-slate-300 font-mono font-bold">
                    {formatAmount(totalTargetSum)}
                  </td>
                  <td className="p-2 border-r border-slate-300 font-mono font-black text-blue-700 bg-blue-100/60">
                    {formatAmount(totalAchieveSum)}
                  </td>
                  <td className="p-2 font-mono font-black text-red-600 bg-red-100/60">
                    {formatAmount(totalBacklogSum)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>

          <div className="mt-8 flex justify-between items-end">
            <div className="text-center w-36 sm:w-44">
              <div className="h-7 border-b-2 border-slate-400 mb-1"></div>
              <p className="text-[10px] sm:text-[11px] font-black uppercase text-slate-500">Admin Signature</p>
            </div>
            <div className="text-center w-36 sm:w-44">
              <div className="h-7 border-b-2 border-slate-400 mb-1"></div>
              <p className="text-[10px] sm:text-[11px] font-black uppercase text-slate-500">Owner Signature</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
