import React, { useState, useEffect, useRef } from 'react';
import { collection, query, getDocs, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { exportAllData } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import { UserProfile, isAdmin } from '../../lib/auth';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { 
  BarChart3, 
  Download, 
  Printer, 
  Calendar,
  Search,
  Loader2,
  Table as TableIcon,
  ChevronLeft,
  ChevronRight
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

export const ReportView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().slice(0, 10));
  const [reportData, setReportData] = useState<OfficerDailyReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);

  const scrollTable = (direction: 'left' | 'right') => {
    if (tableScrollRef.current) {
      const scrollAmount = direction === 'left' ? -350 : 350;
      tableScrollRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  const fetchReportData = async () => {
    setLoading(true);
    try {
      const userIsAdmin = isAdmin(profile);
      // 1. Fetch Users
      const usersSnap = await getDocs(query(collection(db, 'users'), where('role', 'not-in', ['owner', 'admin'])));
      let officers = usersSnap.docs.map(d => d.data() as UserProfile);

      // Data Isolation: If not admin, strictly show ONLY this user's row
      if (!userIsAdmin) {
        officers = officers.filter(o => o.uid === profile.uid || (o.loginId && profile.loginId && o.loginId.toLowerCase() === profile.loginId.toLowerCase()));
        if (officers.length === 0) {
          officers = [profile];
        }
      }

      // Current Month Details for Target retrieval
      const reportDateObj = new Date(selectedDate);
      const year = reportDateObj.getFullYear();
      const monthIndex = reportDateObj.getMonth();
      const monthNames = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];
      const targetMonthName = reportDateObj.toLocaleString('en-US', { month: 'long' });
      
      const dayOfMonth = reportDateObj.getDate();
      const sheetMonthKey = `${year}_${(monthIndex + 1).toString().padStart(2, '0')}`;

      const finalReports = await Promise.all(
        officers.map(async (officer, i) => {
          // 2. Fetch Travel Data for this officer for this date
          // Note: Travel sheets are monthly
          const travelSheetId = `travel_${officer.uid}_${sheetMonthKey}`;
          const travelSnap = await getDocs(query(collection(db, 'travel_sheets'), where('id', '==', travelSheetId)));
          let route = '-', openingKm = 0, closingKm = 0, dailyExpense = 0;
          
          if (!travelSnap.empty) {
            const travelData = travelSnap.docs[0].data();
            const dayRow = (travelData.rows || []).find((r: any) => r.dayNumber === dayOfMonth);
            if (dayRow) {
              route = dayRow.route || '-';
              openingKm = dayRow.openingKm || 0;
              closingKm = dayRow.closingKm || 0;
              dailyExpense = (dayRow.amount || 0) + (dayRow.otherExpenses || 0);
            }
          }

          // 3. Fetch Collection Entries for this officer on this date
          const collSnap = await getDocs(query(
            collection(db, 'collection_entries'), 
            where('collectedByUid', '==', officer.uid),
            where('date', '==', selectedDate)
          ));
          const paymentCollection = collSnap.docs.reduce((acc, d) => acc + (d.data().amount || 0), 0);

          // 4. Fetch Monthly Target & Achievement
          const targetSheetId = `yearly_${officer.uid}_2026_27`; // Assuming fixed financial year for now or dynamic
          const targetSnap = await getDocs(query(collection(db, 'yearly_targets'), where('id', '==', targetSheetId)));
          let monthlySalesTarget = 0, monthlyAchievement = 0;
          
          if (!targetSnap.empty) {
            const targetData = targetSnap.docs[0].data();
            const monthData = (targetData.months || []).find((m: any) => m.month === targetMonthName);
            if (monthData) {
              monthlySalesTarget = monthData.target || 0;
              monthlyAchievement = monthData.achievement || 0;
            }
          }

          return {
            srNo: i + 1,
            uid: officer.uid,
            name: officer.fullName || 'Officer',
            route,
            openingKm,
            closingKm,
            totalKm: closingKm > openingKm ? closingKm - openingKm : 0,
            paymentCollection,
            dailyExpense,
            monthlySalesTarget,
            monthlyAchievement,
            targetBacklog: Math.max(0, monthlySalesTarget - monthlyAchievement)
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

  const handlePrint = async () => {
    if (!reportRef.current) return;
    try {
      setIsGeneratingPdf(true);
      const canvas = await html2canvas(reportRef.current, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      const pdf = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: 'a4'
      });

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      
      pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, Math.min(pdfHeight, 210));
      pdf.save(`Daily_Track_Report_${selectedDate}.pdf`);
    } catch (err) {
      console.error('PDF error:', err);
      window.print();
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-20">
      {/* Header & Backup Section */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-indigo-600" />
            {t.report} & डेटा सेंटर
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">व्यावसायिक प्रगती आणि डेली ऑफिसर ट्रॅकिंग</p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={exportAllData}
            className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2.5 rounded-xl text-xs font-bold transition shadow-sm"
          >
            <Download className="w-4 h-4" />
            <span>डेटा बॅकअप (JSON)</span>
          </button>
        </div>
      </div>

      {/* Main Action Bar for Report */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row items-center justify-between gap-4 no-print">
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="relative flex-1 md:w-48">
            <Calendar className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
            <input 
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full pl-10 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <button 
            onClick={fetchReportData}
            disabled={loading}
            className="p-2.5 bg-indigo-50 text-indigo-600 rounded-xl hover:bg-indigo-100 transition disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
          </button>
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto justify-end">
          <button
            onClick={handlePrint}
            disabled={isGeneratingPdf || loading}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-xl text-xs font-black shadow-lg transition active:scale-95 disabled:opacity-50"
          >
            {isGeneratingPdf ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
            <span>PRINT REPORT</span>
          </button>
        </div>
      </div>

      {/* Report Table Section - Fully scrollable horizontally with larger font */}
      <div className="space-y-2">
        <div className="text-xs font-bold text-slate-500 flex items-center justify-between px-1 no-print">
          <span className="md:hidden">👉 पूर्ण टेबल पाहण्यासाठी डावीकडून उजवीकडे स्क्रोल करा (Swipe/Scroll)</span>
        </div>

        <div className="bg-white rounded-2xl border-2 border-slate-300 shadow-xl overflow-x-auto scrollbar-thin">
          <div ref={reportRef} className="p-4 sm:p-6 bg-white min-w-[1150px]">
            {/* Internal Print Header */}
            <div className="text-center mb-6 space-y-1">
              <h1 className="text-2xl sm:text-3xl font-black text-slate-900 uppercase tracking-tight">
                {isAdmin(profile) ? 'ALL OFFICER DAILY TRACK REPORT' : `DAILY TRACK REPORT - ${profile.fullName || 'OFFICER'}`}
              </h1>
              <div className="flex items-center justify-center gap-6 text-sm font-bold text-slate-600">
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-4 h-4 text-indigo-600" />
                  <span>Date: {new Date(selectedDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <TableIcon className="w-4 h-4 text-emerald-600" />
                  <span>Sheet: Daily Summary</span>
                </span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse border-2 border-slate-900 text-xs sm:text-sm">
                <thead>
                  <tr className="bg-slate-900 text-white font-black uppercase text-center text-xs sm:text-sm">
                    <th className="p-2.5 sm:p-3 border border-slate-700 w-12">Sr.</th>
                    <th className="p-2.5 sm:p-3 border border-slate-700 text-left min-w-[180px]">Officer Name</th>
                    <th className="p-2.5 sm:p-3 border border-slate-700 min-w-[150px]">Today's Route</th>
                    <th className="p-2.5 sm:p-3 border border-slate-700 min-w-[90px]">Open KM</th>
                    <th className="p-2.5 sm:p-3 border border-slate-700 min-w-[90px]">Close KM</th>
                    <th className="p-2.5 sm:p-3 border border-slate-700 min-w-[90px]">Total KM</th>
                    <th className="p-2.5 sm:p-3 border border-slate-700 min-w-[130px]">Payment Collection</th>
                    <th className="p-2.5 sm:p-3 border border-slate-700 min-w-[100px]">Daily Exp.</th>
                    <th className="p-2.5 sm:p-3 border border-slate-700 min-w-[120px]">Mon. Target (Lakh)</th>
                    <th className="p-2.5 sm:p-3 border border-slate-700 min-w-[120px]">Mon. Achieve (Lakh)</th>
                    <th className="p-2.5 sm:p-3 border border-slate-700 min-w-[100px]">Backlog</th>
                  </tr>
                </thead>
                <tbody className="divide-y-2 divide-slate-300 border-b-2 border-slate-900">
                  {reportData.map((row) => (
                    <tr key={row.uid} className="hover:bg-slate-50 font-bold text-slate-900 text-center uppercase tracking-tight">
                      <td className="p-2.5 sm:p-3 border border-slate-300 font-mono font-black">{row.srNo}</td>
                      <td className="p-2.5 sm:p-3 border border-slate-300 text-left whitespace-nowrap font-black text-slate-900">{row.name}</td>
                      <td className="p-2.5 sm:p-3 border border-slate-300 italic lowercase first-letter:uppercase text-slate-800 font-bold">{row.route}</td>
                      <td className="p-2.5 sm:p-3 border border-slate-300 font-mono font-bold">{row.openingKm}</td>
                      <td className="p-2.5 sm:p-3 border border-slate-300 font-mono font-bold">{row.closingKm}</td>
                      <td className="p-2.5 sm:p-3 border border-slate-300 font-mono font-black text-indigo-700">{row.totalKm}</td>
                      <td className="p-2.5 sm:p-3 border border-slate-300 font-mono font-black text-emerald-700">₹{row.paymentCollection.toLocaleString()}</td>
                      <td className="p-2.5 sm:p-3 border border-slate-300 font-mono font-black text-rose-700">₹{row.dailyExpense.toLocaleString()}</td>
                      <td className="p-2.5 sm:p-3 border border-slate-300 font-mono font-bold">{row.monthlySalesTarget.toFixed(2)}</td>
                      <td className="p-2.5 sm:p-3 border border-slate-300 font-mono font-black text-blue-700">{row.monthlyAchievement.toFixed(2)}</td>
                      <td className="p-2.5 sm:p-3 border border-slate-300 font-mono font-black text-red-600">{row.targetBacklog.toFixed(2)}</td>
                    </tr>
                  ))}
                  {reportData.length === 0 && !loading && (
                    <tr>
                      <td colSpan={11} className="p-12 text-center text-slate-400 font-bold uppercase italic text-sm">
                        No data available for the selected date.
                      </td>
                    </tr>
                  )}
                  {loading && (
                    <tr>
                      <td colSpan={11} className="p-12 text-center">
                        <Loader2 className="w-8 h-8 animate-spin mx-auto text-indigo-600" />
                        <p className="mt-2 text-xs font-bold text-slate-500 uppercase">Fetching latest data...</p>
                      </td>
                    </tr>
                  )}
                </tbody>
                {reportData.length > 0 && (
                  <tfoot className="bg-slate-100 font-black text-slate-900 uppercase text-center border-t-2 border-slate-900 text-xs sm:text-sm">
                    <tr>
                      <td colSpan={3} className="p-3 text-right border-r-2 border-slate-900 font-black">TOTAL SUMMARY</td>
                      <td className="p-3 border-r border-slate-300">-</td>
                      <td className="p-3 border-r border-slate-300">-</td>
                      <td className="p-3 border-r border-slate-300 font-mono font-black text-indigo-700">{reportData.reduce((acc, r) => acc + r.totalKm, 0)}</td>
                      <td className="p-3 border-r border-slate-300 font-mono font-black text-emerald-700">₹{reportData.reduce((acc, r) => acc + r.paymentCollection, 0).toLocaleString()}</td>
                      <td className="p-3 border-r border-slate-300 font-mono font-black text-rose-700">₹{reportData.reduce((acc, r) => acc + r.dailyExpense, 0).toLocaleString()}</td>
                      <td className="p-3 border-r border-slate-300 font-mono font-bold">{reportData.reduce((acc, r) => acc + r.monthlySalesTarget, 0).toFixed(2)}</td>
                      <td className="p-3 border-r border-slate-300 font-mono font-black text-blue-700">{reportData.reduce((acc, r) => acc + r.monthlyAchievement, 0).toFixed(2)}</td>
                      <td className="p-3 font-mono font-black text-red-600">{reportData.reduce((acc, r) => acc + r.targetBacklog, 0).toFixed(2)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <div className="mt-12 flex justify-between items-end no-print">
              <div className="text-center w-48">
                <div className="h-10 border-b-2 border-slate-400 mb-2"></div>
                <p className="text-xs font-black uppercase text-slate-500">Admin Signature</p>
              </div>
              <div className="text-center w-48">
                <div className="h-10 border-b-2 border-slate-400 mb-2"></div>
                <p className="text-xs font-black uppercase text-slate-500">Owner Signature</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
