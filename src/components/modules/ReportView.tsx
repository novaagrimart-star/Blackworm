import React, { useState, useEffect, useRef } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../../firebase';
import { Language } from '../../lib/i18n';
import { UserProfile, isAdmin } from '../../lib/auth';
import { toTitleCase } from '../../lib/utils';
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
  Check
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

export function parseDateKeys(dateStr: string) {
  const [yStr, mStr, dStr] = dateStr.split('-');
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
  const userIsAdmin = isAdmin(profile);
  const { dayOfMonth, sheetMonthKey, targetMonthName } = parseDateKeys(selectedDate);

  let officers = userIsAdmin
    ? allUsers.filter((u) => u.role !== 'owner')
    : allUsers.filter((u) => u.uid === profile.uid || (u.loginId && profile.loginId && u.loginId.toLowerCase() === profile.loginId.toLowerCase()));

  if (officers.length === 0) {
    officers = [profile];
  }

  // Build high-performance lookup maps
  const travelMap = new Map<string, any>();
  allTravelSheets.forEach((s) => {
    if (s._id) travelMap.set(s._id, s);
    if (s.id) travelMap.set(s.id, s);
    if (s.userId && s.monthKey) travelMap.set(`${s.userId}_${s.monthKey}`, s);
    if (s.userId) travelMap.set(s.userId, s);
  });

  const yearlyTargetMap = new Map<string, any>();
  allYearlyTargets.forEach((t) => {
    if (t._id) yearlyTargetMap.set(t._id, t);
    if (t.id) yearlyTargetMap.set(t.id, t);
    if (t.userId) yearlyTargetMap.set(t.userId, t);
  });

  const targetFallbackMap = new Map<string, any>();
  allTargets.forEach((t) => {
    if (t.userId) targetFallbackMap.set(t.userId, t);
  });

  return officers.map((officer, i) => {
    const travelSheetId = `travel_${officer.uid}_${sheetMonthKey}`;
    const travelData = travelMap.get(travelSheetId) || travelMap.get(`${officer.uid}_${sheetMonthKey}`) || travelMap.get(officer.uid);
    
    let route = '-', openingKm = 0, closingKm = 0, dailyExpense = 0, recordedKm = 0;
    if (travelData && travelData.rows) {
      const dayRow = travelData.rows.find((r: any) => 
        Number(r.dayNumber) === dayOfMonth || r.date === selectedDate
      );
      if (dayRow) {
        route = (dayRow.route || '').trim() || '-';
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
          (d.loginId && officer.loginId && d.loginId.toLowerCase() === officer.loginId.toLowerCase())
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
      targetBacklog: Math.max(0, subtractDecimal2(monthlySalesTarget, monthlyAchievement)),
    };
  });
}

export const ReportView: React.FC<Props> = ({ profile }) => {
  const todayDate = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(todayDate);
  const printableSheetRef = useRef<HTMLDivElement>(null);

  // In-memory collections state for live reactive updates
  const usersRef = useRef<UserProfile[]>([]);
  const travelRef = useRef<any[]>([]);
  const targetsRef = useRef<any[]>([]);
  const oldTargetsRef = useRef<any[]>([]);
  const collDocsRef = useRef<any[]>([]);

  // Instant Initial State: Read immediately from localStorage or memory cache (0ms latency!)
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
        if (reportStaticCache && reportStaticCache.users.length > 0) {
          return buildReportRows(
            reportStaticCache.users,
            reportStaticCache.travelSheets,
            reportStaticCache.yearlyTargets,
            reportStaticCache.targets,
            [],
            todayDate,
            profile
          );
        }
      } catch (e) {}
    }
    return [];
  });

  const [loading, setLoading] = useState(() => reportData.length === 0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCapturingPhoto, setIsCapturingPhoto] = useState(false);
  const [photoSavedToast, setPhotoSavedToast] = useState(false);

  // Helper to re-compute rows live whenever any collection fires an update
  const recomputeLiveReport = () => {
    const rows = buildReportRows(
      usersRef.current,
      travelRef.current,
      targetsRef.current,
      oldTargetsRef.current,
      collDocsRef.current,
      selectedDate,
      profile
    );
    setReportData(rows);
    setLoading(false);
    try {
      localStorage.setItem(`${LOCAL_STORAGE_DAILY_PREFIX}${selectedDate}`, JSON.stringify(rows));
    } catch (e) {}
  };

  // Real-Time Live Sync Listeners across devices (zero manual refresh required!)
  useEffect(() => {
    const userIsAdmin = isAdmin(profile);

    // 1. Live Users Listener
    const qUsers = query(collection(db, 'users'));
    const unsubUsers = onSnapshot(qUsers, (snap) => {
      usersRef.current = snap.docs.map(d => ({ ...d.data(), uid: d.id } as UserProfile));
      recomputeLiveReport();
    }, (err) => console.warn('Users live sync error:', err));

    // 2. Live Travel Sheets Listener
    const qTravel = userIsAdmin
      ? query(collection(db, 'travel_sheets'))
      : query(collection(db, 'travel_sheets'), where('userId', '==', profile.uid));
    const unsubTravel = onSnapshot(qTravel, (snap) => {
      travelRef.current = snap.docs.map(d => ({ ...d.data(), _id: d.id }));
      recomputeLiveReport();
    }, (err) => console.warn('Travel live sync error:', err));

    // 3. Live Yearly Targets Listener
    const qTargets = userIsAdmin
      ? query(collection(db, 'yearly_targets'))
      : query(collection(db, 'yearly_targets'), where('userId', '==', profile.uid));
    const unsubTargets = onSnapshot(qTargets, (snap) => {
      targetsRef.current = snap.docs.map(d => ({ ...d.data(), _id: d.id }));
      recomputeLiveReport();
    }, (err) => console.warn('Targets live sync error:', err));

    // 4. Live Collection Entries Listener for selectedDate
    const qColl = query(collection(db, 'collection_entries'), where('date', '==', selectedDate));
    const unsubColl = onSnapshot(qColl, (snap) => {
      collDocsRef.current = snap.docs.map(d => d.data());
      recomputeLiveReport();
    }, (err) => console.warn('Collections live sync error:', err));

    return () => {
      unsubUsers();
      unsubTravel();
      unsubTargets();
      unsubColl();
    };
  }, [selectedDate, profile.uid]);

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
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
        setPhotoSavedToast(true);
        setTimeout(() => setPhotoSavedToast(false), 3000);
      }
    } catch (err) {
      console.error('Failed to capture report photo:', err);
    } finally {
      setIsCapturingPhoto(false);
    }
  };

  const totalKmSum = reportData.reduce((acc, r) => acc + r.totalKm, 0);
  const totalCollectionSum = reportData.reduce((acc, r) => acc + r.paymentCollection, 0);
  const totalExpenseSum = reportData.reduce((acc, r) => acc + r.dailyExpense, 0);
  const totalTargetSum = addDecimal2(...reportData.map(r => r.monthlySalesTarget));
  const totalAchieveSum = addDecimal2(...reportData.map(r => r.monthlyAchievement));
  const totalBacklogSum = addDecimal2(...reportData.map(r => r.targetBacklog));

  return (
    <div className="space-y-4 w-full pb-20 font-sans">
      {/* Header Bar: Report Title with Date Option and Actions */}
      <div className="bg-white p-3 sm:p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-3 no-print">
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
                <span>Date: {new Date(selectedDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
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
                    {row.route}
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
                    ₹{row.paymentCollection.toLocaleString()}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-rose-900 bg-rose-50/40">
                    ₹{row.dailyExpense.toLocaleString()}
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

              {reportData.length === 0 && !loading && (
                <tr>
                  <td colSpan={11} className="p-8 text-center text-slate-400 font-bold uppercase italic text-xs">
                    No data available for the selected date.
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
                    ₹{totalCollectionSum.toLocaleString()}
                  </td>
                  <td className="p-2 border-r border-slate-300 font-mono font-black text-rose-900 bg-rose-100/60">
                    ₹{totalExpenseSum.toLocaleString()}
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
