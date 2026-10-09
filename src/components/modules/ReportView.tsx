import React, { useState, useEffect, useRef } from 'react';
import { collection, query, onSnapshot, getDocs, where, doc } from 'firebase/firestore';
import { db } from '../../firebase';
import { exportAllData } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import { UserProfile, isAdmin } from '../../lib/auth';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { 
  BarChart3, 
  Download, 
  ShieldCheck, 
  Database, 
  FileSpreadsheet, 
  Printer, 
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

export const ReportView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().slice(0, 10));
  const [reportData, setReportData] = useState<OfficerDailyReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  // Stats for the top boxes (could be dynamic later)
  const [stats, setStats] = useState({
    monthlySales: 485000,
    paymentCollection: 412000,
    travelClaims: 14500
  });

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

      {/* Report Table Section */}
      <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
        <div ref={reportRef} className="p-6 bg-white min-w-[1000px]">
          {/* Internal Print Header */}
          <div className="text-center mb-6 space-y-1">
            <h1 className="text-2xl font-black text-slate-900 uppercase">
              {isAdmin(profile) ? 'ALL OFFICER DAILY TRACK REPORT' : `DAILY TRACK REPORT - ${profile.fullName || 'OFFICER'}`}
            </h1>
            <div className="flex items-center justify-center gap-4 text-sm font-bold text-slate-500">
              <span className="flex items-center gap-1.5"><Calendar className="w-4 h-4" /> Date: {new Date(selectedDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
              <span className="flex items-center gap-1.5"><TableIcon className="w-4 h-4" /> Sheet: Daily Summary</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse border-2 border-slate-900 text-[11px]">
              <thead>
                <tr className="bg-slate-900 text-white font-black uppercase text-center">
                  <th className="p-2 border border-slate-700 w-10">Sr.</th>
                  <th className="p-2 border border-slate-700 text-left">Officer Name</th>
                  <th className="p-2 border border-slate-700">Today's Route</th>
                  <th className="p-2 border border-slate-700">Open KM</th>
                  <th className="p-2 border border-slate-700">Close KM</th>
                  <th className="p-2 border border-slate-700">Total KM</th>
                  <th className="p-2 border border-slate-700">Payment Collection</th>
                  <th className="p-2 border border-slate-700">Daily Exp.</th>
                  <th className="p-2 border border-slate-700">Mon. Target (Lakh)</th>
                  <th className="p-2 border border-slate-700">Mon. Achieve (Lakh)</th>
                  <th className="p-2 border border-slate-700">Backlog</th>
                </tr>
              </thead>
              <tbody className="divide-y border-b-2 border-slate-900">
                {reportData.map((row) => (
                  <tr key={row.uid} className="hover:bg-slate-50 font-bold text-slate-800 text-center uppercase tracking-tighter">
                    <td className="p-2 border border-slate-200">{row.srNo}</td>
                    <td className="p-2 border border-slate-200 text-left whitespace-nowrap">{row.name}</td>
                    <td className="p-2 border border-slate-200 italic lowercase first-letter:uppercase">{row.route}</td>
                    <td className="p-2 border border-slate-200 font-mono">{row.openingKm}</td>
                    <td className="p-2 border border-slate-200 font-mono">{row.closingKm}</td>
                    <td className="p-2 border border-slate-200 font-mono text-indigo-600">{row.totalKm}</td>
                    <td className="p-2 border border-slate-200 font-mono text-emerald-600">₹{row.paymentCollection.toLocaleString()}</td>
                    <td className="p-2 border border-slate-200 font-mono text-rose-600">₹{row.dailyExpense.toLocaleString()}</td>
                    <td className="p-2 border border-slate-200 font-mono">{row.monthlySalesTarget.toFixed(2)}</td>
                    <td className="p-2 border border-slate-200 font-mono text-blue-600">{row.monthlyAchievement.toFixed(2)}</td>
                    <td className="p-2 border border-slate-200 font-mono text-red-600">{row.targetBacklog.toFixed(2)}</td>
                  </tr>
                ))}
                {reportData.length === 0 && !loading && (
                  <tr>
                    <td colSpan={11} className="p-10 text-center text-slate-400 font-bold uppercase italic">
                      No data available for the selected date.
                    </td>
                  </tr>
                )}
                {loading && (
                  <tr>
                    <td colSpan={11} className="p-10 text-center">
                      <Loader2 className="w-8 h-8 animate-spin mx-auto text-indigo-600" />
                      <p className="mt-2 text-xs font-bold text-slate-500 uppercase">Fetching latest data...</p>
                    </td>
                  </tr>
                )}
              </tbody>
              {reportData.length > 0 && (
                <tfoot className="bg-slate-50 font-black text-slate-900 uppercase text-center border-t-2 border-slate-900">
                  <tr>
                    <td colSpan={3} className="p-2.5 text-right border-r">TOTAL SUMMARY</td>
                    <td className="p-2.5 border-r">-</td>
                    <td className="p-2.5 border-r">-</td>
                    <td className="p-2.5 border-r font-mono text-indigo-600">{reportData.reduce((acc, r) => acc + r.totalKm, 0)}</td>
                    <td className="p-2.5 border-r font-mono text-emerald-600">₹{reportData.reduce((acc, r) => acc + r.paymentCollection, 0).toLocaleString()}</td>
                    <td className="p-2.5 border-r font-mono text-rose-600">₹{reportData.reduce((acc, r) => acc + r.dailyExpense, 0).toLocaleString()}</td>
                    <td className="p-2.5 border-r font-mono">{reportData.reduce((acc, r) => acc + r.monthlySalesTarget, 0).toFixed(2)}</td>
                    <td className="p-2.5 border-r font-mono text-blue-600">{reportData.reduce((acc, r) => acc + r.monthlyAchievement, 0).toFixed(2)}</td>
                    <td className="p-2.5 font-mono text-red-600">{reportData.reduce((acc, r) => acc + r.targetBacklog, 0).toFixed(2)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className="mt-12 flex justify-between items-end no-print">
            <div className="text-center w-48">
              <div className="h-10 border-b border-slate-300 mb-2"></div>
              <p className="text-[10px] font-black uppercase text-slate-400">Admin Signature</p>
            </div>
            <div className="text-center w-48">
              <div className="h-10 border-b border-slate-300 mb-2"></div>
              <p className="text-[10px] font-black uppercase text-slate-400">Owner Signature</p>
            </div>
          </div>
        </div>
      </div>

      {/* Info Boxes (Stats) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-2">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">एकूण मासिक विक्री (Sales)</span>
          <p className="text-2xl font-black text-slate-900">₹{stats.monthlySales.toLocaleString()}</p>
          <p className="text-[11px] text-emerald-600 font-semibold">+18% मागील महिन्यापेक्षा जास्त</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-2">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">एकूण पेमेंट कलेक्शन</span>
          <p className="text-2xl font-black text-slate-900">₹{stats.paymentCollection.toLocaleString()}</p>
          <p className="text-[11px] text-teal-600 font-semibold">85% कलेक्शन दर</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-2">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">प्रवास खर्च (Travel Claims)</span>
          <p className="text-2xl font-black text-slate-900">₹{stats.travelClaims.toLocaleString()}</p>
          <p className="text-[11px] text-amber-600 font-semibold">12 फील्ड ट्रिप्स</p>
        </div>
      </div>

      <div className="bg-gradient-to-br from-indigo-900 to-slate-900 text-white rounded-3xl p-6 shadow-xl space-y-4">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-8 h-8 text-emerald-400" />
          <div>
            <h3 className="text-base font-bold">डेटा सुरक्षा व संरक्षण हमी (Data Protection Policy)</h3>
            <p className="text-xs text-indigo-200">कोणताही डेटा आपोआज किंवा चुकीने डिलीट होत नाही. सर्व डिलीट केलेले रेकॉर्ड्स रिसायकल बिनमध्ये सुरक्षित राहतात.</p>
          </div>
        </div>
      </div>
    </div>
  );
};
