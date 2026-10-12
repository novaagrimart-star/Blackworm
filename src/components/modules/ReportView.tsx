import React, { useState, useEffect } from 'react';
import { collection, query, getDocs, where, doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { Language } from '../../lib/i18n';
import { UserProfile, isAdmin } from '../../lib/auth';
import { 
  BarChart3, 
  Calendar,
  Search,
  Loader2,
  Table as TableIcon
} from 'lucide-react';

interface Props {
  profile: UserProfile;
  lang: Language;
}

interface OfficerDailyReport {
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

export const ReportView: React.FC<Props> = ({ profile }) => {
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().slice(0, 10));
  const [reportData, setReportData] = useState<OfficerDailyReport[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchReportData = async () => {
    setLoading(true);
    try {
      const userIsAdmin = isAdmin(profile);

      // 1. Fetch Users safely
      const usersSnap = await getDocs(query(collection(db, 'users')));
      const allUsers: UserProfile[] = [];
      usersSnap.forEach((d) => {
        allUsers.push({ ...d.data(), uid: d.id } as UserProfile);
      });

      // Filter officers: Admin sees all non-owner staff/officers; standard user sees only themselves
      let officers = userIsAdmin
        ? allUsers.filter((u) => u.role !== 'owner')
        : allUsers.filter((u) => u.uid === profile.uid || (u.loginId && profile.loginId && u.loginId.toLowerCase() === profile.loginId.toLowerCase()));

      if (officers.length === 0) {
        officers = [profile];
      }

      // 2. Safe Date Parsing
      const [yStr, mStr, dStr] = selectedDate.split('-');
      const year = parseInt(yStr, 10);
      const monthIndex = parseInt(mStr, 10) - 1;
      const dayOfMonth = parseInt(dStr, 10);
      const sheetMonthKey = `${year}_${mStr.padStart(2, '0')}`;
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const targetMonthName = monthNames[monthIndex] || 'October';

      // 3. Pre-fetch collections for this specific date
      let collDocs: any[] = [];
      try {
        const collSnap = await getDocs(query(collection(db, 'collection_entries'), where('date', '==', selectedDate)));
        collDocs = collSnap.docs.map(d => d.data());
      } catch (e) {
        console.warn('Collection entries fetch fallback:', e);
      }

      const finalReports = await Promise.all(
        officers.map(async (officer, i) => {
          // A. Fetch Travel Data
          const travelSheetId = `travel_${officer.uid}_${sheetMonthKey}`;
          let route = '-', openingKm = 0, closingKm = 0, dailyExpense = 0, recordedKm = 0;
          try {
            const travelDocSnap = await getDoc(doc(db, 'travel_sheets', travelSheetId));
            let travelData = travelDocSnap.exists() ? travelDocSnap.data() : null;
            if (!travelData) {
              const travelQuerySnap = await getDocs(query(collection(db, 'travel_sheets'), where('userId', '==', officer.uid)));
              const match = travelQuerySnap.docs.find(d => d.id === travelSheetId || d.data().monthKey === sheetMonthKey);
              if (match) travelData = match.data();
            }
            if (travelData) {
              const dayRow = (travelData.rows || []).find((r: any) => 
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
          } catch (e) {
            console.warn('Travel data fetch err:', e);
          }

          // B. Match Collections for this officer
          const paymentCollection = collDocs
            .filter((d: any) => {
              return (
                d.collectedByUid === officer.uid ||
                d.userId === officer.uid ||
                (d.loginId && officer.loginId && d.loginId.toLowerCase() === officer.loginId.toLowerCase())
              );
            })
            .reduce((acc: number, d: any) => acc + (Number(d.amount) || 0), 0);

          // C. Fetch Monthly Target & Achievement
          let monthlySalesTarget = 0, monthlyAchievement = 0;
          try {
            const targetSheetId = `yearly_${officer.uid}_2026_27`;
            const targetDocSnap = await getDoc(doc(db, 'yearly_targets', targetSheetId));
            if (targetDocSnap.exists()) {
              const targetData = targetDocSnap.data();
              const monthData = (targetData.months || []).find((m: any) => (m.month || '').toLowerCase() === targetMonthName.toLowerCase());
              if (monthData) {
                monthlySalesTarget = Number(monthData.target) || 0;
                monthlyAchievement = Number(monthData.achievement) || 0;
              }
            }

            if (monthlySalesTarget === 0) {
              const fallbackTargetSnap = await getDocs(query(collection(db, 'targets'), where('userId', '==', officer.uid)));
              if (!fallbackTargetSnap.empty) {
                const tData = fallbackTargetSnap.docs[0].data();
                monthlySalesTarget = (Number(tData.targetSales) || 0) / 100000;
                monthlyAchievement = (Number(tData.achievedSales) || 0) / 100000;
              }
            }
          } catch (e) {
            console.warn('Target data fetch err:', e);
          }

          const calculatedKm = closingKm > openingKm ? closingKm - openingKm : recordedKm;

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
            targetBacklog: Math.max(0, monthlySalesTarget - monthlyAchievement),
          };
        })
      );

      setReportData(finalReports);
    } catch (err) {
      console.error('Error fetching report data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReportData();
  }, [selectedDate]);

  const totalKmSum = reportData.reduce((acc, r) => acc + r.totalKm, 0);
  const totalCollectionSum = reportData.reduce((acc, r) => acc + r.paymentCollection, 0);
  const totalExpenseSum = reportData.reduce((acc, r) => acc + r.dailyExpense, 0);
  const totalTargetSum = reportData.reduce((acc, r) => acc + r.monthlySalesTarget, 0);
  const totalAchieveSum = reportData.reduce((acc, r) => acc + r.monthlyAchievement, 0);
  const totalBacklogSum = reportData.reduce((acc, r) => acc + r.targetBacklog, 0);

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
            onClick={fetchReportData}
            disabled={loading}
            className="p-2 bg-indigo-50 text-indigo-600 rounded-xl hover:bg-indigo-100 transition disabled:opacity-50 shrink-0 cursor-pointer active:scale-95"
            title="Refresh"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          </button>
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
                <tr key={row.uid} className="hover:bg-slate-50 font-bold text-slate-900 text-center uppercase tracking-tight">
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
                    {row.monthlySalesTarget.toFixed(2)}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-blue-700 bg-blue-50/40">
                    {row.monthlyAchievement.toFixed(2)}
                  </td>
                  <td className="p-2 border border-slate-300 font-mono font-black text-red-600 bg-red-50/40">
                    {row.targetBacklog.toFixed(2)}
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
              {loading && (
                <tr>
                  <td colSpan={11} className="p-8 text-center">
                    <Loader2 className="w-7 h-7 animate-spin mx-auto text-indigo-600" />
                    <p className="mt-2 text-xs font-bold text-slate-500 uppercase">Loading data...</p>
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
                    {totalTargetSum.toFixed(2)}
                  </td>
                  <td className="p-2 border-r border-slate-300 font-mono font-black text-blue-700 bg-blue-100/60">
                    {totalAchieveSum.toFixed(2)}
                  </td>
                  <td className="p-2 font-mono font-black text-red-600 bg-red-100/60">
                    {totalBacklogSum.toFixed(2)}
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
