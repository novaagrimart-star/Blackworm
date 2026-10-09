import React, { useState, useEffect, useRef } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  doc, 
  setDoc
} from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile, isAdmin } from '../../lib/auth';
import { logAudit } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { 
  Navigation,
  ChevronDown,
  User as UserIcon,
  Save,
  CheckCircle2,
  Printer,
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

export const TravelView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const userIsAdmin = isAdmin(profile);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>(userIsAdmin ? (profile.role === 'owner' ? '' : profile.uid) : profile.uid);
  
  // Current date by default
  const today = new Date();
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    return today.toISOString().slice(0, 10);
  });

  // For non-admin, strictly lock selectedUserId to logged-in user's uid
  useEffect(() => {
    if (!userIsAdmin) {
      setSelectedUserId(profile.uid);
    }
  }, [userIsAdmin, profile.uid]);

  // Effect to select first user if owner/admin is logged in and no user selected
  useEffect(() => {
    if (userIsAdmin && !selectedUserId && users.length > 0) {
      setSelectedUserId(users[0].uid);
    }
  }, [userIsAdmin, selectedUserId, users]);

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

  const [sheet, setSheet] = useState<TravelSheetData | null>(null);
  const [ratePerKm, setRatePerKm] = useState<number>(3.5);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

  // Branding
  const [logoUrl, setLogoUrl] = useState<string>('');
  const [logoSize, setLogoSize] = useState<number>(80);
  const [selectedUserPhoto, setSelectedUserPhoto] = useState<string>('');

  const printableSheetRef = useRef<HTMLDivElement>(null);
  const suppressedCommaMap = useRef<Record<number, boolean>>({});

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
        const newVal = (textBefore + ', ' + textAfter).toUpperCase();
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

  // Branding listener
  useEffect(() => {
    const unsubBranding = onSnapshot(doc(db, 'config', 'branding'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setLogoUrl(data.logoUrl || '');
        setLogoSize(data.logoSize || 80);
      }
    });
    return () => unsubBranding();
  }, []);

  // Fetch users for dropdown (Excluding 'owner' role)
  useEffect(() => {
    const q = query(collection(db, 'users'));
    const unsub = onSnapshot(q, (snap) => {
      const list: UserProfile[] = [];
      snap.forEach(d => {
        const userData = d.data() as UserProfile;
        if (userData.role !== 'owner') {
          list.push({ ...userData });
        }
      });
      list.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
      setUsers(list);
    });
    return () => unsub();
  }, []);

  // Generate rows for all days in month strictly (28, 29, 30, or 31 days)
  const generateMonthRows = (
    year: number, 
    monthIdx: number, 
    rate: number = 3.5,
    existingRows: TravelRow[] = []
  ): TravelRow[] => {
    // Exact days in this month: 28 for Feb (non-leap), 29 for Feb (leap), 30 for 30-day months, 31 for 31-day months
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
        // Manual amount strictly preserved from user input, not auto-calculated
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
          subtotal
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

  // Fetch or initialize sheet
  useEffect(() => {
    setLoading(true);
    const sheetMonthKey = `${selectedYearNumber}_${(selectedMonthIndex + 1).toString().padStart(2, '0')}`;
    const sheetId = `travel_${selectedUserId}_${sheetMonthKey}`;
    
    const unsub = onSnapshot(doc(db, 'travel_sheets', sheetId), (docSnap) => {
      const selectedUser = users.find(u => u.uid === selectedUserId) || profile;
      const currentRate = 3.5;

      if (docSnap.exists()) {
        const data = docSnap.data() as TravelSheetData;
        const rRate = data.ratePerKm || currentRate;
        setRatePerKm(rRate);
        const fullRows = generateMonthRows(
          selectedYearNumber, 
          selectedMonthIndex, 
          rRate, 
          data.rows || []
        );

        const totalKm = fullRows.reduce((acc, r) => acc + (r.km || 0), 0);
        const totalAmount = fullRows.reduce((acc, r) => acc + (r.amount || 0), 0);
        const totalOtherExpenses = fullRows.reduce((acc, r) => acc + (r.otherExpenses || 0), 0);
        const subtotalAmount = Math.round((totalAmount + totalOtherExpenses) * 100) / 100;
        const totalExpensesAmount = subtotalAmount;
        const averageCostPerKm = totalKm > 0 ? Math.round((totalExpensesAmount / totalKm) * 100) / 100 : 0;

        setSheet({
          ...data,
          officerName: data.officerName || selectedUser.fullName || selectedUser.uid,
          designation: data.designation || selectedUser.designation || 'FIELD OFFICER',
          date: selectedDate,
          monthName: selectedMonthName,
          yearNumber: selectedYearNumber,
          ratePerKm: rRate,
          rows: fullRows,
          totalKm,
          totalAmount,
          totalOtherExpenses,
          subtotalAmount,
          averageCostPerKm,
          totalExpensesAmount
        });
      } else {
        const fullRows = generateMonthRows(
          selectedYearNumber, 
          selectedMonthIndex, 
          currentRate
        );

        const newSheet: TravelSheetData = {
          id: sheetId,
          userId: selectedUserId,
          officerName: selectedUser.fullName || selectedUser.uid,
          designation: selectedUser.designation || 'FIELD OFFICER',
          date: selectedDate,
          monthName: selectedMonthName,
          yearNumber: selectedYearNumber,
          ratePerKm: currentRate,
          rows: fullRows,
          totalKm: 0,
          totalAmount: 0,
          totalOtherExpenses: 0,
          subtotalAmount: 0,
          averageCostPerKm: 0,
          totalExpensesAmount: 0
        };
        setSheet(newSheet);
      }
      setLoading(false);
    });
    return () => unsub();
  }, [selectedUserId, selectedDate, selectedYearNumber, selectedMonthIndex, users]);

  const updateRow = (index: number, updates: Partial<TravelRow>) => {
    if (!sheet) return;
    const newRows = [...sheet.rows];
    const currentRow = newRows[index];
    const updated = { ...currentRow, ...updates };

    // Auto-calculate KM (Closing KM - Opening KM)
    if ('openingKm' in updates || 'closingKm' in updates) {
      if (updated.closingKm >= updated.openingKm && updated.openingKm > 0) {
        updated.km = updated.closingKm - updated.openingKm;
      } else if (updated.closingKm === 0 && updated.openingKm === 0) {
        updated.km = 0;
      }
    }

    // Manual Amount: strictly set by user input, not auto-calculated from KM
    if ('amount' in updates) {
      updated.amount = updates.amount !== undefined && updates.amount !== null ? Number(updates.amount) || 0 : 0;
    }

    // Auto-calculate Subtotal (Manual Amount + Other Expenses)
    const amount = Number(updated.amount) || 0;
    const other = Number(updated.otherExpenses) || 0;
    updated.subtotal = Math.round((amount + other) * 100) / 100;

    newRows[index] = updated;

    // Recalculate Totals
    const totalKm = newRows.reduce((acc, r) => acc + (r.km || 0), 0);
    const totalAmount = newRows.reduce((acc, r) => acc + (r.amount || 0), 0);
    const totalOtherExpenses = newRows.reduce((acc, r) => acc + (r.otherExpenses || 0), 0);
    const subtotalAmount = Math.round((totalAmount + totalOtherExpenses) * 100) / 100;
    const totalExpensesAmount = subtotalAmount;
    const averageCostPerKm = totalKm > 0 ? Math.round((totalExpensesAmount / totalKm) * 100) / 100 : 0;

    setSheet({
      ...sheet,
      rows: newRows,
      totalKm,
      totalAmount,
      totalOtherExpenses,
      subtotalAmount,
      averageCostPerKm,
      totalExpensesAmount
    });
  };

  const handleRateChange = (newRate: number) => {
    if (!sheet) return;
    setRatePerKm(newRate);
    // Amount is strictly manual per user instruction - never auto-calculate
    setSheet({
      ...sheet,
      ratePerKm: newRate,
    });
  };

  const handleSave = async () => {
    if (!sheet) return;
    setSaving(true);
    try {
      await setDoc(doc(db, 'travel_sheets', sheet.id), {
        ...sheet,
        updatedAt: new Date().toISOString()
      }, { merge: true });

      await logAudit(
        'UPDATE', 
        'travel_sheets', 
        sheet.id, 
        `Saved Travelling Sheet for ${sheet.officerName} (${sheet.monthName} ${sheet.yearNumber})`, 
        profile
      );
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (err) {
      console.error('Save failed:', err);
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
        scale: 2.5,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: 1024,
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.98);
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      
      pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, Math.min(pdfHeight, 297));
      const sanitizedName = (sheet?.officerName ? `Traveling_Sheet_${sheet.officerName}_${sheet.monthName}` : 'Traveling_Sheet').replace(/[^a-zA-Z0-9_-]/g, '_');
      pdf.save(`${sanitizedName}.pdf`);
    } catch (err: any) {
      console.error('PDF download error:', err);
      window.print();
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center p-12">
        <div className="w-8 h-8 border-4 border-red-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!sheet) return null;

  return (
    <div className="space-y-4 font-sans pb-12">
      {/* Top Action Toolbar */}
      <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-md flex flex-col sm:flex-row items-center justify-between gap-3 no-print">
        
        {/* User & Date / Month Selectors */}
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {/* User Selector: Dropdown for Admin, Locked Badge for Non-Admin */}
          {userIsAdmin ? (
            <div className="relative flex-1 sm:w-60">
              <UserIcon className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
              <select 
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="w-full pl-9 pr-8 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-black focus:outline-none focus:ring-2 focus:ring-red-500 appearance-none uppercase"
              >
                {users.map(u => (
                  <option key={u.uid} value={u.uid}>{u.fullName || u.uid} ({u.role})</option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 absolute right-3 top-3 text-slate-400 pointer-events-none" />
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 bg-slate-100 border border-slate-200 rounded-xl text-xs font-black uppercase text-slate-800">
              <UserIcon className="w-4 h-4 text-slate-500" />
              <span>{profile.fullName || 'OFFICER'} ({profile.designation || 'OFFICER'})</span>
            </div>
          )}

          {/* Date Picker (Changing this immediately reloads that month's days) */}
          <div className="relative flex items-center gap-1.5 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-xl">
            <Calendar className="w-4 h-4 text-red-600 shrink-0" />
            <input 
              type="date"
              value={selectedDate}
              onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
              className="bg-transparent font-black text-xs text-slate-900 focus:outline-none cursor-pointer"
            />
          </div>
        </div>

        {/* Action Buttons: Save, Download, Print */}
        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <button 
            onClick={handleSave}
            disabled={saving}
            className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-xs font-black transition flex items-center gap-1.5 shadow-sm active:scale-95 disabled:opacity-50"
            title="Save Travelling Sheet"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            <span>Save</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadPdf}
            disabled={isGeneratingPdf}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-xs font-black transition flex items-center gap-1.5 shadow-sm active:scale-95 disabled:opacity-50"
            title="Download PDF"
          >
            {isGeneratingPdf ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span>{isGeneratingPdf ? 'Generating...' : 'Download'}</span>
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="p-2 rounded-xl bg-red-600 hover:bg-red-700 text-white flex items-center shadow-sm transition active:scale-95"
            title="Print Form"
          >
            <Printer className="w-4 h-4" />
          </button>
        </div>
      </div>

      {showSuccess && (
        <div className="bg-emerald-50 border border-emerald-200 p-3 rounded-xl flex items-center justify-between text-emerald-800 text-xs font-bold animate-in fade-in no-print">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>Traveling sheet saved successfully!</span>
          </div>
          <button onClick={() => setShowSuccess(false)} className="text-emerald-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ======================= STRICT OFFICIAL TRAVELLING SHEET FORM ======================= */}
      <div className="bg-white rounded-2xl border-2 border-slate-300 shadow-xl overflow-x-auto print:border-none print:shadow-none print:m-0 print:p-0">
        <div ref={printableSheetRef} className="border-2 border-black bg-white shadow-sm min-w-[850px] sm:min-w-0">
          
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
              MONTHLY TRAVEL EXPENSE STATEMENT - {sheet.monthName.toUpperCase()} {sheet.yearNumber}
            </span>
          </div>

          {/* 3. Header Fields: Officer Name, Designation, Date (Strictly exact options only) */}
          <div className="grid grid-cols-[1.2fr_1fr_0.8fr] divide-x-2 divide-black border-b-2 border-black bg-white text-[11px] font-black">
            
            {/* Officer Name */}
            <div className="flex items-center p-0 min-h-10">
              <span className="font-black text-black shrink-0 px-2 uppercase tracking-tighter">Officer Name -</span>
              <div className="flex-1 border-l-2 border-black h-full flex items-center px-2 min-w-0">
                <input 
                  type="text" 
                  value={sheet.officerName} 
                  onChange={e => setSheet({ ...sheet, officerName: e.target.value.toUpperCase() })} 
                  placeholder="OFFICER NAME"
                  className="w-full bg-transparent font-black text-black uppercase focus:outline-none text-left" 
                />
              </div>
            </div>

            {/* Designation */}
            <div className="flex items-center p-0 min-h-10">
              <span className="font-black text-black shrink-0 px-2 uppercase tracking-tighter whitespace-nowrap">Designation -</span>
              <div className="flex-1 border-l-2 border-black h-full flex items-center px-2 min-w-0">
                <input 
                  type="text" 
                  value={sheet.designation} 
                  onChange={e => setSheet({ ...sheet, designation: e.target.value.toUpperCase() })} 
                  placeholder="DESIGNATION"
                  className="w-full bg-transparent font-black text-black uppercase focus:outline-none text-left" 
                />
              </div>
            </div>

            {/* Date */}
            <div className="flex items-center p-0 min-h-10 bg-slate-50">
              <span className="font-black text-black shrink-0 px-2 uppercase tracking-tighter whitespace-nowrap">Date -</span>
              <div className="flex-1 border-l-2 border-black h-full flex items-center justify-center px-2 min-w-0">
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
                  <th className="p-1.5 border-r-2 border-black w-20 text-center">Date</th>
                  <th className="p-1.5 border-r-2 border-black w-14 text-center">Days</th>
                  <th className="p-1.5 border-r-2 border-black min-w-[170px] text-center">Route</th>
                  <th className="p-1.5 border-r-2 border-black w-20 text-center">Opening KM</th>
                  <th className="p-1.5 border-r-2 border-black w-20 text-center">Closing KM</th>
                  <th className="p-1.5 border-r-2 border-black w-16 text-center">KM</th>
                  <th className="p-1.5 border-r-2 border-black w-20 text-center">Amount</th>
                  <th className="p-1.5 border-r-2 border-black w-24 text-center">Other Expenses</th>
                  <th className="p-1.5 text-center w-24 bg-slate-800">Subtotal</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-black text-black font-black">
                {sheet.rows.map((row, idx) => {
                  const isSunday = row.days === 'Sun';
                  const routeRowCount = Math.max(1, Math.ceil((row.route || '').length / 22));
                  return (
                    <tr 
                      key={row.dayNumber} 
                      className={`transition-colors ${isSunday ? 'bg-rose-50/70 font-black' : 'hover:bg-amber-50/40'}`}
                    >
                      {/* Date */}
                      <td className="p-1 border-r-2 border-black text-center font-black align-middle">
                        <span className="font-mono text-[10px] whitespace-nowrap">
                          {row.date.slice(8, 10)}/{row.date.slice(5, 7)}/{row.date.slice(0, 4)}
                        </span>
                      </td>

                      {/* Days */}
                      <td className="p-1 border-r-2 border-black text-center font-black align-middle">
                        <span className={isSunday ? 'text-red-700' : 'text-slate-800'}>
                          {row.days}
                        </span>
                      </td>

                      {/* Route (Strictly single line, auto comma on space after word unless manually removed) */}
                      <td className="p-1 border-r-2 border-black align-middle">
                        <input 
                          type="text" 
                          value={row.route} 
                          onKeyDown={e => handleRouteKeyDown(idx, e)}
                          onChange={e => updateRow(idx, { route: e.target.value.toUpperCase() })}
                          placeholder={isSunday ? "SUNDAY / OFF" : "ENTER ROUTE"}
                          className="w-full px-1.5 py-0.5 bg-transparent border-none focus:outline-none font-black uppercase text-center text-[10.5px] truncate block leading-tight" 
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
                      <td className="p-1 text-center font-mono font-black text-emerald-800 bg-emerald-50/50 align-middle">
                        ₹ {row.subtotal ? row.subtotal.toFixed(2) : '0.00'}
                      </td>
                    </tr>
                  );
                })}

                {/* Table Total Summary Row */}
                <tr className="bg-slate-900 text-white font-black text-xs uppercase border-t-2 border-black">
                  <td colSpan={3} className="p-2 text-center tracking-tight border-r-2 border-black font-black">
                    TOTAL
                  </td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black">-</td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black">-</td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black">{sheet.totalKm}</td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black">₹ {sheet.totalAmount.toFixed(2)}</td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black">₹ {sheet.totalOtherExpenses.toFixed(2)}</td>
                  <td className="p-2 text-center font-mono font-black bg-red-600 text-white">
                    ₹ {sheet.subtotalAmount.toFixed(2)}
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
              <span className="text-base font-mono text-slate-900 font-black mt-0.5">
                ₹ {sheet.subtotalAmount.toFixed(2)}
              </span>
            </div>

            {/* Total Expenses Amount */}
            <div className="p-3 bg-red-50 flex flex-col items-center justify-center text-center">
              <span className="text-[10px] text-red-700 uppercase tracking-tight">Total Expenses Amount</span>
              <span className="text-lg font-mono text-red-700 font-black mt-0.5">
                ₹ {sheet.totalExpensesAmount.toFixed(2)}
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
